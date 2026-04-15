// Edge Function: vault-credentials-copy (POST decrypt during active call + audit log)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient, getUser } from '../_shared/supabase.ts';
import { decrypt } from '../_shared/vault.ts';

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const user = await getUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const body = await req.json();
  const { credentialId, callId } = body;

  if (!credentialId || !callId) {
    return new Response(JSON.stringify({ error: 'credentialId and callId are required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const supabase = createServiceClient();

  // Verify the call is active
  const { data: call } = await supabase.from('calls').select('id, customer_id, rep_id, connected_at, ended_at').eq('id', callId).single();
  if (!call) return new Response(JSON.stringify({ error: 'Call not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  if (!call.connected_at || call.ended_at) {
    return new Response(JSON.stringify({ error: 'Credential access is only allowed during an active call' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  if (call.rep_id !== user.id) {
    return new Response(JSON.stringify({ error: 'You are not assigned to this call' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // Fetch the credential
  const { data: credential } = await supabase.from('customer_credentials').select('*').eq('id', credentialId).single();
  if (!credential) return new Response(JSON.stringify({ error: 'Credential not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  if (credential.customer_id !== call.customer_id) {
    return new Response(JSON.stringify({ error: 'Credential does not belong to this customer' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  try {
    // Decode base64 to Uint8Array and decrypt
    const dec = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

    const password = await decrypt(dec(credential.encrypted_password));
    let notes: string | null = null;
    if (credential.encrypted_notes) {
      notes = await decrypt(dec(credential.encrypted_notes));
    }

    // Log the access
    await supabase.from('credential_access_log').insert({
      credential_id: credentialId,
      rep_id: user.id,
      call_id: callId,
      action: 'copy',
    });

    // Update last accessed
    await supabase.from('customer_credentials').update({
      last_accessed_at: new Date().toISOString(),
      last_accessed_by: user.id,
    }).eq('id', credentialId);

    return new Response(JSON.stringify({ password, notes }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('Decryption error:', err);
    return new Response(JSON.stringify({ error: 'Failed to decrypt credential' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});

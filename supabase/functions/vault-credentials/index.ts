// Edge Function: vault-credentials (GET list, POST create encrypted credential)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient, getUser } from '../_shared/supabase.ts';
import { encrypt } from '../_shared/vault.ts';

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const supabase = createServiceClient();
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const customerId = url.searchParams.get('customerId');
    if (!customerId) {
      return new Response(JSON.stringify({ error: 'customerId required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { data, error } = await supabase
      .from('customer_credentials')
      .select('id, customer_id, service_name, username, created_at, updated_at, last_accessed_at')
      .eq('customer_id', customerId)
      .order('service_name');

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(data), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (req.method === 'POST') {
    const body = await req.json();
    const { customerId, serviceName, username, password, notes } = body;

    if (!customerId || !serviceName || !password) {
      return new Response(JSON.stringify({ error: 'customerId, serviceName, and password are required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const encryptedPassword = await encrypt(password);
    const encryptedNotes = notes ? await encrypt(notes) : null;

    // Convert Uint8Array to base64 for storage
    const enc = (arr: Uint8Array) => btoa(String.fromCharCode(...arr));

    const { data, error } = await supabase
      .from('customer_credentials')
      .insert({
        customer_id: customerId,
        service_name: serviceName,
        username: username || null,
        encrypted_password: enc(encryptedPassword),
        encrypted_notes: encryptedNotes ? enc(encryptedNotes) : null,
      })
      .select('id, customer_id, service_name, username, created_at')
      .single();

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(data), { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});

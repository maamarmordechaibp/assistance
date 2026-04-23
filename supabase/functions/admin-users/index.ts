// Edge Function: admin-users (GET, POST, PATCH, DELETE user management)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient, getUser } from '../_shared/supabase.ts';

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getUser(req);
  if (!user || user.app_metadata?.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const service = createServiceClient();
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const { data: { users }, error: authError } = await service.auth.admin.listUsers();
    if (authError) return new Response(JSON.stringify({ error: authError.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const { data: reps } = await service.from('reps').select('*');
    const repMap = new Map((reps || []).map((r: Record<string, unknown>) => [r.id, r]));

    const result = (users || []).map((u) => ({
      id: u.id,
      email: u.email,
      role: u.app_metadata?.role || 'unknown',
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at,
      rep: repMap.get(u.id) || null,
    }));

    return new Response(JSON.stringify({ users: result }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (req.method === 'POST') {
    const body = await req.json();
    const { email, password, fullName, role, phoneExtension, phoneE164, sipUri } = body;

    if (!email || !password || !fullName || !role) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (!['admin', 'rep'].includes(role)) {
      return new Response(JSON.stringify({ error: 'Role must be admin or rep' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (password.length < 6) {
      return new Response(JSON.stringify({ error: 'Password must be at least 6 characters' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (phoneE164 && !/^\+[1-9][0-9]{6,14}$/.test(phoneE164)) {
      return new Response(JSON.stringify({ error: 'phoneE164 must be E.164 format (e.g. +14155551234)' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { data: authData, error: authError } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role },
      user_metadata: { full_name: fullName },
    });

    if (authError) return new Response(JSON.stringify({ error: authError.message }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const userId = authData.user.id;

    if (role === 'rep') {
      const { error: repError } = await service.from('reps').insert({
        id: userId,
        full_name: fullName,
        email,
        phone_extension: phoneExtension || null,
        phone_e164: phoneE164 || null,
        sip_uri: sipUri || null,
        status: 'offline',
      });

      if (repError) {
        await service.auth.admin.deleteUser(userId);
        return new Response(JSON.stringify({ error: repError.message }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    return new Response(JSON.stringify({ id: userId, email, role, fullName }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (req.method === 'PATCH') {
    const body = await req.json();
    const { id, role, fullName, phoneExtension, phoneE164, sipUri, resetPassword } = body;

    if (!id) return new Response(JSON.stringify({ error: 'User ID required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (phoneE164 && !/^\+[1-9][0-9]{6,14}$/.test(phoneE164)) {
      return new Response(JSON.stringify({ error: 'phoneE164 must be E.164 format (e.g. +14155551234)' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const updatePayload: Record<string, unknown> = {};
    if (role) updatePayload.app_metadata = { role };
    if (fullName) updatePayload.user_metadata = { full_name: fullName };
    if (resetPassword) updatePayload.password = resetPassword;

    if (Object.keys(updatePayload).length > 0) {
      const { error } = await service.auth.admin.updateUserById(id, updatePayload);
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const repUpdate: Record<string, unknown> = {};
    if (fullName) repUpdate.full_name = fullName;
    if (phoneExtension !== undefined) repUpdate.phone_extension = phoneExtension || null;
    if (phoneE164 !== undefined) repUpdate.phone_e164 = phoneE164 || null;
    if (sipUri !== undefined) repUpdate.sip_uri = sipUri || null;
    if (Object.keys(repUpdate).length > 0) {
      await service.from('reps').update(repUpdate).eq('id', id);
    }

    return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return new Response(JSON.stringify({ error: 'User ID required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    if (id === user.id) {
      return new Response(JSON.stringify({ error: 'Cannot delete your own account' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    await service.from('reps').delete().eq('id', id);
    const { error } = await service.auth.admin.deleteUser(id);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});

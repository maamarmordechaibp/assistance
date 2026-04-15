// Edge Function: setup (one-time admin creation)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const { email, password, fullName } = await req.json();
  if (!email || !password || !fullName) {
    return new Response(JSON.stringify({ error: 'Email, password, and full name required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  if (password.length < 6) {
    return new Response(JSON.stringify({ error: 'Password must be at least 6 characters' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const service = createServiceClient();
  const { data: { users } } = await service.auth.admin.listUsers();
  const existingAdmin = (users || []).find((u: any) => u.app_metadata?.role === 'admin');

  if (existingAdmin) {
    return new Response(JSON.stringify({ error: 'An admin account already exists. Use the login page.' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const { data, error } = await service.auth.admin.createUser({
    email, password, email_confirm: true,
    app_metadata: { role: 'admin' },
    user_metadata: { full_name: fullName },
  });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ success: true, message: 'Admin account created. You can now sign in.', id: data.user.id, email }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});

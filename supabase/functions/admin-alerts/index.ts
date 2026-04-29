// Edge Function: admin-alerts
// GET     -> list recent alerts (default 50, ?unseen=1 to filter unread)
// POST    -> { id } body marks one alert as seen by the requesting admin
// POST?ack_all=1 -> marks all unseen alerts as seen
// Admin-only.
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient, getUser } from '../_shared/supabase.ts';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  if ((user.app_metadata as { role?: string })?.role !== 'admin') {
    return json({ error: 'Admin only' }, 403);
  }

  const service = createServiceClient();
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const unseenOnly = url.searchParams.get('unseen') === '1';
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
    let q = service
      .from('admin_alerts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (unseenOnly) q = q.is('seen_at', null);
    const { data, error } = await q;
    if (error) return json({ error: error.message }, 500);

    const { count: unseenCount } = await service
      .from('admin_alerts')
      .select('id', { count: 'exact', head: true })
      .is('seen_at', null);

    return json({ alerts: data ?? [], unseen_count: unseenCount ?? 0 });
  }

  if (req.method === 'POST') {
    if (url.searchParams.get('ack_all') === '1') {
      const { error } = await service
        .from('admin_alerts')
        .update({ seen_at: new Date().toISOString(), seen_by: user.id })
        .is('seen_at', null);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    const body = await req.json().catch(() => ({}));
    if (!body?.id) return json({ error: 'id required' }, 400);
    const { error } = await service
      .from('admin_alerts')
      .update({ seen_at: new Date().toISOString(), seen_by: user.id })
      .eq('id', body.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
});

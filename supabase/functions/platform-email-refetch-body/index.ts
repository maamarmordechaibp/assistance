// Edge Function: platform-email-refetch-body
// Admin-only. For platform_emails rows where text_body and html_body are
// both NULL, look up the Resend email_id from raw_payload and fetch the
// full message via Resend's API. Updates the row in place.
//
// Body: { id?: string }   — single row to refetch, or omit to backfill all.
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient, getUser } from '../_shared/supabase.ts';

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const user = await getUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (user.app_metadata?.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Admin only' }), {
      status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) {
    return new Response(JSON.stringify({ error: 'RESEND_API_KEY not configured' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let payload: { id?: string } = {};
  try { payload = await req.json(); } catch { /* allow empty body */ }

  const supabase = createServiceClient();
  let q = supabase
    .from('platform_emails')
    .select('id, raw_payload, provider, text_body, html_body')
    .eq('provider', 'resend')
    .is('text_body', null)
    .is('html_body', null);
  if (payload.id) q = q.eq('id', payload.id);
  const { data: rows, error } = await q.limit(50);
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const results: Array<{ id: string; ok: boolean; reason?: string }> = [];
  for (const row of rows ?? []) {
    const raw = row.raw_payload as Record<string, unknown> | null;
    const data = raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object'
      ? raw.data as Record<string, unknown>
      : null;
    const emailId =
      (data?.email_id as string | undefined) ||
      (data?.id as string | undefined) ||
      (raw?.id as string | undefined) ||
      null;
    if (!emailId) {
      results.push({ id: row.id, ok: false, reason: 'no email_id in raw_payload' });
      continue;
    }
    try {
      const r = await fetch(`https://api.resend.com/emails/${emailId}`, {
        headers: { Authorization: `Bearer ${resendKey}` },
      });
      if (!r.ok) {
        const txt = await r.text();
        results.push({ id: row.id, ok: false, reason: `resend ${r.status}: ${txt.slice(0, 200)}` });
        continue;
      }
      const j = await r.json() as Record<string, unknown>;
      const text = typeof j.text === 'string' ? j.text : null;
      const html = typeof j.html === 'string' ? j.html : null;
      if (!text && !html) {
        results.push({ id: row.id, ok: false, reason: 'resend returned no text or html' });
        continue;
      }
      const snippet = text ? text.replace(/\s+/g, ' ').trim().slice(0, 200) : null;
      const { error: upErr } = await supabase
        .from('platform_emails')
        .update({ text_body: text, html_body: html, snippet })
        .eq('id', row.id);
      if (upErr) {
        results.push({ id: row.id, ok: false, reason: upErr.message });
      } else {
        results.push({ id: row.id, ok: true });
      }
    } catch (err) {
      results.push({ id: row.id, ok: false, reason: String(err).slice(0, 200) });
    }
  }

  return new Response(JSON.stringify({ ok: true, processed: results.length, results }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

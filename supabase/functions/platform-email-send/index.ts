// Edge Function: platform-email-send
// Sends an email FROM one of the platform-level admin mailboxes
// (office@, complaints@, admin@offlinesbrowse.com) via Resend, and logs
// the outbound message in `platform_emails` for the admin inbox.
//
// POST body:
//   {
//     "from_mailbox": "office@offlinesbrowse.com",  // required, must be in PLATFORM_MAILBOXES
//     "to":           "x@y.com" | ["a@b","c@d"],
//     "subject":      "string",
//     "text":         "plain text body" (one of text/html required),
//     "html":         "<p>html body</p>",
//     "cc":           ["..."]?,
//     "reply_to":     "..."?,
//     "in_reply_to":  "..."?
//   }
//
// Auth: admin-only (rep-app JWT with `app_metadata.role === 'admin'`).
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient, getUser } from '../_shared/supabase.ts';

const PLATFORM_MAILBOXES: Record<string, string> = {
  'office@offlinesbrowse.com':     'Offline Office',
  'complaints@offlinesbrowse.com': 'Offline Complaints',
  'admin@offlinesbrowse.com':      'Offline Admin',
};

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

  const body = await req.json().catch(() => ({}));
  const fromMailbox = String(body?.from_mailbox || '').toLowerCase().trim();
  const to = Array.isArray(body?.to) ? body.to.map(String) : (body?.to ? [String(body.to)] : []);
  const subject = body?.subject ?? '';
  const text = body?.text ?? null;
  const html = body?.html ?? null;
  const cc  = Array.isArray(body?.cc) ? body.cc.map(String) : [];
  const replyTo = body?.reply_to ?? null;
  const inReplyTo = body?.in_reply_to ?? null;

  if (!PLATFORM_MAILBOXES[fromMailbox]) {
    return new Response(JSON.stringify({
      error: 'Invalid from_mailbox',
      allowed: Object.keys(PLATFORM_MAILBOXES),
    }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (!to.length || !subject || (!text && !html)) {
    return new Response(JSON.stringify({ error: 'to, subject, and text|html are required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) {
    return new Response(JSON.stringify({ error: 'RESEND_API_KEY not configured' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const fromName = PLATFORM_MAILBOXES[fromMailbox];
  const from = `${fromName} <${fromMailbox}>`;

  // Send via Resend.
  let resendId: string | null = null;
  let resendError: string | null = null;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to,
        cc: cc.length ? cc : undefined,
        reply_to: replyTo || undefined,
        subject,
        text: text || undefined,
        html: html || undefined,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      resendError = `Resend ${r.status}: ${JSON.stringify(data).slice(0, 400)}`;
      console.error('[platform-email-send]', resendError);
    } else {
      resendId = data?.id ?? null;
    }
  } catch (err) {
    resendError = err instanceof Error ? err.message : String(err);
    console.error('[platform-email-send] fetch error:', resendError);
  }

  // Log outbound row regardless of send success.
  const supabase = createServiceClient();
  const { data: row, error: insErr } = await supabase
    .from('platform_emails')
    .insert({
      mailbox: fromMailbox,
      direction: 'outbound',
      from_address: fromMailbox,
      from_name: fromName,
      to_addresses: to,
      cc_addresses: cc,
      reply_to: replyTo,
      subject,
      text_body: text,
      html_body: html,
      snippet: text ? String(text).replace(/\s+/g, ' ').trim().slice(0, 200) : null,
      in_reply_to: inReplyTo,
      provider: 'resend',
      provider_event_id: resendId,
      received_at: new Date().toISOString(),
      raw_payload: { sent_by_admin_id: user.id, resend_error: resendError },
      is_read: true,
    })
    .select('id')
    .maybeSingle();
  if (insErr) console.error('[platform-email-send] log insert error:', insErr);

  if (resendError) {
    return new Response(JSON.stringify({ error: resendError, log_id: row?.id }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: true, resend_id: resendId, log_id: row?.id }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

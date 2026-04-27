// Edge Function: email-send
// Sends an email FROM a customer's assigned mailbox via Resend, and logs
// the outbound message in customer_emails for the rep UI.
//
// POST body:
//   {
//     "customer_id": "uuid",       // required — sender's mailbox is derived
//     "to":          "x@y.com" | ["a@b","c@d"],
//     "subject":     "string",
//     "text":        "plain text body" (one of text/html required),
//     "html":        "<p>html body</p>",
//     "cc":          ["..."]?,
//     "reply_to":    "..."?
//   }
//
// Auth: requires an authenticated rep (admin app uses anon-JWT).
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

  const body = await req.json().catch(() => ({}));
  const customerId = body?.customer_id;
  const to = Array.isArray(body?.to) ? body.to.map(String) : (body?.to ? [String(body.to)] : []);
  const subject = body?.subject ?? '';
  const text = body?.text ?? null;
  const html = body?.html ?? null;
  const cc  = Array.isArray(body?.cc)  ? body.cc.map(String)  : [];
  const replyTo = body?.reply_to ?? null;

  if (!customerId || !to.length || !subject || (!text && !html)) {
    return new Response(JSON.stringify({ error: 'customer_id, to, subject, and text|html are required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) {
    return new Response(JSON.stringify({ error: 'RESEND_API_KEY not configured' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createServiceClient();

  // Resolve sender mailbox from customer.
  const { data: customer } = await supabase
    .from('customers')
    .select('id, full_name, assigned_email')
    .eq('id', customerId)
    .maybeSingle();
  if (!customer?.assigned_email) {
    return new Response(JSON.stringify({ error: 'Customer has no assigned_email' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const fromName = customer.full_name || 'Offline Customer';
  const from = `${fromName} <${customer.assigned_email}>`;

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
      console.error('[email-send]', resendError);
    } else {
      resendId = data?.id ?? null;
    }
  } catch (err) {
    resendError = err instanceof Error ? err.message : String(err);
    console.error('[email-send] fetch error:', resendError);
  }

  // Log outbound row regardless of send success — so the rep UI shows attempts.
  const { data: row, error: insErr } = await supabase
    .from('customer_emails')
    .insert({
      customer_id: customer.id,
      mailbox: customer.assigned_email,
      direction: 'outbound',
      from_address: customer.assigned_email,
      from_name: fromName,
      to_addresses: to,
      cc_addresses: cc,
      reply_to: replyTo,
      subject,
      text_body: text,
      html_body: html,
      snippet: text ? String(text).replace(/\s+/g, ' ').trim().slice(0, 200) : null,
      provider: 'resend',
      provider_event_id: resendId,
      received_at: new Date().toISOString(),
      raw_payload: { sent_by_rep_id: user.id, resend_error: resendError },
    })
    .select('id')
    .maybeSingle();
  if (insErr) console.error('[email-send] log insert error:', insErr);

  if (resendError) {
    return new Response(JSON.stringify({ error: resendError, log_id: row?.id }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: true, resend_id: resendId, log_id: row?.id }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

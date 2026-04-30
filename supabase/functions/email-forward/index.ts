// Edge Function: email-forward
//
// Forwards a stored customer_emails row to that customer's personal_email
// via Resend. Used in two scenarios:
//
//   1) Manual: rep clicks "Forward" on a single email in the inbox UI.
//      POST { email_id }
//
//   2) Automatic: invoked from email-inbound after a new inbound row is
//      stored, when the customer has auto_forward_mode='all' or
//      'allowlist' (with a matching from_address). The caller passes
//      { email_id, automatic: true } and uses the service role token.
//
// Behaviour:
//   • Looks up the email + customer.
//   • Requires customer.personal_email and direction='inbound'.
//   • Skips silently if already forwarded (forwarded_at IS NOT NULL) unless
//     `force: true` is supplied.
//   • Sends from the customer's assigned_email so the customer sees a
//     familiar sender; subject is prefixed "Fwd:".
//   • Updates the source row's forwarded_at / forwarded_to.
//   • Does NOT log a separate outbound row — forwards are already a copy
//     of the original inbound message and would clutter the inbox.
//
// Auth: rep JWT (manual) or service role (automatic).

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient, getUser } from '../_shared/supabase.ts';

interface ForwardBody {
  email_id?: string;
  force?: boolean;
  automatic?: boolean;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildForwardSubject(original: string | null): string {
  const s = (original || '').trim();
  if (/^fwd?:/i.test(s)) return s || '(no subject)';
  return s ? `Fwd: ${s}` : 'Fwd: (no subject)';
}

function buildForwardText(email: {
  from_name: string | null;
  from_address: string | null;
  to_addresses: string[] | null;
  received_at: string;
  subject: string | null;
  text_body: string | null;
  html_body: string | null;
}): string {
  const fromLine = email.from_name
    ? `${email.from_name} <${email.from_address ?? ''}>`
    : email.from_address || '(unknown)';
  const header =
    `---------- Forwarded message ---------\n` +
    `From: ${fromLine}\n` +
    `Date: ${new Date(email.received_at).toUTCString()}\n` +
    `Subject: ${email.subject ?? ''}\n` +
    `To: ${(email.to_addresses ?? []).join(', ')}\n\n`;
  // Prefer plain text; fall back to a stripped html copy.
  const body =
    email.text_body ??
    (email.html_body ? email.html_body.replace(/<[^>]+>/g, '').trim() : '(no body)');
  return header + body;
}

function buildForwardHtml(email: {
  from_name: string | null;
  from_address: string | null;
  to_addresses: string[] | null;
  received_at: string;
  subject: string | null;
  text_body: string | null;
  html_body: string | null;
}): string | null {
  const original = email.html_body;
  if (!original) return null;
  const fromLine = email.from_name
    ? `${escapeHtml(email.from_name)} &lt;${escapeHtml(email.from_address ?? '')}&gt;`
    : escapeHtml(email.from_address ?? '(unknown)');
  const header =
    `<div style="border-left:3px solid #ccc;padding:8px 12px;margin-bottom:12px;color:#555;font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">` +
    `<div><strong>---------- Forwarded message ----------</strong></div>` +
    `<div>From: ${fromLine}</div>` +
    `<div>Date: ${escapeHtml(new Date(email.received_at).toUTCString())}</div>` +
    `<div>Subject: ${escapeHtml(email.subject ?? '')}</div>` +
    `<div>To: ${escapeHtml((email.to_addresses ?? []).join(', '))}</div>` +
    `</div>`;
  return header + original;
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const body = (await req.json().catch(() => ({}))) as ForwardBody;
  const automatic = Boolean(body?.automatic);

  // Manual calls require a rep JWT. Automatic calls run with the service
  // role from email-inbound and pass `automatic: true`.
  if (!automatic) {
    const user = await getUser(req);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  if (!body?.email_id) {
    return new Response(JSON.stringify({ error: 'email_id is required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) {
    return new Response(JSON.stringify({ error: 'RESEND_API_KEY not configured' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createServiceClient();

  const { data: email, error: emailErr } = await supabase
    .from('customer_emails')
    .select(
      'id, customer_id, direction, from_name, from_address, to_addresses, ' +
        'subject, text_body, html_body, received_at, forwarded_at, deleted_at',
    )
    .eq('id', body.email_id)
    .maybeSingle();
  if (emailErr || !email) {
    return new Response(JSON.stringify({ error: emailErr?.message || 'Email not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (email.deleted_at) {
    return new Response(JSON.stringify({ error: 'Email is deleted' }), {
      status: 410,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (email.direction !== 'inbound') {
    return new Response(JSON.stringify({ error: 'Only inbound emails can be forwarded' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (!email.customer_id) {
    return new Response(JSON.stringify({ error: 'Email is not linked to a customer' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (email.forwarded_at && !body.force) {
    return new Response(
      JSON.stringify({ ok: true, skipped: 'already_forwarded', forwarded_at: email.forwarded_at }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  const { data: customer, error: custErr } = await supabase
    .from('customers')
    .select('id, full_name, assigned_email, personal_email')
    .eq('id', email.customer_id)
    .maybeSingle();
  if (custErr || !customer) {
    return new Response(JSON.stringify({ error: custErr?.message || 'Customer not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (!customer.personal_email) {
    return new Response(
      JSON.stringify({ error: 'Customer has no personal_email — cannot forward' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
  if (!customer.assigned_email) {
    return new Response(
      JSON.stringify({ error: 'Customer has no assigned_email — cannot forward' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  const fromName = customer.full_name || 'Offline Assistance';
  const from = `${fromName} <${customer.assigned_email}>`;
  const subject = buildForwardSubject(email.subject);
  const text = buildForwardText(email);
  const html = buildForwardHtml(email);

  let resendId: string | null = null;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [customer.personal_email],
        subject,
        text,
        html: html || undefined,
        reply_to: email.from_address || undefined,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = `Resend ${r.status}: ${JSON.stringify(data).slice(0, 400)}`;
      console.error('[email-forward]', msg);
      return new Response(JSON.stringify({ error: msg }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    resendId = (data as { id?: string })?.id ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[email-forward] fetch error:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const forwardedAt = new Date().toISOString();
  await supabase
    .from('customer_emails')
    .update({
      forwarded_at: forwardedAt,
      forwarded_to: customer.personal_email,
    })
    .eq('id', email.id);

  return new Response(
    JSON.stringify({
      ok: true,
      forwarded_to: customer.personal_email,
      forwarded_at: forwardedAt,
      resend_id: resendId,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});

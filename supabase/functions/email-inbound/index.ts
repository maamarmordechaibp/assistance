// Edge Function: email-inbound
// Receives inbound email webhooks from email providers (Resend, Cloudflare
// Email Routing, Postmark, SendGrid Inbound Parse) addressed to
// `<digits>@offlinesbrowse.com` and stores them against the matching
// customer (by `assigned_email`).
//
// Configure the webhook in your provider:
//   • Resend Inbound: POST https://<project>.supabase.co/functions/v1/email-inbound
//   • Cloudflare Email Routing → Worker → fetch our URL with the parsed payload
//   • Postmark Inbound: same URL, set Webhook to "Inbound Webhook URL"
//
// Auth: this endpoint is public (--no-verify-jwt).
//   • Resend signs every webhook with Svix headers (`svix-id`,
//     `svix-timestamp`, `svix-signature`). Set env var `EMAIL_INBOUND_SECRET`
//     to the `whsec_…` value Resend shows for the webhook and we'll verify
//     the HMAC-SHA256 signature on every request.
//   • Other providers without Svix can still POST a plain `x-webhook-secret`
//     header matching `EMAIL_INBOUND_SECRET` (no `whsec_` prefix) — we accept
//     either auth scheme.
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { ingestEmailAsOrder } from '../_shared/order-ingest.ts';

// ── Svix signature verification ────────────────────────────────
// Mirrors github.com/svix/svix-webhooks (the lib Resend uses on the wire).
// Signed content = `${svix-id}.${svix-timestamp}.${rawBody}`.
// Signature header is space-separated `v1,base64sig` pairs (one per active key).
async function verifySvix(
  secretRaw: string,
  rawBody: string,
  headers: Headers,
): Promise<boolean> {
  const id = headers.get('svix-id') || headers.get('webhook-id');
  const ts = headers.get('svix-timestamp') || headers.get('webhook-timestamp');
  const sigHeader = headers.get('svix-signature') || headers.get('webhook-signature');
  if (!id || !ts || !sigHeader) return false;

  // Reject stale timestamps (>5 min skew) to prevent replay.
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Date.now() / 1000 - tsNum) > 60 * 5) return false;

  const keyB64 = secretRaw.startsWith('whsec_') ? secretRaw.slice(6) : secretRaw;
  let keyBytes: Uint8Array;
  try {
    const bin = atob(keyB64);
    keyBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) keyBytes[i] = bin.charCodeAt(i);
  } catch {
    return false;
  }

  const signedPayload = `${id}.${ts}.${rawBody}`;
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(signedPayload));
  const sigBytes = new Uint8Array(sigBuf);
  let bin = '';
  for (let i = 0; i < sigBytes.length; i++) bin += String.fromCharCode(sigBytes[i]);
  const expected = btoa(bin);

  // sigHeader can list multiple `v1,sig` pairs separated by spaces.
  for (const part of sigHeader.split(' ')) {
    const [, sig] = part.split(',');
    if (sig && sig === expected) return true;
  }
  return false;
}

interface NormalizedEmail {
  mailbox: string;
  from_address: string | null;
  from_name: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  reply_to: string | null;
  subject: string | null;
  text_body: string | null;
  html_body: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  provider: string;
  provider_event_id: string | null;
  received_at: string | null;
}

// ── Small helpers ────────────────────────────────────────────────
function lowerEmail(e: string | null | undefined): string | null {
  if (!e) return null;
  const m = e.match(/<([^>]+)>/);          // "Foo <foo@bar>" → foo@bar
  return (m ? m[1] : e).trim().toLowerCase();
}
function nameFromAddress(e: string | null | undefined): string | null {
  if (!e) return null;
  const m = e.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  return m ? m[1].trim() : null;
}
function asArray(x: unknown): string[] {
  if (Array.isArray(x)) return x.map(String).map(s => lowerEmail(s) || s).filter(Boolean) as string[];
  if (typeof x === 'string') return x.split(',').map(s => lowerEmail(s) || s.trim()).filter(Boolean) as string[];
  return [];
}
function snippetOf(text: string | null): string | null {
  if (!text) return null;
  return text.replace(/\s+/g, ' ').trim().slice(0, 200) || null;
}

// Extract a likely OTP from the subject + body. Looks for runs of 4-10
// digits or alphanumerics that are CLEARLY codes (preceded by "code",
// "verification", "passcode", "otp", or appearing in subject lines).
function detectOtp(subject: string | null, text: string | null): string | null {
  const haystack = `${subject || ''}\n${text || ''}`;
  if (!haystack) return null;

  // Pattern A: "code: 123456" / "verification code 123456" / "your OTP is 123456"
  const labelled = haystack.match(
    /(?:code|otp|passcode|pass\s*code|verification|verify|pin|two[-\s]?factor|2fa|one[-\s]?time)\D{0,30}([0-9]{4,8}|[A-Z0-9]{4,8})/i,
  );
  if (labelled) return labelled[1];

  // Pattern B: standalone 4-8 digit run on its own line — common in OTP emails.
  const standalone = haystack.match(/(?:^|\n)\s*([0-9]{4,8})\s*(?:$|\n)/);
  if (standalone) return standalone[1];

  // Pattern C: a 6-digit run in the subject (Amazon/Google style).
  if (subject) {
    const subj = subject.match(/\b([0-9]{4,8})\b/);
    if (subj) return subj[1];
  }
  return null;
}

// ── Provider parsers ─────────────────────────────────────────────
// Resend Inbound webhook payload (subject to change — see resend.com/docs)
function fromResend(p: Record<string, unknown>): NormalizedEmail | null {
  const data = (p.data && typeof p.data === 'object') ? p.data as Record<string, unknown> : p;
  const to = asArray(data.to);
  if (!to.length) return null;
  const eventId = (p.id || data.email_id || data.id) as string | undefined;
  return {
    mailbox: to[0],
    from_address: lowerEmail(String(data.from || '')),
    from_name: nameFromAddress(String(data.from || '')),
    to_addresses: to,
    cc_addresses: asArray(data.cc),
    reply_to: lowerEmail(String(data.reply_to || data.replyTo || '')),
    subject: typeof data.subject === 'string' ? data.subject : null,
    text_body: typeof data.text === 'string' ? data.text : null,
    html_body: typeof data.html === 'string' ? data.html : null,
    message_id: typeof data.message_id === 'string' ? data.message_id : null,
    in_reply_to: typeof data.in_reply_to === 'string' ? data.in_reply_to : null,
    provider: 'resend',
    provider_event_id: eventId || null,
    received_at: typeof data.created_at === 'string' ? data.created_at : new Date().toISOString(),
  };
}

// Postmark Inbound payload — well-documented and stable.
function fromPostmark(p: Record<string, unknown>): NormalizedEmail | null {
  const to = asArray(p.ToFull || p.To);
  if (!to.length) return null;
  return {
    mailbox: to[0],
    from_address: lowerEmail(String(p.From || '')),
    from_name: typeof p.FromName === 'string' ? p.FromName : nameFromAddress(String(p.From || '')),
    to_addresses: to,
    cc_addresses: asArray(p.CcFull || p.Cc),
    reply_to: lowerEmail(String(p.ReplyTo || '')),
    subject: typeof p.Subject === 'string' ? p.Subject : null,
    text_body: typeof p.TextBody === 'string' ? p.TextBody : null,
    html_body: typeof p.HtmlBody === 'string' ? p.HtmlBody : null,
    message_id: typeof p.MessageID === 'string' ? p.MessageID : null,
    in_reply_to: null,
    provider: 'postmark',
    provider_event_id: typeof p.MessageID === 'string' ? p.MessageID : null,
    received_at: typeof p.Date === 'string' ? p.Date : new Date().toISOString(),
  };
}

// SendGrid Inbound Parse — sends multipart/form-data; we accept its JSON form.
function fromSendgrid(p: Record<string, unknown>): NormalizedEmail | null {
  const to = asArray(p.to);
  if (!to.length) return null;
  return {
    mailbox: to[0],
    from_address: lowerEmail(String(p.from || '')),
    from_name: nameFromAddress(String(p.from || '')),
    to_addresses: to,
    cc_addresses: asArray(p.cc),
    reply_to: null,
    subject: typeof p.subject === 'string' ? p.subject : null,
    text_body: typeof p.text === 'string' ? p.text : null,
    html_body: typeof p.html === 'string' ? p.html : null,
    message_id: null,
    in_reply_to: null,
    provider: 'sendgrid',
    provider_event_id: null,
    received_at: new Date().toISOString(),
  };
}

// Cloudflare Email Routing → Worker that POSTs JSON of the parsed message.
function fromCloudflare(p: Record<string, unknown>): NormalizedEmail | null {
  const to = asArray(p.to);
  if (!to.length) return null;
  return {
    mailbox: to[0],
    from_address: lowerEmail(String(p.from || '')),
    from_name: nameFromAddress(String(p.from || '')),
    to_addresses: to,
    cc_addresses: asArray(p.cc),
    reply_to: lowerEmail(String(p.reply_to || '')),
    subject: typeof p.subject === 'string' ? p.subject : null,
    text_body: typeof p.text === 'string' ? p.text : null,
    html_body: typeof p.html === 'string' ? p.html : null,
    message_id: typeof p.message_id === 'string' ? p.message_id : null,
    in_reply_to: typeof p.in_reply_to === 'string' ? p.in_reply_to : null,
    provider: 'cloudflare',
    provider_event_id: typeof p.message_id === 'string' ? p.message_id : null,
    received_at: new Date().toISOString(),
  };
}

// ── Entry ────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Read body first as text so we can verify Svix signatures byte-for-byte
  // (parsing & re-stringifying would change whitespace and break the HMAC).
  const rawBody = await req.text();
  const ct = req.headers.get('content-type') || '';

  // Auth: prefer Svix verification (Resend), fall back to plain shared-secret
  // header for providers that don't sign.
  const secret = Deno.env.get('EMAIL_INBOUND_SECRET');
  if (secret) {
    const hasSvix = !!(req.headers.get('svix-signature') || req.headers.get('webhook-signature'));
    let ok = false;
    if (hasSvix) {
      ok = await verifySvix(secret, rawBody, req.headers);
      if (!ok) console.warn('[email-inbound] svix signature verification failed');
    } else {
      const got = req.headers.get('x-webhook-secret') || '';
      ok = got === secret || got === (secret.startsWith('whsec_') ? secret.slice(6) : secret);
      if (!ok) console.warn('[email-inbound] shared secret mismatch (no svix headers)');
    }
    if (!ok) return new Response('Forbidden', { status: 403 });
  }

  // Parse body now that auth has passed.
  let raw: Record<string, unknown>;
  if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
    // Re-parse via Request because formData() needs the original body.
    const form = await new Request('http://x/', {
      method: 'POST',
      headers: { 'content-type': ct },
      body: rawBody,
    }).formData().catch(() => null);
    raw = {};
    if (form) form.forEach((v, k) => { (raw as Record<string, unknown>)[k] = typeof v === 'string' ? v : v.name; });
  } else {
    try {
      raw = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      raw = {};
    }
  }

  // Detect provider from payload shape — try each parser; first that returns
  // a value with `mailbox` wins. This makes the endpoint provider-agnostic so
  // callers don't need to set a `?provider=` query param.
  const normalized: NormalizedEmail | null =
    fromResend(raw) || fromPostmark(raw) || fromSendgrid(raw) || fromCloudflare(raw);

  if (!normalized || !normalized.mailbox) {
    console.warn('[email-inbound] could not parse payload — keys:', Object.keys(raw).slice(0, 20));
    return new Response(JSON.stringify({ ok: false, error: 'unrecognised payload' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabase = createServiceClient();

  // Resolve the customer by mailbox.
  let customerId: string | null = null;
  {
    const { data: cust } = await supabase
      .from('customers')
      .select('id')
      .eq('assigned_email', normalized.mailbox)
      .maybeSingle();
    customerId = cust?.id ?? null;
  }

  const detected_otp = detectOtp(normalized.subject, normalized.text_body);
  const snippet = snippetOf(normalized.text_body);

  // Upsert by (provider, provider_event_id) when we have one — otherwise
  // insert. The unique partial index handles the dedupe.
  const insertRow = {
    customer_id: customerId,
    mailbox: normalized.mailbox,
    direction: 'inbound' as const,
    from_address: normalized.from_address,
    from_name: normalized.from_name,
    to_addresses: normalized.to_addresses,
    cc_addresses: normalized.cc_addresses,
    reply_to: normalized.reply_to,
    subject: normalized.subject,
    text_body: normalized.text_body,
    html_body: normalized.html_body,
    snippet,
    detected_otp,
    message_id: normalized.message_id,
    in_reply_to: normalized.in_reply_to,
    provider: normalized.provider,
    provider_event_id: normalized.provider_event_id,
    raw_payload: raw,
    received_at: normalized.received_at,
  };

  let row: { id: string } | null = null;
  if (normalized.provider_event_id) {
    // Manually upsert: check existence first, then update or insert. We avoid
    // PostgREST's `.upsert(..., { onConflict })` because the underlying
    // unique index is *partial* (`WHERE provider_event_id IS NOT NULL`) and
    // PostgREST cannot derive the index predicate — it errors with 42P10.
    const { data: existing } = await supabase
      .from('customer_emails')
      .select('id')
      .eq('provider', normalized.provider)
      .eq('provider_event_id', normalized.provider_event_id)
      .maybeSingle();
    if (existing) {
      const { data, error } = await supabase
        .from('customer_emails')
        .update(insertRow)
        .eq('id', existing.id)
        .select('id')
        .maybeSingle();
      if (error) {
        console.error('[email-inbound] update error:', error);
        return new Response(JSON.stringify({ ok: false, error: error.message }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        });
      }
      row = data;
    } else {
      const { data, error } = await supabase
        .from('customer_emails')
        .insert(insertRow)
        .select('id')
        .maybeSingle();
      if (error) {
        console.error('[email-inbound] insert error:', error);
        return new Response(JSON.stringify({ ok: false, error: error.message }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        });
      }
      row = data;
    }
  } else {
    const { data, error } = await supabase
      .from('customer_emails')
      .insert(insertRow)
      .select('id')
      .maybeSingle();
    if (error) {
      console.error('[email-inbound] insert error:', error);
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }
    row = data;
  }

  console.log(`[email-inbound] stored mailbox=${normalized.mailbox} customer=${customerId ?? 'unmatched'} otp=${detected_otp ?? 'none'} subject="${(normalized.subject || '').slice(0, 80)}"`);

  // Best-effort: classify the email and upsert orders/shipments. Failures
  // here are logged but never block the webhook response — Resend will
  // otherwise replay the delivery.
  let ingestSummary: { matched: boolean; orderId?: string; skipReason?: string } | null = null;
  if (row?.id) {
    try {
      const ingest = await ingestEmailAsOrder(
        supabase,
        {
          id: row.id,
          customer_id: customerId,
          from_address: normalized.from_address,
          subject: normalized.subject,
          text_body: normalized.text_body,
          html_body: normalized.html_body,
          received_at: normalized.received_at,
          raw_payload: raw as Record<string, unknown>,
        },
        { runCarrierRefresh: true },
      );
      ingestSummary = {
        matched: ingest.matched,
        orderId: ingest.orderId,
        skipReason: ingest.skipReason,
      };
      console.log(
        `[email-inbound] ingest matched=${ingest.matched} merchant=${ingest.plan.merchant ?? 'none'} ` +
          `tracking=${ingest.plan.trackings.length} order=${ingest.orderId ?? 'n/a'} skip=${ingest.skipReason ?? 'n/a'}`,
      );
    } catch (err) {
      console.error('[email-inbound] ingest failed:', err instanceof Error ? err.message : err);
    }
  }

  return new Response(JSON.stringify({ ok: true, id: row?.id, customer_id: customerId, otp: detected_otp, ingest: ingestSummary }), {
    headers: { 'Content-Type': 'application/json' },
  });
});

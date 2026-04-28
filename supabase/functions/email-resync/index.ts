// Edge Function: email-resync
// Pulls inbound emails directly from Resend's REST API and upserts them into
// `customer_emails`. Used to recover history when the inbound webhook isn't
// firing (e.g. Resend webhook URL not configured, or signature mismatch).
//
// POST body (all optional):
//   {
//     "limit": 100,        // max rows to fetch from Resend (default 100)
//     "since": "2026-04-20T00:00:00Z"  // ISO timestamp lower bound
//   }
//
// Auth: admin-only (rep app supplies a JWT).
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient, getUser } from '../_shared/supabase.ts';

interface ResendInbound {
  id?: string;
  email_id?: string;
  from?: string;
  to?: string | string[];
  cc?: string | string[];
  reply_to?: string;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  message_id?: string;
  in_reply_to?: string;
  created_at?: string;
  received_at?: string;
}

function lowerEmail(e: string | null | undefined): string | null {
  if (!e) return null;
  const m = e.match(/<([^>]+)>/);
  return (m ? m[1] : e).trim().toLowerCase();
}
function nameFromAddress(e: string | null | undefined): string | null {
  if (!e) return null;
  const m = e.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  return m ? m[1].trim() : null;
}
function asArray(x: unknown): string[] {
  if (Array.isArray(x)) return x.map(String).map((s) => lowerEmail(s) || s).filter(Boolean) as string[];
  if (typeof x === 'string') return x.split(',').map((s) => lowerEmail(s) || s.trim()).filter(Boolean) as string[];
  return [];
}
function snippetOf(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.replace(/\s+/g, ' ').trim().slice(0, 200) || null;
}
function detectOtp(subject: string | null | undefined, text: string | null | undefined): string | null {
  const haystack = `${subject || ''}\n${text || ''}`;
  if (!haystack) return null;
  const labelled = haystack.match(
    /(?:code|otp|passcode|pass\s*code|verification|verify|pin|two[-\s]?factor|2fa|one[-\s]?time)\D{0,30}([0-9]{4,8}|[A-Z0-9]{4,8})/i,
  );
  if (labelled) return labelled[1];
  const standalone = haystack.match(/(?:^|\n)\s*([0-9]{4,8})\s*(?:$|\n)/);
  if (standalone) return standalone[1];
  if (subject) {
    const subj = subject.match(/\b([0-9]{4,8})\b/);
    if (subj) return subj[1];
  }
  return null;
}

// Try a list of candidate Resend endpoints and return the first one that
// responds with a JSON list. Resend's inbound API has been moving — accept
// either current or legacy shapes. Returns { url, items } or throws.
async function fetchInboundFromResend(
  resendKey: string,
  opts: { limit: number; since?: string },
): Promise<{ url: string; items: ResendInbound[] }> {
  const candidates = [
    `https://api.resend.com/inbound/emails?limit=${opts.limit}`,
    `https://api.resend.com/emails/inbound?limit=${opts.limit}`,
    `https://api.resend.com/emails?direction=inbound&limit=${opts.limit}`,
    `https://api.resend.com/emails?type=inbound&limit=${opts.limit}`,
  ];
  const errors: string[] = [];
  for (const url of candidates) {
    try {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${resendKey}`, Accept: 'application/json' },
      });
      const txt = await r.text();
      if (!r.ok) {
        errors.push(`${url} -> ${r.status} ${txt.slice(0, 120)}`);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(txt);
      } catch {
        errors.push(`${url} -> non-JSON response`);
        continue;
      }
      // Resend list payloads are typically `{ data: [...] }` or `{ object: 'list', data: [...] }`.
      const items =
        Array.isArray((parsed as { data?: unknown }).data)
          ? ((parsed as { data: ResendInbound[] }).data)
          : Array.isArray(parsed)
          ? (parsed as ResendInbound[])
          : null;
      if (!items) {
        errors.push(`${url} -> unexpected shape: ${txt.slice(0, 120)}`);
        continue;
      }
      return { url, items };
    } catch (err) {
      errors.push(`${url} -> ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    'Resend inbound API not reachable. Tried:\n' + errors.join('\n'),
  );
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

  const user = await getUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (user.app_metadata?.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Admin only' }), {
      status: 403,
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

  const body = await req.json().catch(() => ({}));
  const limit = Math.min(Math.max(Number(body?.limit) || 100, 1), 500);
  const since = typeof body?.since === 'string' ? body.since : undefined;

  let inbound: { url: string; items: ResendInbound[] };
  try {
    inbound = await fetchInboundFromResend(resendKey, { limit, since });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
        hint:
          'Resend\'s inbound emails REST API may not yet be available on your plan. ' +
          'In that case configure the inbound webhook to POST to ' +
          '`https://<project>.supabase.co/functions/v1/email-inbound` and the ' +
          'function will store messages in real time.',
      }),
      { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  const supabase = createServiceClient();

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const item of inbound.items) {
    try {
      if (since && item.created_at && new Date(item.created_at) < new Date(since)) {
        skipped++;
        continue;
      }
      const to = asArray(item.to);
      const mailbox = to[0];
      if (!mailbox) {
        skipped++;
        continue;
      }
      const eventId = item.id || item.email_id || null;
      const subject = item.subject ?? null;
      const text = item.text ?? null;
      const html = item.html ?? null;

      // Resolve customer by mailbox.
      let customerId: string | null = null;
      const { data: cust } = await supabase
        .from('customers')
        .select('id')
        .eq('assigned_email', mailbox)
        .maybeSingle();
      customerId = cust?.id ?? null;

      const row = {
        customer_id: customerId,
        mailbox,
        direction: 'inbound' as const,
        from_address: lowerEmail(item.from),
        from_name: nameFromAddress(item.from),
        to_addresses: to,
        cc_addresses: asArray(item.cc),
        reply_to: lowerEmail(item.reply_to),
        subject,
        text_body: text,
        html_body: html,
        snippet: snippetOf(text),
        detected_otp: detectOtp(subject, text),
        message_id: item.message_id ?? null,
        in_reply_to: item.in_reply_to ?? null,
        provider: 'resend',
        provider_event_id: eventId,
        raw_payload: item as unknown as Record<string, unknown>,
        received_at: item.received_at || item.created_at || new Date().toISOString(),
      };

      if (eventId) {
        // Upsert by (provider, provider_event_id). Returns row regardless of
        // insert/update — we count by checking if it already existed first.
        const { data: existing } = await supabase
          .from('customer_emails')
          .select('id')
          .eq('provider', 'resend')
          .eq('provider_event_id', eventId)
          .maybeSingle();
        const { error } = await supabase
          .from('customer_emails')
          .upsert(row, { onConflict: 'provider,provider_event_id', ignoreDuplicates: false });
        if (error) {
          errors.push(`${eventId}: ${error.message}`);
          continue;
        }
        if (existing) updated++;
        else inserted++;
      } else {
        const { error } = await supabase.from('customer_emails').insert(row);
        if (error) {
          errors.push(`(no id): ${error.message}`);
          continue;
        }
        inserted++;
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      source_url: inbound.url,
      fetched: inbound.items.length,
      inserted,
      updated,
      skipped,
      errors: errors.slice(0, 10),
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});

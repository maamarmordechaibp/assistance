/**
 * Cloudflare Email Worker — inbound mail receiver for offlinesbrowse.com
 *
 * Bound to a Cloudflare Email Routing rule (e.g. catch-all → this worker).
 * Parses the raw MIME message and POSTs a JSON payload to the Supabase
 * `email-inbound` Edge Function, which already has a `fromCloudflare` parser.
 *
 * Environment bindings (set with `wrangler secret put`):
 *   INBOUND_URL            e.g. https://rrwgjrixvlyuxjijnavx.supabase.co/functions/v1/email-inbound
 *   EMAIL_INBOUND_SECRET   shared secret matching the Supabase function's env var
 */

import PostalMime from 'postal-mime';

export interface Env {
  INBOUND_URL: string;
  EMAIL_INBOUND_SECRET: string;
}

interface ForwardPayload {
  mailbox: string;
  from: string;
  to: string[];
  cc: string[];
  reply_to: string;
  subject: string;
  text: string;
  html: string;
  message_id: string;
  in_reply_to: string;
  headers: Record<string, string>;
  attachments: Array<{
    filename: string;
    mime_type: string;
    size: number;
    content_id: string;
    disposition: string;
  }>;
  received_at: string;
}

export default {
  /**
   * Cloudflare invokes this for every incoming message routed to the Worker.
   * `message.raw` is a ReadableStream of the full RFC822 MIME source.
   */
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const raw = await streamToArrayBuffer(message.raw, message.rawSize);
    const parsed = await PostalMime.parse(raw);

    const headerTo = (parsed.to || []).map((a) => a.address || '').filter(Boolean);
    const ccList = (parsed.cc || []).map((a) => a.address || '').filter(Boolean);
    const fromAddr = parsed.from?.address || message.from || '';

    // Put the actual routed recipient first so the Supabase parser
    // (`fromCloudflare`) derives the correct mailbox even when the message
    // was sent via Bcc or to a list.
    const toList = [message.to, ...headerTo.filter((a) => a.toLowerCase() !== message.to.toLowerCase())];

    const payload: ForwardPayload = {
      mailbox: message.to,
      from: fromAddr,
      to: toList,
      cc: ccList,
      reply_to: parsed.replyTo?.[0]?.address || '',
      subject: parsed.subject || '',
      text: parsed.text || '',
      html: parsed.html || '',
      message_id: parsed.messageId || '',
      in_reply_to: parsed.inReplyTo || '',
      headers: Object.fromEntries(
        (parsed.headers || []).map((h) => [h.key.toLowerCase(), h.value]),
      ),
      attachments: (parsed.attachments || []).map((a) => ({
        filename: a.filename || '',
        mime_type: a.mimeType || '',
        size: typeof a.content === 'string' ? a.content.length : a.content.byteLength,
        content_id: a.contentId || '',
        disposition: a.disposition || '',
      })),
      received_at: new Date().toISOString(),
    };

    const res = await fetch(env.INBOUND_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-secret': env.EMAIL_INBOUND_SECRET,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Reject so Cloudflare retries / surfaces failure in dashboard.
      message.setReject(`Upstream ${res.status}: ${body.slice(0, 200)}`);
      throw new Error(`email-inbound responded ${res.status}: ${body}`);
    }
  },
} satisfies ExportedHandler<Env>;

async function streamToArrayBuffer(stream: ReadableStream<Uint8Array>, size: number): Promise<Uint8Array> {
  const out = new Uint8Array(size);
  let offset = 0;
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, offset);
    offset += value.length;
  }
  return out;
}

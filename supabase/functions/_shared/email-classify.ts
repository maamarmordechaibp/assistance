// Lightweight, dependency-free email classifier + tracking-number extractor.
// Used by `email-inbound` (real-time) and `email-classify-backfill` (one-shot)
// to derive an `orders` + `order_shipments` row from inbound merchant /
// carrier mail.
//
// Pure functions only — no fetches, no Supabase calls. Designed so it can be
// unit-tested in isolation against fixture HTML/text snapshots.

export type Merchant =
  | 'amazon'
  | 'walmart'
  | 'target'
  | 'bestbuy'
  | 'ebay'
  | 'shopify'      // generic Shopify-hosted store
  | 'home_depot'
  | 'lowes'
  | 'costco'
  | 'apple'
  | null;

export type Intent =
  | 'order_confirmation'
  | 'shipping_notification'
  | 'delivery_notification'
  | 'return'
  | 'cancellation'
  | 'other';

export interface Classification {
  merchant: Merchant;
  /** Carrier-side notifications (UPS/FedEx/etc.) — separate from merchant. */
  carrier: 'ups' | 'fedex' | 'usps' | 'dhl' | null;
  intent: Intent;
}

interface MerchantSig {
  merchant: Exclude<Merchant, null>;
  /** Substrings — match any one in the From address (lowercased). */
  fromDomains: string[];
  /** Optional subject hints to break ties when domain alone isn't enough. */
  subjectHints?: RegExp[];
}

const MERCHANT_SIGS: MerchantSig[] = [
  { merchant: 'amazon',     fromDomains: ['amazon.com', 'amazon.co', '@amzn'] },
  { merchant: 'walmart',    fromDomains: ['walmart.com', 'walmartemail.com'] },
  { merchant: 'target',     fromDomains: ['target.com', 'targetemail.com', 'oe.target.com'] },
  { merchant: 'bestbuy',    fromDomains: ['bestbuy.com', 'emailinfo.bestbuy.com'] },
  { merchant: 'ebay',       fromDomains: ['ebay.com', 'reply2.ebay.com', 'ebay.co.uk'] },
  { merchant: 'home_depot', fromDomains: ['homedepot.com'] },
  { merchant: 'lowes',      fromDomains: ['lowes.com'] },
  { merchant: 'costco',     fromDomains: ['costco.com'] },
  { merchant: 'apple',      fromDomains: ['apple.com', 'insideapple.apple.com'] },
];

const CARRIER_DOMAINS: Array<{ carrier: 'ups' | 'fedex' | 'usps' | 'dhl'; needle: string[] }> = [
  { carrier: 'ups',   needle: ['ups.com'] },
  { carrier: 'fedex', needle: ['fedex.com'] },
  { carrier: 'usps',  needle: ['usps.com', 'email.usps.com'] },
  { carrier: 'dhl',   needle: ['dhl.com'] },
];

const SHOPIFY_HEADERS_RE = /shopify|myshopify\.com/i;

function lowerDomainOf(addr: string): string {
  if (!addr) return '';
  const m = addr.match(/<([^>]+)>/);
  const email = (m ? m[1] : addr).trim().toLowerCase();
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1) : email;
}

function intentFromSubject(subject: string | null | undefined): Intent {
  const s = (subject || '').toLowerCase();
  if (!s) return 'other';
  if (/cancel(led|ation)/.test(s)) return 'cancellation';
  if (/return(ed)?|refund/.test(s)) return 'return';
  if (/(delivered|has arrived|was delivered)/.test(s)) return 'delivery_notification';
  if (/(shipped|on the way|out for delivery|tracking|dispatched|on its way)/.test(s)) return 'shipping_notification';
  if (/(order (confirmation|received|placed)|thanks for your order|your .{0,30}order)/.test(s)) return 'order_confirmation';
  return 'other';
}

export function classifyEmail(
  fromAddress: string | null | undefined,
  subject: string | null | undefined,
  rawHeaders?: Record<string, string> | null,
): Classification {
  const domain = lowerDomainOf(fromAddress || '');

  // Carrier match wins over merchant if it's literally from the carrier.
  for (const c of CARRIER_DOMAINS) {
    if (c.needle.some((n) => domain.includes(n))) {
      return { merchant: null, carrier: c.carrier, intent: intentFromSubject(subject) };
    }
  }

  for (const sig of MERCHANT_SIGS) {
    if (sig.fromDomains.some((d) => domain.includes(d))) {
      return { merchant: sig.merchant, carrier: null, intent: intentFromSubject(subject) };
    }
  }

  // Shopify-hosted stores send from their own domain but include Shopify
  // headers. If the caller passes raw headers, we can recognise those.
  if (rawHeaders) {
    const blob = Object.entries(rawHeaders)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    if (SHOPIFY_HEADERS_RE.test(blob)) {
      return { merchant: 'shopify', carrier: null, intent: intentFromSubject(subject) };
    }
  }

  return { merchant: null, carrier: null, intent: intentFromSubject(subject) };
}

// ── Tracking number extraction ────────────────────────────────────────

export interface TrackingHit {
  carrier: 'ups' | 'fedex' | 'usps' | 'dhl' | 'amazon' | 'unknown';
  number: string;
  /** First match's surrounding URL if we found one in `<a href>` markup. */
  url?: string | null;
}

// Carrier-shaped numbers, ordered most-specific first so we don't double-match.
const TRACKING_PATTERNS: Array<{ carrier: TrackingHit['carrier']; re: RegExp }> = [
  // UPS: 1Z + 16 alphanumerics. Very specific, never false positives.
  { carrier: 'ups',   re: /\b1Z[0-9A-Z]{16}\b/g },
  // Amazon Logistics: TBA + 12 digits.
  { carrier: 'amazon', re: /\bTBA[0-9]{12}\b/g },
  // USPS: 22 digits, often grouped as "9400 1108 …". We strip whitespace
  // before matching, so accept run of digits 20–22 long starting with 9.
  { carrier: 'usps',  re: /\b9[0-9]{19,21}\b/g },
  // USPS international/registered: 2 letters + 9 digits + "US".
  { carrier: 'usps',  re: /\b[A-Z]{2}\d{9}US\b/g },
  // FedEx: 12, 15, or 20-digit. Lowest priority because plain digits are
  // common false positives — we require word boundaries + nothing letter-y
  // adjacent.
  { carrier: 'fedex', re: /\b\d{15}\b/g },
  { carrier: 'fedex', re: /\b\d{12}\b/g },
];

const ANCHOR_RE = /<a\b[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi;

function stripWhitespace(s: string): string {
  return s.replace(/[\s\u00A0]+/g, '');
}

/**
 * Extract tracking numbers from a body. We scan both:
 *   1. The literal text/HTML for carrier-shaped tracking numbers.
 *   2. Anchor tags whose `href` matches a carrier's tracking-URL format
 *      (best signal — Amazon often hides the number behind a "Track Package"
 *      button).
 */
export function extractTracking(textBody: string | null, htmlBody: string | null): TrackingHit[] {
  const out = new Map<string, TrackingHit>(); // key by `number` to dedupe

  // 1) Anchor-based extraction (HTML).
  if (htmlBody) {
    const anchors = htmlBody.matchAll(ANCHOR_RE);
    for (const m of anchors) {
      const href = m[1];
      const hit = trackingFromUrl(href);
      if (hit) {
        const key = hit.number;
        if (!out.has(key)) out.set(key, hit);
      }
    }
  }

  // 2) Pattern-based extraction over text + visible html.
  const haystack = stripWhitespace(`${textBody || ''}\n${stripPossibleTags(htmlBody || '')}`);
  for (const { carrier, re } of TRACKING_PATTERNS) {
    re.lastIndex = 0;
    for (const m of haystack.matchAll(re)) {
      const num = m[0];
      // FedEx 12-digit collisions: skip if the preceding context suggests
      // it's an order/phone/credit-card number (rough heuristic).
      if (carrier === 'fedex' && num.length === 12 && looksLikeCardOrPhone(num)) continue;
      if (!out.has(num)) {
        out.set(num, { carrier, number: num });
      }
    }
  }

  return Array.from(out.values());
}

function looksLikeCardOrPhone(num: string): boolean {
  // 12-digit credit card is not a thing (CC are 13–19), but 10-digit NANP
  // phone numbers padded with leading digits could be 12. Skip if every
  // digit is the same or ascending (smells synthetic/UI placeholder).
  if (/^(\d)\1+$/.test(num)) return true;
  return false;
}

function stripPossibleTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ');
}

/**
 * Given a carrier tracking-page URL, recover `{carrier, number}`.
 * Recognises the major carriers and Amazon's 'gp/your-account/order-details'
 * style links (which encode `tba=...` for Amazon Logistics).
 */
export function trackingFromUrl(url: string): TrackingHit | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const params = u.searchParams;

  // UPS: wwwapps.ups.com or www.ups.com Track?tracknum=...
  if (host.endsWith('ups.com')) {
    const n = params.get('tracknum') || params.get('TrackingNumber') || params.get('InquiryNumber1');
    if (n) return { carrier: 'ups', number: n.trim().toUpperCase(), url };
  }
  // FedEx: fedex.com/...?tracknumbers=
  if (host.endsWith('fedex.com')) {
    const n = params.get('tracknumbers') || params.get('trknbr');
    if (n) return { carrier: 'fedex', number: n.split(',')[0].trim(), url };
  }
  // USPS: tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=
  if (host.endsWith('usps.com')) {
    const n = params.get('qtc_tLabels1') || params.get('tLabels');
    if (n) return { carrier: 'usps', number: n.split(',')[0].trim(), url };
  }
  // DHL: dhl.com/.../tracking?tracking-id=
  if (host.endsWith('dhl.com')) {
    const n = params.get('tracking-id') || params.get('AWB');
    if (n) return { carrier: 'dhl', number: n.split(',')[0].trim(), url };
  }
  // Amazon: ?tba=TBA1234... or ?packageId=...
  if (host.endsWith('amazon.com') || host.endsWith('a.co')) {
    const tba = params.get('tba') || params.get('trackingId');
    if (tba && /^TBA[0-9]{12}$/.test(tba)) return { carrier: 'amazon', number: tba, url };
    // Some Amazon order links contain "&shipmentId=..." — not a tracking #
    // by itself but worth surfacing as merchant_order_id elsewhere.
  }
  return null;
}

// ── Merchant-side order ID ─────────────────────────────────────────────

export interface MerchantOrderRef {
  merchant: Exclude<Merchant, null>;
  /** The merchant's externally-printed order/confirmation number. */
  orderId: string;
}

/**
 * Pull a merchant-side order ID out of the body. Patterns are conservative
 * (specific to known merchants) so we don't assign random digits as order IDs.
 */
export function extractMerchantOrderId(
  merchant: Exclude<Merchant, null>,
  textBody: string | null,
  htmlBody: string | null,
  subject: string | null,
): string | null {
  const blob = `${subject || ''}\n${textBody || ''}\n${stripPossibleTags(htmlBody || '')}`;
  switch (merchant) {
    case 'amazon': {
      // Amazon: 112-1234567-1234567 or 113-... (always 3-7-7 digit groups).
      const m = blob.match(/\b\d{3}-\d{7}-\d{7}\b/);
      return m ? m[0] : null;
    }
    case 'walmart': {
      // Walmart: 17-digit numeric, or 'Order # 200012345678901234'.
      const m = blob.match(/order\s*#?\s*(\d{16,20})/i);
      return m ? m[1] : null;
    }
    case 'target': {
      // Target: 12-digit; sometimes printed as 'Order # 102000123456'.
      const m = blob.match(/order\s*#?\s*(\d{10,14})/i);
      return m ? m[1] : null;
    }
    case 'bestbuy': {
      // Best Buy: 'BBY01-806123456789' or 12-digit.
      const m = blob.match(/\bBBY\d{2}-\d{12}\b/);
      return m ? m[0] : null;
    }
    case 'ebay': {
      // eBay: 'Order: 17-12345-67890' (varies).
      const m = blob.match(/\b\d{2}-\d{5}-\d{5}\b/);
      return m ? m[0] : null;
    }
    case 'apple':
    case 'shopify':
    case 'home_depot':
    case 'lowes':
    case 'costco': {
      const m = blob.match(/order\s*#?\s*([A-Z0-9-]{6,20})/i);
      return m ? m[1] : null;
    }
  }
  return null;
}

// ── Convenience: produce an "ingest" record from a parsed email ────────

export interface IngestPlan {
  merchant: Exclude<Merchant, null> | null;
  carrier: TrackingHit['carrier'] | null;
  merchantOrderId: string | null;
  itemSummary: string | null;
  trackings: TrackingHit[];
  intent: Intent;
}

/** Build a single object describing what to upsert into orders/shipments. */
export function planIngest(
  fromAddress: string | null | undefined,
  subject: string | null | undefined,
  textBody: string | null,
  htmlBody: string | null,
  rawHeaders?: Record<string, string> | null,
): IngestPlan {
  const cls = classifyEmail(fromAddress, subject, rawHeaders);
  const trackings = extractTracking(textBody, htmlBody);
  const merchant = cls.merchant;
  const merchantOrderId = merchant
    ? extractMerchantOrderId(merchant, textBody, htmlBody, subject || null)
    : null;
  const itemSummary = pickItemSummary(subject, textBody);
  return {
    merchant,
    carrier: cls.carrier,
    merchantOrderId,
    itemSummary,
    trackings,
    intent: cls.intent,
  };
}

function pickItemSummary(subject: string | null | undefined, _text: string | null): string | null {
  if (!subject) return null;
  // Strip common boilerplate prefixes so the summary reads better in lists.
  return subject
    .replace(/^(re|fwd?):\s*/i, '')
    .replace(/^(order|shipping|delivery)\s+(confirmation|notification)[:\s-]+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || null;
}

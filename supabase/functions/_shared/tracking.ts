// Shared carrier-tracking helpers used by:
//   - functions/orders                 (manual refresh / on tracking attach)
//   - functions/tracking-refresh-cron  (scheduled batch refresh)
//
// Strategy: detect carrier by tracking-number shape if not supplied, then
// call that carrier's public API. Each provider is best-effort — a 4xx or
// 5xx just keeps the shipment in its current status with `last_status_check_at`
// stamped so we don't hammer the API.
//
// Required env vars (only set what you actually use):
//   UPS_CLIENT_ID       UPS_CLIENT_SECRET     (OAuth — preferred)
//   FEDEX_API_KEY       FEDEX_SECRET_KEY      (OAuth)
//   USPS_USER_ID                              (Web Tools API)
//   SHIPENGINE_API_KEY                        (universal fallback, paid)
//
// If no creds are set, the helper falls back to ShipEngine if available,
// else returns { ok:false, reason:'no_carrier_credentials' }.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.103.0';

type Svc = SupabaseClient;

export type CarrierKey = 'ups' | 'fedex' | 'usps' | 'dhl' | 'unknown';

export function detectCarrier(tracking: string): CarrierKey {
  const t = tracking.replace(/\s+/g, '').toUpperCase();
  // UPS: 1Z prefix or all-digits 18-char
  if (/^1Z[A-Z0-9]{16}$/.test(t)) return 'ups';
  // FedEx: 12 or 15 digits (also 20 digits SmartPost; rare 22)
  if (/^\d{12}$/.test(t) || /^\d{15}$/.test(t) || /^\d{20}$/.test(t)) return 'fedex';
  // USPS: 22 digits, 20 digits, or starts with 9 + 21 digits / letters then digits
  if (/^9[0-9]{21,22}$/.test(t)) return 'usps';
  if (/^[A-Z]{2}\d{9}US$/.test(t)) return 'usps';
  // DHL: 10 digits, 11 digits, or various letter+digit patterns
  if (/^\d{10}$/.test(t) || /^\d{11}$/.test(t)) return 'dhl';
  return 'unknown';
}

interface NormalizedStatus {
  status: 'pending' | 'label_created' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'exception' | 'returned';
  message: string;
  estimated_delivery_date?: string | null; // YYYY-MM-DD
  actual_delivery_date?: string | null;
  events: Array<{ occurred_at: string; location?: string; description: string; status_code?: string; raw?: unknown }>;
  raw?: unknown;
}

function genericStatusFromCode(code: string | undefined, desc: string): NormalizedStatus['status'] {
  const s = (code || desc || '').toLowerCase();
  if (/deliver(ed|y complete)/.test(s)) return 'delivered';
  if (/out for delivery/.test(s)) return 'out_for_delivery';
  if (/return/.test(s)) return 'returned';
  if (/exception|undeliverable|damage|delay/.test(s)) return 'exception';
  if (/in transit|departed|arrived|picked up|origin/.test(s)) return 'in_transit';
  if (/label|manifest|pre.shipment|shipment information sent/.test(s)) return 'label_created';
  return 'in_transit';
}

// ── ShipEngine universal fallback ─────────────────────────────────────
async function shipEngineTrack(carrier: CarrierKey, tracking: string): Promise<NormalizedStatus | null> {
  const key = Deno.env.get('SHIPENGINE_API_KEY');
  if (!key) return null;
  const carrierCodeMap: Record<CarrierKey, string> = {
    ups: 'ups', fedex: 'fedex_ground', usps: 'stamps_com',
    dhl: 'dhl_express', unknown: '',
  };
  const cc = carrierCodeMap[carrier];
  if (!cc) return null;
  const r = await fetch(`https://api.shipengine.com/v1/tracking?carrier_code=${cc}&tracking_number=${encodeURIComponent(tracking)}`, {
    headers: { 'API-Key': key },
  });
  if (!r.ok) return null;
  const j = await r.json();
  const events: NormalizedStatus['events'] = (j.events || []).map((e: Record<string, unknown>) => ({
    occurred_at: String(e.occurred_at || e.carrier_occurred_at || new Date().toISOString()),
    location: [e.city_locality, e.state_province, e.country_code].filter(Boolean).join(', ') || undefined,
    description: String(e.description || e.status_description || ''),
    status_code: e.status_code ? String(e.status_code) : undefined,
    raw: e,
  }));
  const last = events[0];
  return {
    status: genericStatusFromCode(last?.status_code, last?.description || j.status_description),
    message: String(j.status_description || last?.description || ''),
    estimated_delivery_date: j.estimated_delivery_date?.slice(0, 10) ?? null,
    actual_delivery_date: j.actual_delivery_date?.slice(0, 10) ?? null,
    events,
    raw: j,
  };
}

// ── UPS (OAuth → tracking v1) ─────────────────────────────────────────
async function upsTrack(tracking: string): Promise<NormalizedStatus | null> {
  const id = Deno.env.get('UPS_CLIENT_ID');
  const secret = Deno.env.get('UPS_CLIENT_SECRET');
  if (!id || !secret) return null;
  const tokRes = await fetch('https://onlinetools.ups.com/security/v1/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!tokRes.ok) return null;
  const tokJson = await tokRes.json();
  const token = tokJson.access_token;
  const r = await fetch(`https://onlinetools.ups.com/api/track/v1/details/${encodeURIComponent(tracking)}?locale=en_US&returnSignature=false`, {
    headers: { Authorization: `Bearer ${token}`, 'transId': crypto.randomUUID(), 'transactionSrc': 'offline' },
  });
  if (!r.ok) return null;
  const j = await r.json();
  const shipment = j?.trackResponse?.shipment?.[0]?.package?.[0];
  if (!shipment) return null;
  const events: NormalizedStatus['events'] = (shipment.activity || []).map((a: Record<string, unknown>) => {
    const date = String(a.date || ''); const time = String(a.time || '');
    const iso = date && time
      ? `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T${time.slice(0,2)}:${time.slice(2,4)}:${time.slice(4,6) || '00'}Z`
      : new Date().toISOString();
    const loc = (a.location as Record<string, unknown> | undefined)?.address as Record<string, unknown> | undefined;
    return {
      occurred_at: iso,
      location: loc ? [loc.city, loc.stateProvince, loc.countryCode].filter(Boolean).join(', ') : undefined,
      description: String((a.status as Record<string, unknown> | undefined)?.description || ''),
      status_code: String((a.status as Record<string, unknown> | undefined)?.code || ''),
      raw: a,
    };
  });
  const status = String(shipment.currentStatus?.description || '');
  const eta = shipment.deliveryDate?.[0]?.date as string | undefined;
  return {
    status: genericStatusFromCode(undefined, status),
    message: status,
    estimated_delivery_date: eta ? `${eta.slice(0,4)}-${eta.slice(4,6)}-${eta.slice(6,8)}` : null,
    actual_delivery_date: null,
    events,
    raw: j,
  };
}

// ── FedEx (OAuth → track/v1/trackingnumbers) ─────────────────────────
async function fedexTrack(tracking: string): Promise<NormalizedStatus | null> {
  const id = Deno.env.get('FEDEX_API_KEY');
  const secret = Deno.env.get('FEDEX_SECRET_KEY');
  if (!id || !secret) return null;
  const tokRes = await fetch('https://apis.fedex.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}`,
  });
  if (!tokRes.ok) return null;
  const tok = (await tokRes.json()).access_token;
  const r = await fetch('https://apis.fedex.com/track/v1/trackingnumbers', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', 'X-locale': 'en_US' },
    body: JSON.stringify({
      includeDetailedScans: true,
      trackingInfo: [{ trackingNumberInfo: { trackingNumber: tracking } }],
    }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const ti = j?.output?.completeTrackResults?.[0]?.trackResults?.[0];
  if (!ti) return null;
  const events: NormalizedStatus['events'] = (ti.scanEvents || []).map((e: Record<string, unknown>) => ({
    occurred_at: String(e.date || new Date().toISOString()),
    location: (e.scanLocation as Record<string, unknown> | undefined)
      ? [
          (e.scanLocation as Record<string, unknown>).city,
          (e.scanLocation as Record<string, unknown>).stateOrProvinceCode,
          (e.scanLocation as Record<string, unknown>).countryCode,
        ].filter(Boolean).join(', ')
      : undefined,
    description: String(e.eventDescription || ''),
    status_code: e.eventType ? String(e.eventType) : undefined,
    raw: e,
  }));
  const latestStatus = String(ti.latestStatusDetail?.description || '');
  const eta = ti.dateAndTimes?.find((d: Record<string, unknown>) => d.type === 'ESTIMATED_DELIVERY')?.dateTime as string | undefined;
  const actual = ti.dateAndTimes?.find((d: Record<string, unknown>) => d.type === 'ACTUAL_DELIVERY')?.dateTime as string | undefined;
  return {
    status: genericStatusFromCode(ti.latestStatusDetail?.code, latestStatus),
    message: latestStatus,
    estimated_delivery_date: eta?.slice(0, 10) ?? null,
    actual_delivery_date: actual?.slice(0, 10) ?? null,
    events,
    raw: j,
  };
}

// ── Public refresh entry point ─────────────────────────────────────────
export async function refreshShipment(svc: Svc, shipmentId: string): Promise<{ ok: boolean; status?: string; reason?: string }> {
  const { data: shipment, error } = await svc.from('order_shipments').select('*').eq('id', shipmentId).maybeSingle();
  if (error || !shipment) return { ok: false, reason: 'not_found' };
  const tracking = (shipment.tracking_number || '').trim();
  if (!tracking) return { ok: false, reason: 'no_tracking' };
  const carrier = (shipment.carrier as CarrierKey) || detectCarrier(tracking);

  let normalized: NormalizedStatus | null = null;
  try {
    if (carrier === 'ups')   normalized = await upsTrack(tracking);
    else if (carrier === 'fedex') normalized = await fedexTrack(tracking);
    if (!normalized)         normalized = await shipEngineTrack(carrier, tracking);
  } catch (err) {
    console.error('[tracking] carrier call failed:', err);
  }

  if (!normalized) {
    await svc.from('order_shipments').update({
      last_status_check_at: new Date().toISOString(),
    }).eq('id', shipmentId);
    return { ok: false, reason: 'no_carrier_credentials_or_lookup_failed' };
  }

  await svc.from('order_shipments').update({
    carrier: carrier === 'unknown' ? shipment.carrier : carrier,
    status: normalized.status,
    estimated_delivery_date: normalized.estimated_delivery_date || shipment.estimated_delivery_date,
    actual_delivery_date: normalized.actual_delivery_date || shipment.actual_delivery_date,
    last_status_check_at: new Date().toISOString(),
    last_status_message: normalized.message?.slice(0, 500) || null,
    raw_carrier_payload: normalized.raw ?? null,
  }).eq('id', shipmentId);

  // Insert any new events; the unique index handles dedupe.
  if (normalized.events.length) {
    const rows = normalized.events.map(e => ({
      shipment_id: shipmentId,
      occurred_at: e.occurred_at,
      location: e.location || null,
      description: e.description?.slice(0, 500) || null,
      status_code: e.status_code || null,
      raw: e.raw ?? null,
    }));
    await svc.from('order_tracking_events').upsert(rows, {
      onConflict: 'shipment_id,occurred_at,status_code',
      ignoreDuplicates: true,
    });
  }

  // Bubble up to order if delivered.
  if (normalized.status === 'delivered') {
    const { data: siblings } = await svc.from('order_shipments')
      .select('status').eq('order_id', shipment.order_id);
    if ((siblings || []).every(s => s.status === 'delivered')) {
      await svc.from('orders').update({ status: 'delivered' }).eq('id', shipment.order_id);
    }
  }

  return { ok: true, status: normalized.status };
}

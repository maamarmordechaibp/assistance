// Edge Function: sw-order-status
//
// Customer-facing IVR branch that reads back open orders & tracking info.
//
// Entry: redirected from sw-inbound when a known customer presses "5"
// in the main menu (and they have at least one open order). Customers
// without an open order should never reach this — sw-inbound only offers
// the option when there's something to track.
//
// Steps:
//   ?step=intro&customerId=…
//        → if 0 orders: "no open orders" → bounce back to main menu
//        → if 1 order:  jump straight to ?step=order&orderId=…
//        → if N>1:      list "for the AirPods, press 1" up to 5 + "for more, press 0 for an agent"
//   ?step=pick&customerId=… (digits)        → pick an order from the list
//   ?step=order&orderId=…                   → announce status + ETA + options
//        1 = read tracking number digit-by-digit
//        2 = repeat
//        3 = SMS the tracking number to caller
//        9 = next order (cycle)
//        * = main menu
//   ?step=tracking&orderId=…&action=read|sms
//
// The order list is fetched fresh on every step so live updates from the
// carrier-refresh cron land immediately.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import * as laml from '../_shared/laml.ts';

interface OpenOrder {
  order_id: string;
  customer_id: string;
  merchant_name: string;
  item_summary: string;
  order_status: string;
  shipment_id: string | null;
  carrier: string | null;
  tracking_number: string | null;
  shipment_status: string | null;
  estimated_delivery_date: string | null;
  actual_delivery_date: string | null;
  last_status_message: string | null;
}

const OPEN_ORDER_STATUSES = ['placed', 'paid', 'shipped'];

function fetchOpenOrders(svc: ReturnType<typeof createServiceClient>, customerId: string) {
  return svc.from('v_order_latest_shipment')
    .select('*')
    .eq('customer_id', customerId)
    .in('order_status', OPEN_ORDER_STATUSES)
    .order('order_id', { ascending: false });
}

function speakDigits(s: string): string {
  // "1Z999AA10123456784" → "1 Z 9 9 9 A A 1 0 1 2 3 4 5 6 7 8 4"
  return s.replace(/\s+/g, '').split('').join(' ');
}

function spokenDate(iso: string | null | undefined): string {
  if (!iso) return 'a date that has not been confirmed yet';
  const d = new Date(`${iso}T12:00:00Z`);
  if (isNaN(d.getTime())) return 'an unconfirmed date';
  const today = new Date();
  today.setUTCHours(12, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  const opts: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' };
  return new Intl.DateTimeFormat('en-US', opts).format(d);
}

function spokenStatus(s: string | null): string {
  switch ((s || '').toLowerCase()) {
    case 'pending':         return 'order placed';
    case 'label_created':   return 'a shipping label has been created';
    case 'in_transit':      return 'in transit';
    case 'out_for_delivery':return 'out for delivery';
    case 'delivered':       return 'delivered';
    case 'exception':       return 'experiencing a delivery issue';
    case 'returned':        return 'on its way back to the sender';
    default:                return 'on its way';
  }
}

serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const url = new URL(req.url);
  const step = url.searchParams.get('step') || 'intro';
  const customerId = url.searchParams.get('customerId') || '';
  const orderIdParam = url.searchParams.get('orderId') || '';
  const action = url.searchParams.get('action') || '';
  const formData = await req.formData();
  const digits = (formData.get('Digits') as string | null) || '';
  const callSid = formData.get('CallSid') as string;
  const from = formData.get('From') as string | null;

  const svc = createServiceClient();
  const baseUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1`;
  const backToMenu = `${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`;

  // ─ INTRO: list orders or jump to single ─────────────────────────
  if (step === 'intro' && customerId) {
    const { data } = await fetchOpenOrders(svc, customerId);
    const orders = (data as OpenOrder[] | null) || [];

    if (orders.length === 0) {
      const elements = [
        laml.say("It looks like you don't have any open orders right now."),
        laml.redirect(backToMenu),
      ];
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }

    if (orders.length === 1) {
      const elements = [laml.redirect(`${baseUrl}/sw-order-status?step=order&customerId=${customerId}&orderId=${orders[0].order_id}`)];
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }

    // Cap to first 5 — anything beyond, route to a rep.
    const lines: string[] = [`You have ${orders.length} open orders.`];
    const visible = orders.slice(0, 5);
    visible.forEach((o, i) => {
      lines.push(`For the ${o.item_summary} from ${o.merchant_name}, press ${i + 1}.`);
    });
    if (orders.length > 5) {
      lines.push('To speak with an agent about another order, press 0.');
    }
    lines.push('To return to the main menu, press star.');

    const elements = [
      laml.gather(
        { input: 'dtmf', numDigits: 1, timeout: 10,
          action: `${baseUrl}/sw-order-status?step=pick&customerId=${customerId}` },
        laml.sayLines(lines),
      ),
      laml.redirect(backToMenu),
    ];
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ─ PICK: caller selected an order from the list ─────────────────
  if (step === 'pick' && customerId && digits) {
    if (digits === '*') return new Response(laml.buildLamlResponse([laml.redirect(backToMenu)]), { headers: { 'Content-Type': 'application/xml' } });
    if (digits === '0') {
      return new Response(laml.buildLamlResponse([
        laml.say('Connecting you to an agent.'),
        laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep&customerId=${customerId}`),
      ]), { headers: { 'Content-Type': 'application/xml' } });
    }
    const idx = parseInt(digits, 10) - 1;
    const { data } = await fetchOpenOrders(svc, customerId);
    const orders = (data as OpenOrder[] | null) || [];
    if (idx < 0 || idx >= Math.min(orders.length, 5)) {
      return new Response(laml.buildLamlResponse([
        laml.say("I didn't catch that."),
        laml.redirect(`${baseUrl}/sw-order-status?step=intro&customerId=${customerId}`),
      ]), { headers: { 'Content-Type': 'application/xml' } });
    }
    return new Response(laml.buildLamlResponse([
      laml.redirect(`${baseUrl}/sw-order-status?step=order&customerId=${customerId}&orderId=${orders[idx].order_id}`),
    ]), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ─ ORDER: announce status + tracking options ────────────────────
  if (step === 'order' && customerId && orderIdParam) {
    const { data } = await svc.from('v_order_latest_shipment')
      .select('*').eq('order_id', orderIdParam).maybeSingle();
    const o = data as OpenOrder | null;
    if (!o) {
      return new Response(laml.buildLamlResponse([
        laml.say("I couldn't find that order."),
        laml.redirect(backToMenu),
      ]), { headers: { 'Content-Type': 'application/xml' } });
    }

    // Optional: handle action=read / action=sms passed in via Gather action
    if (digits === '1') {
      const tn = o.tracking_number || '';
      if (!tn) {
        return new Response(laml.buildLamlResponse([
          laml.say("A tracking number isn't available yet for this order."),
          laml.redirect(`${baseUrl}/sw-order-status?step=order&customerId=${customerId}&orderId=${orderIdParam}`),
        ]), { headers: { 'Content-Type': 'application/xml' } });
      }
      const lines: string[] = [
        `Your tracking number is: ${speakDigits(tn)}.`,
        `Once more: ${speakDigits(tn)}.`,
      ];
      const elements = [
        laml.sayLines(lines).join('\n'),
        laml.gather(
          { input: 'dtmf', numDigits: 1, timeout: 8,
            action: `${baseUrl}/sw-order-status?step=order&customerId=${customerId}&orderId=${orderIdParam}` },
          [laml.say('Press 1 to repeat. Press 3 to receive it by text message. Press star to return to the main menu.')],
        ),
        laml.redirect(backToMenu),
      ];
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }

    if (digits === '3') {
      // Best-effort SMS via SignalWire REST. Falls back gracefully if not configured.
      try {
        if (from && o.tracking_number) {
          const sid    = Deno.env.get('SIGNALWIRE_PROJECT_ID')   || Deno.env.get('SIGNALWIRE_PROJECT');
          const token  = Deno.env.get('SIGNALWIRE_API_TOKEN')    || Deno.env.get('SIGNALWIRE_TOKEN');
          const space  = Deno.env.get('SIGNALWIRE_SPACE')        || Deno.env.get('SIGNALWIRE_SPACE_URL');
          const fromNo = Deno.env.get('SIGNALWIRE_FROM_NUMBER');
          if (sid && token && space && fromNo) {
            const body = `Your ${o.merchant_name} tracking: ${o.tracking_number}` +
                         (o.estimated_delivery_date ? ` (ETA ${o.estimated_delivery_date})` : '');
            const auth = btoa(`${sid}:${token}`);
            const host = space.startsWith('http') ? space : `https://${space}`;
            await fetch(`${host}/api/laml/2010-04-01/Accounts/${sid}/Messages.json`, {
              method: 'POST',
              headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ From: fromNo, To: from, Body: body }).toString(),
            });
          }
        }
      } catch (err) {
        console.error('[sw-order-status] sms send failed:', err);
      }
      return new Response(laml.buildLamlResponse([
        laml.say('Your tracking number is on the way by text message.'),
        laml.redirect(backToMenu),
      ]), { headers: { 'Content-Type': 'application/xml' } });
    }

    if (digits === '*') {
      return new Response(laml.buildLamlResponse([laml.redirect(backToMenu)]), { headers: { 'Content-Type': 'application/xml' } });
    }

    // First time on the order page (no digit) — read the announcement.
    const dateText = o.actual_delivery_date
      ? `It was delivered ${spokenDate(o.actual_delivery_date)}.`
      : `It is currently ${spokenStatus(o.shipment_status)}, scheduled to arrive ${spokenDate(o.estimated_delivery_date)}.`;

    const announce = [
      `Your order for ${o.item_summary} from ${o.merchant_name}.`,
      dateText,
    ];
    if (o.last_status_message) announce.push(`Most recent update: ${o.last_status_message}.`);

    const opts: string[] = [];
    if (o.tracking_number) {
      opts.push('To hear the tracking number, press 1.');
      opts.push('To receive the tracking number by text message, press 3.');
    }
    opts.push('To return to the main menu, press star.');

    const elements = [
      laml.gather(
        { input: 'dtmf', numDigits: 1, timeout: 12,
          action: `${baseUrl}/sw-order-status?step=order&customerId=${customerId}&orderId=${orderIdParam}` },
        laml.sayLines([...announce, ...opts]),
      ),
      laml.redirect(backToMenu),
    ];

    // Log this read in call_traces for diagnostics.
    await svc.from('call_traces').insert({
      call_sid: callSid, step: 'order-status-read',
      details: { customer_id: customerId, order_id: orderIdParam, shipment_status: o.shipment_status },
    }).then(() => {}).catch(() => {});

    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  return new Response(laml.buildLamlResponse([
    laml.say('Returning you to the main menu.'),
    laml.redirect(backToMenu),
  ]), { headers: { 'Content-Type': 'application/xml' } });
});

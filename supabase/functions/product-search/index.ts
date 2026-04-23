// Edge Function: product-search
// Scrape product options from the rep's live Browserbase page, generate a PDF,
// email it to the customer, and allow rep to re-open any option later.
//
// Actions (all POST except GET action=pdf):
//   POST { action:'scrape',  customerId, callId?, query?, site? }
//          → evaluates DOM in the currently-open Browserbase page, saves a
//            bundle of options, returns { searchId, options: [...] }
//   GET  ?action=pdf&searchId=...
//          → returns PDF bytes (inline download) of the saved bundle
//   POST { action:'email',   searchId, toEmail }
//          → sends the PDF via Resend to toEmail, records sent_at
//   POST { action:'open',    searchId, optionNumber }
//          → navigates the live Browserbase page to that option's URL
//   GET  ?action=list&customerId=...
//          → lists all saved product searches for a customer
//   GET  ?action=get&searchId=...
//          → returns one search + its options

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createUserClient, createServiceClient, getUser } from '../_shared/supabase.ts';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';

const BB_API = 'https://api.browserbase.com/v1';
function bbHeaders() {
  return { 'X-BB-API-Key': Deno.env.get('BROWSERBASE_API_KEY')!, 'Content-Type': 'application/json' };
}

// ─── JS evaluated inside the live Browserbase page to extract product cards ───
// Supports Amazon first, then generic microdata / OpenGraph / rel=next-style
// heuristics so it still returns something useful on other sites.
const SCRAPE_JS = `
(() => {
  function text(el) { return el ? (el.textContent || '').trim().replace(/\\s+/g,' ') : null; }
  function abs(href) { try { return new URL(href, location.href).href; } catch { return null; } }
  const host = location.hostname.replace(/^www\\./,'');
  let site = 'other';
  if (/amazon\\./.test(host)) site = 'amazon';
  else if (/walmart\\./.test(host)) site = 'walmart';
  else if (/bestbuy\\./.test(host)) site = 'bestbuy';
  else if (/ebay\\./.test(host)) site = 'ebay';
  else if (/target\\./.test(host)) site = 'target';

  const items = [];

  if (site === 'amazon') {
    document.querySelectorAll('[data-component-type="s-search-result"]').forEach((card) => {
      const link = card.querySelector('h2 a, a.a-link-normal.s-no-outline, a.a-link-normal[href*="/dp/"]');
      const titleEl = card.querySelector('h2 span, h2 a span, [data-cy="title-recipe"] span, span.a-text-normal');
      const priceEl = card.querySelector('.a-price:not(.a-text-price) .a-offscreen, .a-price .a-offscreen');
      const ratingEl = card.querySelector('.a-icon-alt');
      const reviewsEl = card.querySelector('[aria-label*="ratings"], .a-size-base.s-underline-text');
      const imgEl = card.querySelector('img.s-image, img[srcset]');
      if (link && (titleEl || link.getAttribute('aria-label'))) {
        items.push({
          title: text(titleEl) || link.getAttribute('aria-label'),
          price: text(priceEl),
          rating: text(ratingEl),
          reviews: text(reviewsEl),
          url: abs(link.getAttribute('href')),
          image_url: imgEl ? (imgEl.getAttribute('src') || imgEl.getAttribute('data-src')) : null,
        });
      }
    });
  } else if (site === 'walmart') {
    document.querySelectorAll('[data-item-id], [data-testid="item-stack"] > div').forEach((card) => {
      const link = card.querySelector('a[link-identifier], a[href*="/ip/"]');
      const titleEl = card.querySelector('[data-automation-id="product-title"], span.w_iUH7');
      const priceEl = card.querySelector('[data-automation-id="product-price"], div[data-automation-id="product-price"] span');
      const imgEl = card.querySelector('img');
      if (link && titleEl) {
        items.push({
          title: text(titleEl),
          price: text(priceEl),
          rating: null,
          url: abs(link.getAttribute('href')),
          image_url: imgEl ? imgEl.getAttribute('src') : null,
        });
      }
    });
  }

  // Generic fallback — microdata / og:product cards / anchor+image grid.
  if (items.length === 0) {
    document.querySelectorAll('a[href]').forEach((a) => {
      if (items.length >= 20) return;
      const href = a.getAttribute('href') || '';
      if (!/^\\/|^https?:/.test(href)) return;
      const img = a.querySelector('img');
      const h = a.querySelector('h1,h2,h3,h4, [class*="title"], [class*="Title"]');
      const p = a.querySelector('[class*="price"], [class*="Price"], .price');
      if (img && h) {
        items.push({
          title: text(h),
          price: text(p),
          rating: null,
          url: abs(href),
          image_url: img.getAttribute('src') || img.getAttribute('data-src'),
        });
      }
    });
  }

  // De-dupe by URL
  const seen = new Set(); const unique = [];
  for (const it of items) {
    if (!it.url || seen.has(it.url)) continue;
    seen.add(it.url); unique.push(it);
    if (unique.length >= 20) break;
  }

  return { site, url: location.href, title: document.title, items: unique };
})()
`;

// ─── Minimal CDP-over-WebSocket helper for a Browserbase connect_url ───
// Browserbase's connect_url is the browser-wide CDP endpoint. We list targets,
// attach to the first page, enable Runtime, then evaluate the scrape JS.
type CdpMsg = { id?: number; method?: string; params?: unknown; sessionId?: string; result?: Record<string, unknown>; error?: { message?: string } };

async function openCdp(connectUrl: string): Promise<WebSocket> {
  const ws = new WebSocket(connectUrl);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('CDP connect timeout')), 15000);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = (e) => { clearTimeout(t); reject(new Error('CDP ws error: ' + (e as ErrorEvent).message)); };
  });
  return ws;
}

function cdpCall(ws: WebSocket, method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 20000): Promise<CdpMsg> {
  const id = Math.floor(Math.random() * 1_000_000_000);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`CDP ${method} timeout`)), timeoutMs);
    const listener = (e: MessageEvent) => {
      let msg: CdpMsg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.id === id) {
        clearTimeout(t);
        ws.removeEventListener('message', listener);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg);
      }
    };
    ws.addEventListener('message', listener);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function evaluateOnFirstPage(connectUrl: string, expression: string): Promise<unknown> {
  const ws = await openCdp(connectUrl);
  try {
    const targets = await cdpCall(ws, 'Target.getTargets');
    const infos = (targets.result as { targetInfos: { type: string; targetId: string; url: string }[] })?.targetInfos || [];
    const page = infos.find(t => t.type === 'page' && !t.url.startsWith('devtools://')) || infos.find(t => t.type === 'page');
    if (!page) throw new Error('No page target found in Browserbase session');
    const attach = await cdpCall(ws, 'Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const sessionId = (attach.result as { sessionId: string }).sessionId;
    await cdpCall(ws, 'Runtime.enable', {}, sessionId);
    const ev = await cdpCall(ws, 'Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, timeout: 15000,
    }, sessionId, 25000);
    const r = (ev.result as { result?: { value?: unknown; subtype?: string; description?: string } }).result;
    if (r?.subtype === 'error') throw new Error('Evaluate error: ' + r.description);
    return r?.value;
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
}

async function navigateFirstPage(connectUrl: string, url: string): Promise<void> {
  const ws = await openCdp(connectUrl);
  try {
    const targets = await cdpCall(ws, 'Target.getTargets');
    const infos = (targets.result as { targetInfos: { type: string; targetId: string; url: string }[] })?.targetInfos || [];
    const page = infos.find(t => t.type === 'page' && !t.url.startsWith('devtools://')) || infos.find(t => t.type === 'page');
    if (!page) throw new Error('No page target found');
    const attach = await cdpCall(ws, 'Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const sessionId = (attach.result as { sessionId: string }).sessionId;
    await cdpCall(ws, 'Page.enable', {}, sessionId);
    await cdpCall(ws, 'Page.navigate', { url }, sessionId);
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
}

// ─── PDF rendering using pdf-lib ───
type Opt = { option_number: number; title: string | null; price: string | null; rating: string | null; image_url: string | null; product_url: string };

async function fetchImage(url: string): Promise<{ bytes: Uint8Array; type: 'jpg'|'png' } | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (ct.includes('png') || url.toLowerCase().includes('.png')) return { bytes, type: 'png' };
    return { bytes, type: 'jpg' };
  } catch { return null; }
}

async function buildPdf(params: {
  customerName: string;
  repName: string;
  query: string;
  sourceUrl: string;
  site: string;
  createdAt: string;
  options: Opt[];
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Cover page
  const cover = pdf.addPage([612, 792]); // US Letter
  const { width } = cover.getSize();
  cover.drawText('Product Options', { x: 50, y: 740, size: 28, font: bold, color: rgb(0.1, 0.1, 0.15) });
  cover.drawText(`Prepared for: ${params.customerName || 'Customer'}`, { x: 50, y: 700, size: 14, font });
  cover.drawText(`Search: ${params.query}`.slice(0, 90), { x: 50, y: 680, size: 12, font });
  cover.drawText(`Source: ${params.site}`, { x: 50, y: 662, size: 11, font, color: rgb(0.35,0.35,0.4) });
  cover.drawText(`Date: ${new Date(params.createdAt).toLocaleString()}`, { x: 50, y: 646, size: 11, font, color: rgb(0.35,0.35,0.4) });
  cover.drawText(`Rep: ${params.repName}`, { x: 50, y: 630, size: 11, font, color: rgb(0.35,0.35,0.4) });
  cover.drawText(`${params.options.length} options inside`, { x: 50, y: 604, size: 12, font: bold, color: rgb(0.1, 0.3, 0.6) });
  cover.drawText('Tell the rep which option number you want and they will open it for you.', {
    x: 50, y: 570, size: 10, font, color: rgb(0.4,0.4,0.45), maxWidth: width - 100,
  });

  // One page per option — image top, details below
  for (const opt of params.options) {
    const page = pdf.addPage([612, 792]);
    const w = 612; const h = 792;

    // Header band
    page.drawRectangle({ x: 0, y: h - 60, width: w, height: 60, color: rgb(0.95, 0.96, 0.99) });
    page.drawText(`Option ${opt.option_number}`, { x: 40, y: h - 40, size: 20, font: bold, color: rgb(0.1, 0.2, 0.5) });

    // Image (if any)
    let imgBottom = h - 110;
    if (opt.image_url) {
      const img = await fetchImage(opt.image_url);
      if (img) {
        try {
          const embedded = img.type === 'png' ? await pdf.embedPng(img.bytes) : await pdf.embedJpg(img.bytes);
          const maxW = 320, maxH = 280;
          const scale = Math.min(maxW / embedded.width, maxH / embedded.height, 1);
          const iw = embedded.width * scale, ih = embedded.height * scale;
          const ix = (w - iw) / 2, iy = h - 110 - ih;
          page.drawImage(embedded, { x: ix, y: iy, width: iw, height: ih });
          imgBottom = iy - 10;
        } catch { /* skip image on embed error */ }
      }
    }

    // Title (wrapped)
    const title = (opt.title || '(no title)').slice(0, 300);
    const titleLines = wrap(title, 85);
    let yy = imgBottom - 10;
    for (const line of titleLines.slice(0, 4)) {
      page.drawText(line, { x: 40, y: yy, size: 13, font: bold, color: rgb(0.1, 0.1, 0.15) });
      yy -= 18;
    }
    yy -= 6;

    if (opt.price) { page.drawText(`Price: ${opt.price}`, { x: 40, y: yy, size: 14, font: bold, color: rgb(0.1, 0.55, 0.2) }); yy -= 20; }
    if (opt.rating) { page.drawText(`Rating: ${opt.rating}`, { x: 40, y: yy, size: 11, font, color: rgb(0.3,0.3,0.35) }); yy -= 16; }

    // URL (wrapped, tiny)
    yy -= 10;
    page.drawText('Link:', { x: 40, y: yy, size: 9, font: bold, color: rgb(0.4,0.4,0.45) });
    yy -= 12;
    for (const line of wrap(opt.product_url, 95).slice(0, 3)) {
      page.drawText(line, { x: 40, y: yy, size: 8, font, color: rgb(0.25, 0.35, 0.7) });
      yy -= 11;
    }

    // Footer
    page.drawText(`${params.customerName} — ${params.query}`.slice(0, 90), {
      x: 40, y: 30, size: 8, font, color: rgb(0.6,0.6,0.65),
    });
    page.drawText(`Page ${opt.option_number}`, { x: w - 80, y: 30, size: 8, font, color: rgb(0.6,0.6,0.65) });
  }

  return await pdf.save();
}

function wrap(s: string, max: number): string[] {
  const out: string[] = []; const words = s.split(/\s+/); let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > max) { if (line) out.push(line); line = w; }
    else { line = (line ? line + ' ' : '') + w; }
  }
  if (line) out.push(line);
  return out;
}

// ─── Request handler ───
serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || (req.method === 'POST' ? '' : '');

  // Authenticated user (rep) required for most actions.
  const user = await getUser(req);
  if (!user) return json({ error: 'unauthorized' }, 401);
  const userClient = createUserClient(req);
  const { data: rep } = await userClient.from('reps').select('id, full_name').eq('id', user.id).maybeSingle();
  if (!rep) return json({ error: 'rep only' }, 403);

  const svc = createServiceClient();

  try {
    // ── GET actions ─────────────────────────────────────────
    if (req.method === 'GET') {
      if (action === 'pdf') return await handlePdf(svc, url.searchParams.get('searchId') || '');
      if (action === 'list') {
        const customerId = url.searchParams.get('customerId') || '';
        if (!customerId) return json({ error: 'customerId required' }, 400);
        const { data } = await svc.from('customer_product_searches')
          .select('id, query, site, source_url, options_count, sent_email, sent_at, created_at')
          .eq('customer_id', customerId).order('created_at', { ascending: false }).limit(50);
        return json({ searches: data || [] });
      }
      if (action === 'get') {
        const searchId = url.searchParams.get('searchId') || '';
        return await handleGet(svc, searchId);
      }
      return json({ error: 'unknown action' }, 400);
    }

    // ── POST actions ────────────────────────────────────────
    if (req.method === 'POST') {
      const body = await req.json();
      const actionPost = body.action || action;

      if (actionPost === 'scrape') {
        return await handleScrape(svc, user.id, body);
      }
      if (actionPost === 'email') {
        return await handleEmail(svc, body.searchId, body.toEmail, body.note || '');
      }
      if (actionPost === 'open') {
        return await handleOpen(svc, body.searchId, body.optionNumber);
      }
      return json({ error: 'unknown action' }, 400);
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (err) {
    console.error('[product-search]', err);
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// ─── handleScrape ───────────────────────────────────────────
async function handleScrape(svc: ReturnType<typeof createServiceClient>, repId: string, body: Record<string, unknown>) {
  const customerId = String(body.customerId || '');
  const callId = body.callId ? String(body.callId) : null;
  const query = String(body.query || '');
  if (!customerId) return json({ error: 'customerId required' }, 400);

  // Look up the rep's current BB session for this customer
  const { data: session } = await svc.from('customer_browser_sessions')
    .select('id, bb_session_id, connect_url')
    .eq('customer_id', customerId).eq('status', 'active')
    .order('started_at', { ascending: false }).limit(1).maybeSingle();
  if (!session?.connect_url) return json({ error: 'No active browser session for this customer' }, 400);

  // Scrape via CDP
  let scraped: { site: string; url: string; title: string; items: Array<Record<string, string | null>> };
  try {
    scraped = await evaluateOnFirstPage(session.connect_url, SCRAPE_JS) as typeof scraped;
  } catch (err) {
    return json({ error: 'scrape failed', detail: String((err as Error).message) }, 502);
  }
  if (!scraped || !Array.isArray(scraped.items) || scraped.items.length === 0) {
    return json({ error: 'No products found on the current page. Make sure rep is on a search-results page.' }, 400);
  }

  // Save bundle
  const { data: insertedSearch, error: ise } = await svc.from('customer_product_searches').insert({
    customer_id: customerId,
    call_id: callId,
    rep_id: repId,
    query: query || scraped.title || 'Products',
    source_url: scraped.url,
    site: scraped.site,
    bb_session_id: session.bb_session_id,
    options_count: scraped.items.length,
  }).select('id, query, site, source_url, created_at').single();
  if (ise || !insertedSearch) return json({ error: 'save failed', detail: ise?.message }, 500);

  const optRows = scraped.items.map((it, i) => ({
    search_id: insertedSearch.id,
    option_number: i + 1,
    title: it.title || null,
    price: it.price || null,
    rating: it.rating || null,
    image_url: it.image_url || null,
    product_url: it.url || '',
    raw_data: it,
  })).filter(r => r.product_url);
  await svc.from('customer_product_options').insert(optRows);

  return json({ searchId: insertedSearch.id, options: optRows, search: insertedSearch });
}

// ─── handleGet ─────────────────────────────────────────────
async function handleGet(svc: ReturnType<typeof createServiceClient>, searchId: string) {
  if (!searchId) return json({ error: 'searchId required' }, 400);
  const { data: search } = await svc.from('customer_product_searches').select('*').eq('id', searchId).maybeSingle();
  if (!search) return json({ error: 'not found' }, 404);
  const { data: opts } = await svc.from('customer_product_options').select('*').eq('search_id', searchId).order('option_number');
  return json({ search, options: opts || [] });
}

// ─── handlePdf ─────────────────────────────────────────────
async function handlePdf(svc: ReturnType<typeof createServiceClient>, searchId: string): Promise<Response> {
  if (!searchId) return json({ error: 'searchId required' }, 400);
  const { data: search } = await svc.from('customer_product_searches')
    .select('id, customer_id, rep_id, query, site, source_url, created_at')
    .eq('id', searchId).maybeSingle();
  if (!search) return json({ error: 'not found' }, 404);

  const [{ data: customer }, { data: repRow }, { data: opts }] = await Promise.all([
    svc.from('customers').select('full_name').eq('id', search.customer_id).maybeSingle(),
    search.rep_id ? svc.from('reps').select('full_name').eq('id', search.rep_id).maybeSingle() : Promise.resolve({ data: null }),
    svc.from('customer_product_options').select('*').eq('search_id', searchId).order('option_number'),
  ]);

  const bytes = await buildPdf({
    customerName: customer?.full_name || 'Customer',
    repName: (repRow && 'full_name' in repRow ? (repRow as { full_name?: string }).full_name : '') || 'Offline',
    query: search.query,
    sourceUrl: search.source_url || '',
    site: search.site || '',
    createdAt: search.created_at,
    options: (opts || []) as Opt[],
  });

  return new Response(bytes, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="options-${searchId.slice(0,8)}.pdf"`,
      'Cache-Control': 'private, max-age=60',
    },
  });
}

// ─── handleEmail ───────────────────────────────────────────
async function handleEmail(svc: ReturnType<typeof createServiceClient>, searchId: string, toEmail: string, note: string) {
  if (!searchId || !toEmail) return json({ error: 'searchId + toEmail required' }, 400);
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('RESEND_FROM_EMAIL') || 'Offline <onboarding@resend.dev>';
  if (!apiKey) return json({ error: 'RESEND_API_KEY not set' }, 500);

  // Build PDF
  const pdfRes = await handlePdf(svc, searchId);
  if (!pdfRes.ok) return pdfRes;
  const pdfBytes = new Uint8Array(await pdfRes.arrayBuffer());
  const b64 = base64Encode(pdfBytes);

  const { data: search } = await svc.from('customer_product_searches')
    .select('customer_id, query, source_url').eq('id', searchId).maybeSingle();
  const { data: customer } = search ? await svc.from('customers').select('full_name').eq('id', search.customer_id).maybeSingle() : { data: null };

  const subject = `Your product options — ${search?.query?.slice(0, 60) || 'from Offline'}`;
  const html = `
    <div style="font-family:Arial,sans-serif;color:#1a1a2e;max-width:560px">
      <h2 style="color:#1a3a8a;margin:0 0 10px">Product options for you</h2>
      <p>Hi ${escapeHtml(customer?.full_name || 'there')},</p>
      <p>Here is the list of options your Offline representative put together for you based on what we discussed${search?.query ? `: <strong>${escapeHtml(search.query)}</strong>` : ''}.</p>
      ${note ? `<p style="background:#f5f7ff;padding:12px;border-radius:6px">${escapeHtml(note)}</p>` : ''}
      <p>The PDF is attached. Just tell us the <strong>option number</strong> you want and we will open it right up for you.</p>
      <p style="color:#6b6b85;font-size:13px">— Offline support</p>
    </div>`;

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: [toEmail], subject, html,
      attachments: [{ filename: `product-options-${searchId.slice(0,8)}.pdf`, content: b64 }],
    }),
  });
  if (!resendRes.ok) {
    const txt = await resendRes.text();
    return json({ error: 'resend failed', status: resendRes.status, detail: txt }, 502);
  }
  const resendJson = await resendRes.json();

  await svc.from('customer_product_searches')
    .update({ sent_email: toEmail, sent_at: new Date().toISOString() })
    .eq('id', searchId);

  return json({ ok: true, emailId: resendJson.id });
}

// ─── handleOpen ───────────────────────────────────────────
async function handleOpen(svc: ReturnType<typeof createServiceClient>, searchId: string, optionNumber: number) {
  if (!searchId || !optionNumber) return json({ error: 'searchId + optionNumber required' }, 400);
  const { data: opt } = await svc.from('customer_product_options')
    .select('product_url, search_id').eq('search_id', searchId).eq('option_number', optionNumber).maybeSingle();
  if (!opt?.product_url) return json({ error: 'option not found' }, 404);

  const { data: search } = await svc.from('customer_product_searches').select('customer_id').eq('id', searchId).maybeSingle();
  if (!search) return json({ error: 'search not found' }, 404);

  const { data: session } = await svc.from('customer_browser_sessions')
    .select('connect_url').eq('customer_id', search.customer_id).eq('status', 'active')
    .order('started_at', { ascending: false }).limit(1).maybeSingle();
  if (!session?.connect_url) return json({ error: 'no active browser session' }, 400);

  try {
    await navigateFirstPage(session.connect_url, opt.product_url);
  } catch (err) {
    return json({ error: 'navigate failed', detail: String((err as Error).message) }, 502);
  }
  return json({ ok: true, url: opt.product_url });
}

// ─── helpers ───
function base64Encode(bytes: Uint8Array): string {
  // chunked to avoid stack overflow for large PDFs
  const CHUNK = 0x8000; let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c] as string));
}

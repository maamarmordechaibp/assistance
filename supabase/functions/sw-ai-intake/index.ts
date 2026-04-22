// Edge Function: sw-ai-intake
// Conducts a short AI-driven voice intake conversation before transferring to a rep.
// Uses SignalWire <Gather input="speech"> for voice input + GPT-4o-mini for dialogue.
//
// URL params across turns:
//   customerId  — customer UUID
//   turn        — 0-based turn counter
//   silence     — consecutive silent-turn count (for fallback handling)
//   ctx         — base64(JSON) of conversation messages so far (user+assistant only)
//   hint        — customer name (compact, avoids re-fetching on every turn)
//   retryQ      — last question text, for re-asking after silence
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import * as laml from '../_shared/laml.ts';

const MAX_TURNS = 8;
const MAX_SILENCE_RETRIES = 2;

// If the customer says any of these, skip intake and go straight to rep
const OPT_OUT_KEYWORDS = [
  'representative', 'agent', 'person', 'skip', 'transfer',
  'human', 'operator', 'real person', 'speak to someone',
];

// Conversational intake prompt. GPT decides each turn whether it has enough
// context to hand off to a rep, or needs to ask a natural follow-up.
// Offline covers: shopping, bill payments, account help, form support, and
// general online task assistance — NOT shopping only.
const TURN_PROMPT = `You are a warm, human-sounding phone intake assistant for Offline — a live support service that helps customers with online tasks like shopping, bill payments, account assistance, and filling out forms.

YOUR JOB: Carry a natural, human conversation to understand exactly what the caller needs BEFORE we hand them to a live representative.

CRITICAL RULES:
- Use common sense. If the caller trails off mid-sentence (for example "I want to fill out…"), ASK what they want to fill out — do NOT assume they're done.
- Ask ONE short follow-up at a time (under 15 words). Sound like a real person, not a form.
- Keep gathering details until you have BOTH: (a) the task type and (b) enough specifics that a representative could start working immediately.
- Typical specifics to gather depending on the task:
  • Shopping → item, budget, brand/size/color preferences
  • Bill payment → which biller, approximate amount, payment method
  • Account help → which website/service, what needs changing
  • Form / application → which form (name or purpose), any deadline
- Don't over-interrogate. 1–3 follow-ups is usually enough. If the caller sounds frustrated or repeats themselves, finish.
- If the caller asks for a person / representative / agent at any point, set done=true immediately.

OUTPUT FORMAT — respond with valid JSON ONLY in one of these two shapes:
1. Need more info → {"done": false, "question": "your short natural follow-up question"}
2. Enough info → {"done": true, "summary": "one-sentence summary of what the caller needs"}`;

// Used by generateBrief() with gpt-4o for high-quality shopping expertise
const BRIEF_PROMPT = `You are an expert personal shopping assistant with deep product knowledge. Generate a concise shopping brief for a human representative based on what the customer said.

YOUR KNOWLEDGE BASE:
- Office furniture: budget desks $50-$150 (Amazon Basics, VIVO, Flash Furniture), mid-range $150-$400 (Sauder, Linon), standing desks $200-$600 (FlexiSpot, Uplift, Autonomous)
- Laptops: budget $200-$500 (Acer Aspire, Lenovo IdeaPad, HP Stream), mid $500-$900 (Dell Inspiron, Lenovo IdeaPad 5, HP Envy), premium $900+ (MacBook Air M2, Dell XPS, ThinkPad X1)
- Monitors: budget $100-$200 (AOC, Acer), mid $200-$500 (LG IPS, Dell IPS), gaming $300+ (ASUS ROG, LG UltraGear, MSI)
- Smartphones: budget $100-$300 (Motorola Moto G, Samsung A-series), mid $300-$600 (Google Pixel 7a, iPhone SE), premium $600+ (iPhone 15, Samsung Galaxy S24)
- TVs: budget $200-$400 (TCL 5-series, Hisense U6), mid $400-$800 (Samsung Crystal, LG OLED A-series), premium $800+ (Sony Bravia XR, LG OLED C-series)
- Clothing/shoes: check sizing charts; Nike, Adidas on their own sites; budget fashion on Shein/Amazon; quality brands on Nordstrom/Zappos

PLATFORM STRATEGY:
- Amazon: sort by Avg Customer Review, filter 4+ stars, check "ships from Amazon" for easy returns
- Wayfair/IKEA: best for furniture under $300; always check assembly reviews
- Best Buy: use for electronics in-store price match; check open-box deals
- eBay/Back Market: refurbished electronics at 20-40% discount
- Walmart.com: great for budget items with free pickup

Generate the JSON brief:
{"category": "electronics|furniture|clothing|services|travel|food|government|financial|other", "brief": "1-2 sentence summary including the specific item, budget if mentioned, and any preferences", "suggestions": {"search_terms": ["3 specific search terms — include price constraints, brand hints, or specs"], "platforms": ["2-3 best platforms for this exact purchase"], "rep_tip": "ONE actionable tip: example search query + recommended brand + where to find best deal"}}

Keep brief under 80 words. Respond with valid JSON only.`;

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const formData = await req.formData();
  const callSid = formData.get('CallSid') as string;
  const speechResult = ((formData.get('SpeechResult') as string) || '').trim();
  const confidence  = parseFloat((formData.get('Confidence') as string) || '1');

  const url         = new URL(req.url);
  const customerId  = url.searchParams.get('customerId') || '';
  const turn        = parseInt(url.searchParams.get('turn')    || '0', 10);
  const silenceCount = parseInt(url.searchParams.get('silence') || '0', 10);
  const ctxParam    = url.searchParams.get('ctx')    || '';
  const hintName    = url.searchParams.get('hint')   || '';
  const retryQuestion = url.searchParams.get('retryQ') || '';

  const supabase  = createServiceClient();
  const baseUrl   = `${Deno.env.get('SUPABASE_URL')!}/functions/v1`;
  const openaiKey = Deno.env.get('OPENAI_API_KEY')!;

  console.log(`[sw-ai-intake] sid=${callSid} turn=${turn} silence=${silenceCount} speech="${speechResult.slice(0, 80)}"`);

  // ── Types ──────────────────────────────────────────────────
  type Message = { role: string; content: string };
  interface GptDoneResult {
    done: true;
    category?: string;
    brief?: string;
    suggestions?: {
      search_terms?: string[];
      platforms?: string[];
      rep_tip?: string;
    };
  }

  // ── Decode conversation context ────────────────────────────
  // Context is stored as Unicode-safe base64 to handle accented chars in speech
  let messages: Message[] = [];
  if (ctxParam) {
    try {
      messages = JSON.parse(decodeURIComponent(escape(atob(ctxParam))));
    } catch { /* start fresh if corrupt */ }
  }

  // ── Helper: encode context to URL-safe base64 ─────────────
  function encodeCtx(msgs: Message[]): string {
    return btoa(unescape(encodeURIComponent(JSON.stringify(msgs))));
  }

  // ── Helper: save brief to calls, redirect to connect-rep ──
  async function transferToRep(brief: unknown): Promise<Response> {
    if (brief !== null && customerId) {
      await supabase
        .from('calls')
        .update({ ai_intake_brief: brief, ai_intake_completed: true })
        .eq('call_sid', callSid);
    }
    const category = (brief as { category?: string })?.category || '';
    const connectUrl = `${baseUrl}/sw-inbound?step=connect-rep&customerId=${customerId}${category ? `&category=${encodeURIComponent(category)}` : ''}`;
    return new Response(
      laml.buildLamlResponse([
        laml.say('Thank you. Connecting you to a representative now.'),
        laml.redirect(connectUrl),
      ]),
      { headers: { 'Content-Type': 'application/xml' } }
    );
  }

  // ── Helper: run one conversational turn — GPT returns either a follow-up
  //   question or { done:true, summary } when it has enough context. ──
  type TurnResult = { done: false; question: string } | { done: true; summary: string };
  async function callGptTurn(msgs: Message[]): Promise<TurnResult> {
    const payload = [{ role: 'system', content: TURN_PROMPT }, ...msgs];
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: payload,
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 120,
      }),
    });
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || '{"done":false,"question":"Could you tell me a bit more about what you need today?"}';
    const parsed = JSON.parse(raw);
    if (parsed.done === true) {
      return { done: true, summary: String(parsed.summary || '').slice(0, 300) };
    }
    return {
      done: false,
      question: String(parsed.question || 'Could you tell me a bit more about what you need today?').slice(0, 200),
    };
  }

  // ── Helper: generate expert shopping brief (gpt-4o — full model with product knowledge) ──
  async function generateBrief(msgs: Message[]): Promise<GptDoneResult> {
    const payload = [
      { role: 'system', content: BRIEF_PROMPT },
      ...msgs,
      { role: 'user', content: 'Generate the shopping brief now based on what the customer told you.' },
    ];
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: payload,
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 500,
      }),
    });
    const data = await res.json();
    const result = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    return {
      done: true as const,
      category: result.category || 'other',
      brief: result.brief || 'Customer needs assistance finding a product.',
      suggestions: result.suggestions || {},
    };
  }

  // ── Helper: build Gather+Redirect pair for a question ─────
  function askQuestion(question: string, nextTurn: number, ctx: string, nextSilence: number, retryQ: string): string[] {
    const enc = encodeURIComponent;
    const actionUrl   = `${baseUrl}/sw-ai-intake?customerId=${enc(customerId)}&turn=${nextTurn}&ctx=${enc(ctx)}&hint=${enc(hintName)}`;
    const fallbackUrl = `${baseUrl}/sw-ai-intake?customerId=${enc(customerId)}&turn=${nextTurn}&silence=${nextSilence + 1}&ctx=${enc(ctx)}&hint=${enc(hintName)}&retryQ=${enc(retryQ || question)}`;
    return [
      laml.gatherSpeech({ action: actionUrl, timeout: 8 }, [laml.say(question)]),
      laml.redirect(fallbackUrl),
    ];
  }

  // ────────────────────────────────────────────────────────────
  // TURN 0 — Opening announcement + first question from GPT
  // ────────────────────────────────────────────────────────────
  if (turn === 0) {
    // Fetch customer name & preferences for personalisation
    let customerName = '';
    let lastCallCategory = '';
    let typicalBudget    = '';

    if (customerId) {
      const { data: cust } = await supabase
        .from('customers')
        .select('full_name, preferences')
        .eq('id', customerId)
        .single();

      if (cust) {
        customerName = (cust.full_name || '').startsWith('Caller ') ? '' : (cust.full_name || '');
        const prefs = (cust.preferences as Record<string, string>) || {};
        lastCallCategory = prefs.last_call_category || '';
        typicalBudget    = prefs.typical_budget     || '';
      }
    }

    // Build minimal context for GPT to generate first question
    const initUserMsg = [
      customerName ? `Customer name: ${customerName}.` : 'New caller.',
      lastCallCategory ? `Their last call topic: ${lastCallCategory}.` : '',
      typicalBudget    ? `Their typical budget: ${typicalBudget}.` : '',
      'Ask a warm, brief opening question to understand what they need today.',
    ].filter(Boolean).join(' ');

    let firstQuestion = 'How can we help you today?';
    try {
      const first = await callGptTurn([{ role: 'user', content: initUserMsg }]);
      if (!first.done) firstQuestion = first.question;
    } catch { /* use default */ }

    // Seed the context with the first assistant message
    const seedMessages: Message[] = [
      { role: 'assistant', content: JSON.stringify({ done: false, question: firstQuestion }) },
    ];
    const encodedCtx = encodeCtx(seedMessages);

    const nameHint = customerName.slice(0, 40); // keep URL param compact
    const greeting  = customerName
      ? lastCallCategory
        ? `Welcome back, ${customerName}. Last time you needed help with ${lastCallCategory}.`
        : `Welcome back, ${customerName}.`
      : 'Welcome.';

    const opening = `${greeting} Before connecting you, I'll ask a couple of quick questions so your representative knows exactly what you need. You can say "representative" at any time to connect right away.`;

    return new Response(
      laml.buildLamlResponse([
        laml.say(opening),
        laml.pause(1),
        ...askQuestion(firstQuestion, 1, encodedCtx, 0, firstQuestion),
      ].map(s => s).filter(s => typeof s === 'string') as string[]),
      { headers: { 'Content-Type': 'application/xml' } }
    );
  }

  // ────────────────────────────────────────────────────────────
  // TURNS >= 1 — Process speech, continue or finish
  // ────────────────────────────────────────────────────────────

  // Check for silence / inaudible speech
  const noSpeech = !speechResult || confidence < 0.15;
  if (noSpeech) {
    if (silenceCount >= MAX_SILENCE_RETRIES) {
      // Give up on intake — transfer to rep without a brief
      return await transferToRep(null);
    }
    const q = retryQuestion || 'What can I help you with today?';
    return new Response(
      laml.buildLamlResponse(
        askQuestion(`Sorry, I didn't quite catch that. ${q}`, turn, ctxParam, silenceCount, q)
      ),
      { headers: { 'Content-Type': 'application/xml' } }
    );
  }

  // Check opt-out — customer wants a human now
  const lower = speechResult.toLowerCase();
  if (OPT_OUT_KEYWORDS.some(kw => lower.includes(kw))) {
    return await transferToRep(null);
  }

  // Append customer's spoken answer to context
  messages.push({ role: 'user', content: speechResult });

  // ── GPT decides when we have enough info. Hard cap at MAX_TURNS so we never
  //    loop forever. ──────────────────────────────────────────────────────────
  let turnResult: TurnResult;
  try {
    turnResult = await callGptTurn(messages);
  } catch (err) {
    console.error('[sw-ai-intake] callGptTurn error:', err);
    // On error, finish up and hand off rather than re-prompting indefinitely.
    turnResult = { done: true, summary: speechResult };
  }
  const shouldFinishNow = turnResult.done || turn >= MAX_TURNS - 1;

  // Shared helper: look up past findings + build full brief + transfer to rep
  async function finishWithBrief(doneResult: GptDoneResult): Promise<Response> {
    let previousFinding = null;
    const searchText = [
      doneResult.brief || '',
      ...(doneResult.suggestions?.search_terms || []),
    ]
      .join(' ')
      .replace(/[^a-zA-Z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((w: string) => w.length > 3)
      .slice(0, 6)
      .join(' ');

    if (searchText && customerId) {
      try {
        const { data: found } = await supabase
          .from('call_findings')
          .select('description, item_url, item_price, item_platform, item_notes, created_at')
          .textSearch('description', searchText, { type: 'websearch', config: 'english' })
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        previousFinding = found ? {
          description: found.description,
          url: found.item_url,
          price: found.item_price,
          platform: found.item_platform,
          notes: found.item_notes,
          found_at: found.created_at,
        } : null;
      } catch { /* skip if search fails */ }
    }

    const brief = {
      category: doneResult.category || 'other',
      summary: doneResult.brief || 'Customer needs assistance.',
      suggestions: doneResult.suggestions || {},
      previous_finding: previousFinding,
    };
    return await transferToRep(brief);
  }

  if (shouldFinishNow) {
    // Generate expert brief using gpt-4o (knows products, prices, platforms, strategies)
    let doneResult: GptDoneResult;
    try {
      doneResult = await generateBrief(messages);
    } catch (err) {
      console.error('[sw-ai-intake] Brief generation error:', err);
      return await transferToRep(null);
    }
    return await finishWithBrief(doneResult);
  }

  // Not done yet — ask the follow-up question GPT produced and continue.
  const nextQuestion = (turnResult as { done: false; question: string }).question;
  messages.push({ role: 'assistant', content: JSON.stringify({ done: false, question: nextQuestion }) });

  const newCtx = encodeCtx(messages);
  return new Response(
    laml.buildLamlResponse(
      askQuestion(nextQuestion, turn + 1, newCtx, 0, nextQuestion)
    ),
    { headers: { 'Content-Type': 'application/xml' } }
  );
});

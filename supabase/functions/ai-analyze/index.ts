// Edge Function: ai-analyze (POST GPT-4o-mini call analysis)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';

const SYSTEM_PROMPT = `You are a call quality analyst for a live phone assistance service. 
Customers call in to get help with online tasks like shopping, filling applications, account help, scheduling, bill payment, and general internet assistance.

ABSOLUTE NO-FABRICATION RULE: Use ONLY facts that literally appear in the transcript provided. NEVER infer a category, item, or context that wasn't said. If the transcript mentions "back wheel", do NOT assume "car wheel" or "bike wheel" — say "replacement back wheel". If a recording transcript is absent (transcript_source = intake_brief_only), you have NOT heard the actual conversation — you ONLY have what the intake AI claimed and what the rep typed in their notes. In that case do not judge the rep at all.

Analyze the provided call transcript and return a JSON object with these fields:
- ai_summary: A concise 2-3 sentence summary of what happened in the call
- ai_category: The primary task category (online_shopping, application_filling, account_help, scheduling, bill_payment, government_forms, general_online_help, other)
- ai_success_status: "successful" if the customer's issue was fully resolved, "partially_successful" if some progress was made, "unsuccessful" if the issue was not resolved
- ai_sentiment: The customer's overall sentiment: "positive", "neutral", or "negative"
- ai_followup_needed: true if the call indicates a follow-up is needed
- ai_wasted_time_flag: true if the representative appeared to waste time, stall, use excessive filler, or drag out the call unnecessarily
- ai_flag_reason: If ai_wasted_time_flag is true, explain why. Otherwise null.
- ai_confidence_score: Your confidence in this analysis from 0.0 to 1.0
- item_found: true if the rep found a specific product or resource for the customer (a URL, a product, a form link, etc.)
- item_description: If item_found is true, a short description of what was found (e.g. "Dell Inspiron 15 laptop 12GB RAM"). Otherwise null.
- item_price: If item_found is true and a price was mentioned, the price as a string (e.g. "$449.99"). Otherwise null.
- item_url: If item_found is true and a URL was mentioned or implied, extract it. Otherwise null.
- item_platform: If item_found is true, the platform or store where it was found (e.g. "Amazon", "Best Buy", "SSA.gov"). Otherwise null.
- item_notes: If item_found is true, any useful notes about the item (availability, delivery, tips). Otherwise null.
- item_search_terms: If item_found is true, 2-4 specific search keywords that would find this item again. Otherwise an empty array [].

Be objective and fair. Flag wasted time only when there is clear evidence of unnecessary delays, excessive small talk unrelated to the task, or the rep clearly stalling.`;

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const body = await req.json();
  const { callId } = body;

  if (!callId) {
    return new Response(JSON.stringify({ error: 'callId required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const supabase = createServiceClient();

  const { data: call } = await supabase
    .from('calls')
    .select(`*, task_category:task_categories(name)`) 
    .eq('id', callId)
    .maybeSingle();

  if (!call) {
    return new Response(JSON.stringify({ error: 'Call not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // Look up benchmark for this call's task category (separate query because
  // task_benchmarks references calls only indirectly via task_category_id).
  let benchmark: { expected_min_minutes: number | null; expected_max_minutes: number | null } | null = null;
  if (call.task_category_id) {
    const { data: bench } = await supabase
      .from('task_benchmarks')
      .select('expected_min_minutes, expected_max_minutes')
      .eq('task_category_id', call.task_category_id)
      .maybeSingle();
    benchmark = bench || null;
  }

  if (!call.transcript_text) {
    return new Response(JSON.stringify({ error: 'No transcript available yet' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  try {
    const openaiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiKey) {
      return new Response(JSON.stringify({ error: 'OpenAI API key not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const durationMinutes = Math.round((call.total_duration_seconds || 0) / 60);

    // Determine the QUALITY of the input we're working with. If we never got
    // a real audio transcript (recording failed / SignalWire didn't return
    // one in time), the only "transcript" we have is the AI intake brief and
    // the rep's notes. In that case the model MUST NOT judge rep performance,
    // sentiment, or wasted time — it has no actual dialogue to evaluate.
    const transcript = call.transcript_text as string;
    const hasRealAudio = /CALL AUDIO TRANSCRIPT:/i.test(transcript);
    const transcriptSource = hasRealAudio
      ? 'whisper_audio'
      : 'intake_brief_only';

    let userPrompt = `Call transcript:\n${transcript}\n\nCall duration: ${durationMinutes} minutes\n`;
    userPrompt += `Transcript source: ${transcriptSource}\n`;
    if (!hasRealAudio) {
      userPrompt += `\nIMPORTANT: There is NO recorded audio transcript for this call — only the AI intake summary and the rep's own notes. You have NOT seen what was actually said between the rep and customer. Therefore:\n` +
        `  • Do NOT judge rep performance, fluency, or wasted time. Set ai_wasted_time_flag=false.\n` +
        `  • Set ai_sentiment to "neutral" and ai_success_status to "partially_successful" unless rep notes or findings clearly prove otherwise.\n` +
        `  • Set ai_confidence_score to AT MOST 0.4.\n` +
        `  • Your ai_summary MUST start with "[no audio]" and only describe the stated request — do NOT invent context (do not add "for a car", "for a child", etc. unless those words literally appear).\n`;
    }
    if (call.task_category?.name) userPrompt += `Assigned task category: ${call.task_category.name}\n`;
    if (benchmark?.expected_min_minutes && benchmark?.expected_max_minutes) {
      userPrompt += `Expected duration range: ${benchmark.expected_min_minutes}-${benchmark.expected_max_minutes} minutes\n`;
    }
    if (call.extensions_used > 0) userPrompt += `The representative extended the call ${call.extensions_used} time(s) beyond the time limit.\n`;
    userPrompt += `\nAnalyze this call and return a JSON object with the required fields.`;

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 1200,
      }),
    });

    const openaiData = await openaiRes.json();
    const content = openaiData.choices?.[0]?.message?.content;
    if (!content) throw new Error('No response from OpenAI');

    const result = JSON.parse(content);
    // Be tolerant: don't throw if a few fields are missing — fill in safe defaults
    // so we always produce SOMETHING instead of leaving the call analysis blank.
    if (!result.ai_summary) {
      result.ai_summary = (call.transcript_text as string).slice(0, 280);
    }
    if (!result.ai_success_status) result.ai_success_status = 'partially_successful';
    if (!result.ai_sentiment) result.ai_sentiment = 'neutral';

    // Save analysis (includes new item_* fields)
    const { data: analysis, error } = await supabase
      .from('call_analyses')
      .upsert({ call_id: callId, ...result }, { onConflict: 'call_id' })
      .select()
      .single();

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // Auto-flag call if AI detected wasted time
    if (result.ai_wasted_time_flag) {
      await supabase.from('calls').update({
        flag_status: 'flagged',
        flag_reason: result.ai_flag_reason || 'AI detected potential wasted time',
      }).eq('id', callId);
    }

    // ── Auto-save to call_findings if a specific item was found ──
    if (result.item_found && result.item_description) {
      await supabase.from('call_findings').insert({
        call_id: callId,
        customer_id: call.customer_id || null,
        rep_id: call.rep_id || null,
        description: result.item_description,
        item_url: result.item_url || null,
        item_price: result.item_price || null,
        item_platform: result.item_platform || null,
        item_notes: result.item_notes || null,
        search_terms: result.item_search_terms || [],
        source: 'ai_auto',
      }).then(() => {}).catch((e: unknown) => console.error('[ai-analyze] findings insert error:', e));
    }

    // ── Update customer preference profile ──
    if (call.customer_id && result.ai_category) {
      // Fetch current preferences
      const { data: custData } = await supabase
        .from('customers')
        .select('preferences')
        .eq('id', call.customer_id)
        .single();

      const prefs = (custData?.preferences as Record<string, unknown>) || {};

      // Update last_call_category and refine typical_budget if a price was mentioned
      const updatedPrefs: Record<string, unknown> = {
        ...prefs,
        last_call_category: result.ai_category,
        last_call_date: new Date().toISOString(),
      };
      if (result.item_price && !prefs.typical_budget) {
        updatedPrefs.typical_budget = result.item_price;
      }

      await supabase
        .from('customers')
        .update({ preferences: updatedPrefs })
        .eq('id', call.customer_id)
        .then(() => {})
        .catch((e: unknown) => console.error('[ai-analyze] preferences update error:', e));
    }

    return new Response(JSON.stringify(analysis), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('AI analysis error:', err);
    return new Response(JSON.stringify({ error: 'Analysis failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});

// Edge Function: ai-analyze (POST GPT-4o-mini call analysis)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';

const SYSTEM_PROMPT = `You are a call quality analyst for a live phone assistance service. 
Customers call in to get help with online tasks like shopping, filling applications, account help, scheduling, bill payment, and general internet assistance.

Analyze the provided call transcript and return a JSON object with these fields:
- ai_summary: A concise 2-3 sentence summary of what happened in the call
- ai_category: The primary task category (online_shopping, application_filling, account_help, scheduling, bill_payment, government_forms, general_online_help, other)
- ai_success_status: "successful" if the customer's issue was fully resolved, "partially_successful" if some progress was made, "unsuccessful" if the issue was not resolved
- ai_sentiment: The customer's overall sentiment: "positive", "neutral", or "negative"
- ai_followup_needed: true if the call indicates a follow-up is needed
- ai_wasted_time_flag: true if the representative appeared to waste time, stall, use excessive filler, or drag out the call unnecessarily
- ai_flag_reason: If ai_wasted_time_flag is true, explain why. Otherwise null.
- ai_confidence_score: Your confidence in this analysis from 0.0 to 1.0

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
    .select(`*, task_category:task_categories(name), task_benchmark:task_benchmarks(expected_min_minutes, expected_max_minutes)`)
    .eq('id', callId)
    .single();

  if (!call) {
    return new Response(JSON.stringify({ error: 'Call not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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
    let userPrompt = `Call transcript:\n${call.transcript_text}\n\nCall duration: ${durationMinutes} minutes\n`;
    if (call.task_category?.name) userPrompt += `Assigned task category: ${call.task_category.name}\n`;
    if (call.task_benchmark?.expected_min_minutes && call.task_benchmark?.expected_max_minutes) {
      userPrompt += `Expected duration range: ${call.task_benchmark.expected_min_minutes}-${call.task_benchmark.expected_max_minutes} minutes\n`;
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
        max_tokens: 1000,
      }),
    });

    const openaiData = await openaiRes.json();
    const content = openaiData.choices?.[0]?.message?.content;
    if (!content) throw new Error('No response from OpenAI');

    const result = JSON.parse(content);
    if (!result.ai_summary || !result.ai_success_status || !result.ai_sentiment) {
      throw new Error('Incomplete analysis result from AI');
    }

    // Save analysis
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

    return new Response(JSON.stringify(analysis), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('AI analysis error:', err);
    return new Response(JSON.stringify({ error: 'Analysis failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});

// Edge Function: sw-transcription (Whisper transcription, save transcript)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase.ts';

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const body = await req.json();
  const { callId, voicemailId, storagePath } = body;

  if ((!callId && !voicemailId) || !storagePath) {
    return new Response(JSON.stringify({ error: 'Missing callId/voicemailId or storagePath' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const supabase = createServiceClient();

  try {
    // Download from Supabase Storage
    const { data: fileData, error: downloadError } = await supabase.storage.from('call-recordings').download(storagePath);
    if (downloadError || !fileData) {
      return new Response(JSON.stringify({ error: 'Failed to download recording' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const openaiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiKey) {
      return new Response(JSON.stringify({ error: 'OpenAI API key not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    // Transcribe with Whisper via direct API call (Deno-compatible)
    const formData = new FormData();
    formData.append('file', new File([fileData], 'recording.wav', { type: 'audio/wav' }));
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'text');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiKey}` },
      body: formData,
    });

    const transcription = (await whisperRes.text()).trim();

    if (callId) {
      // Build a rich transcript: whisper audio + AI intake summary +
      // rep notes + findings — so the post-call analysis has real
      // material to work with even when audio quality is poor.
      const { data: full } = await supabase
        .from('calls')
        .select('rep_notes, ai_intake_brief')
        .eq('id', callId)
        .maybeSingle();

      const parts: string[] = [];
      if (transcription) parts.push(`CALL AUDIO TRANSCRIPT:\n${transcription}`);
      const brief = full?.ai_intake_brief as Record<string, unknown> | null;
      if (brief) {
        const summary = brief.summary as string | undefined;
        const category = brief.category as string | undefined;
        if (summary) parts.push(`AI INTAKE SUMMARY (category=${category || 'other'}): ${summary}`);
        const sug = brief.suggestions as Record<string, unknown> | undefined;
        if (sug && Array.isArray(sug.search_terms) && sug.search_terms.length) {
          parts.push(`Intake search terms: ${(sug.search_terms as string[]).join(', ')}`);
        }
      }
      if (full?.rep_notes) parts.push(`REPRESENTATIVE NOTES:\n${full.rep_notes}`);
      const { data: findings } = await supabase
        .from('call_findings')
        .select('description, item_url, item_price, item_platform, item_notes')
        .eq('call_id', callId);
      if (findings && findings.length) {
        parts.push('FINDINGS LOGGED BY REP:');
        for (const f of findings) {
          parts.push(`- ${f.description}${f.item_price ? ` (${f.item_price})` : ''}${f.item_platform ? ` on ${f.item_platform}` : ''}${f.item_url ? ` — ${f.item_url}` : ''}${f.item_notes ? ` — ${f.item_notes}` : ''}`);
        }
      }
      const combined = parts.join('\n\n');

      await supabase.from('calls').update({ transcript_text: combined }).eq('id', callId);

      // Re-trigger ai-analyze now that we have the full audio transcript.
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      fetch(`${supabaseUrl}/functions/v1/ai-analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
        body: JSON.stringify({ callId }),
      }).catch((e) => console.error('[sw-transcription] ai-analyze kickoff failed:', e));
    }
    if (voicemailId) {
      await supabase.from('voicemails').update({ transcript_text: transcription }).eq('id', voicemailId);
    }

    return new Response(JSON.stringify({ ok: true, transcript: transcription }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('Transcription error:', err);
    return new Response(JSON.stringify({ error: 'Transcription failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});

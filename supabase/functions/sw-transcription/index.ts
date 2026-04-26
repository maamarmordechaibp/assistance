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
      await supabase.from('calls').update({ transcript_text: transcription }).eq('id', callId);
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

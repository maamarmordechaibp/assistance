// Edge Function: sw-recording-complete (download recording → storage, trigger transcription)
//
// Two modes:
//   1) Webhook mode (form-data from SignalWire): expects CallSid, RecordingUrl, RecordingSid.
//   2) Backfill mode (JSON {callId}): pulls the recording list from SignalWire
//      for that call, downloads the most recent recording, and stores it.
//      Used by the admin UI to recover recordings when the webhook never fired.
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { downloadRecording, listRecordingsForCall, buildRecordingMediaUrl } from '../_shared/signalwire.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const supabase = createServiceClient();
  const contentType = req.headers.get('content-type') || '';

  // ── Backfill mode: { callId } JSON body ──
  if (contentType.includes('application/json')) {
    let body: { callId?: string } = {};
    try { body = await req.json(); } catch { /* ignore */ }
    if (!body.callId) {
      return new Response(JSON.stringify({ error: 'callId required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { data: call } = await supabase
      .from('calls')
      .select('id, call_sid, recording_storage_path')
      .eq('id', body.callId)
      .maybeSingle();
    if (!call) {
      return new Response(JSON.stringify({ error: 'Call not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (!call.call_sid) {
      return new Response(JSON.stringify({ error: 'Call has no SignalWire SID' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    try {
      const recordings = await listRecordingsForCall(call.call_sid);
      if (recordings.length === 0) {
        return new Response(JSON.stringify({ error: 'No recordings found in SignalWire for this call' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      // Most recent first
      recordings.sort((a, b) => new Date(b.date_created).getTime() - new Date(a.date_created).getTime());
      const rec = recordings[0];
      const mediaUrl = buildRecordingMediaUrl(rec.sid);
      const audioBuffer = await downloadRecording(mediaUrl);
      const storagePath = `recordings/${call.id}/${rec.sid}.wav`;

      const { error: uploadError } = await supabase.storage
        .from('call-recordings')
        .upload(storagePath, audioBuffer, { contentType: 'audio/wav', upsert: true });
      if (uploadError) {
        return new Response(JSON.stringify({ error: 'Storage upload failed: ' + uploadError.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      await supabase.from('calls').update({
        recording_url: mediaUrl,
        recording_storage_path: storagePath,
      }).eq('id', call.id);

      // Fire-and-forget transcription
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      fetch(`${supabaseUrl}/functions/v1/sw-transcription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
        body: JSON.stringify({ callId: call.id, storagePath }),
      }).catch(() => {});

      return new Response(JSON.stringify({ ok: true, recordingSid: rec.sid, storagePath, durationSeconds: Number(rec.duration) || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[sw-recording-complete] backfill error:', msg);
      return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
  }

  // ── Webhook mode: form-data from SignalWire ──
  const formData = await req.formData();
  const callSid = formData.get('CallSid') as string;
  const recordingUrl = formData.get('RecordingUrl') as string;
  const recordingSid = formData.get('RecordingSid') as string;

  const { data: call } = await supabase.from('calls').select('id, customer_id').eq('call_sid', callSid).single();
  if (!call) {
    return new Response(JSON.stringify({ error: 'Call not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const audioBuffer = await downloadRecording(recordingUrl + '.wav');
    const storagePath = `recordings/${call.id}/${recordingSid}.wav`;

    const { error: uploadError } = await supabase.storage
      .from('call-recordings')
      .upload(storagePath, audioBuffer, { contentType: 'audio/wav', upsert: true });

    if (uploadError) console.error('Upload error:', uploadError);

    await supabase.from('calls').update({
      recording_url: recordingUrl,
      recording_storage_path: storagePath,
    }).eq('id', call.id);

    // Trigger transcription
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    fetch(`${supabaseUrl}/functions/v1/sw-transcription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
      body: JSON.stringify({ callId: call.id, storagePath }),
    }).catch(() => {});
  } catch (err) {
    console.error('Recording processing error:', err);
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
});

// Edge Function: sw-recording-complete (download recording → storage, trigger transcription)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { downloadRecording } from '../_shared/signalwire.ts';

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const formData = await req.formData();
  const callSid = formData.get('CallSid') as string;
  const recordingUrl = formData.get('RecordingUrl') as string;
  const recordingSid = formData.get('RecordingSid') as string;

  const supabase = createServiceClient();

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

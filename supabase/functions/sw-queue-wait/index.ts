// Edge Function: sw-queue-wait (hold music, position announce, callback offer, served stats)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import * as laml from '../_shared/laml.ts';

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const formData = await req.formData();
  const queuePosition = formData.get('QueuePosition') as string;
  const queueTime = formData.get('QueueTime') as string;

  const supabase = createServiceClient();
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const baseUrl = `${supabaseUrl}/functions/v1`;

  // Fetch queue settings
  const { data: settings } = await supabase
    .from('admin_settings')
    .select('key, value')
    .in('key', ['queue_max_wait_minutes', 'queue_callback_threshold', 'hold_music_url', 'queue_position_announcement']);

  const settingsMap: Record<string, unknown> = {};
  settings?.forEach((s: { key: string; value: unknown }) => { settingsMap[s.key] = s.value; });

  const maxWait = Number(settingsMap.queue_max_wait_minutes) || 15;
  const callbackThreshold = Number(settingsMap.queue_callback_threshold) || 3;
  const holdMusicUrl = (settingsMap.hold_music_url as string) || '';
  const announcePosition = settingsMap.queue_position_announcement !== false;
  const queueTimeSeconds = parseInt(queueTime || '0', 10);
  const position = parseInt(queuePosition || '1', 10);

  // Count customers served in the last 24 hours
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: servedToday } = await supabase
    .from('calls')
    .select('*', { count: 'exact', head: true })
    .gte('started_at', oneDayAgo)
    .not('ended_at', 'is', null);

  const elements: string[] = [];

  if (queueTimeSeconds > maxWait * 60 || position > callbackThreshold) {
    elements.push(
      laml.gather(
        { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-callback-choice`, timeout: 10 },
        [laml.say(`You are currently number ${position} in the queue. The estimated wait time is longer than usual. Press 1 to receive a callback instead of waiting, or press 2 to continue holding.`)]
      )
    );
  } else if (announcePosition) {
    elements.push(laml.say(`You are currently number ${position} in the queue. Please hold and a representative will be with you shortly.`));
  }

  // Play hold music
  if (holdMusicUrl) {
    elements.push(laml.play(holdMusicUrl));
  } else {
    // Default gentle hold music loop with spoken messages
    elements.push(laml.say('Thank you for your patience. Your call is important to us.'));
    elements.push(laml.pause(15));
  }

  // Periodic served-today announcement
  const served = servedToday || 0;
  if (served > 0) {
    elements.push(laml.say(`We have assisted ${served} customers in the last 24 hours. We appreciate your patience and will be with you shortly.`));
  } else {
    elements.push(laml.say('Thank you for holding. A representative will be with you shortly.'));
  }

  // More hold music / pause before SignalWire re-requests the waitUrl
  if (holdMusicUrl) {
    elements.push(laml.play(holdMusicUrl));
  } else {
    elements.push(laml.pause(20));
    elements.push(laml.say('Please continue to hold. Your call will be answered in the order it was received.'));
    elements.push(laml.pause(15));
  }

  const xml = laml.buildLamlResponse(elements);
  return new Response(xml, { headers: { 'Content-Type': 'application/xml' } });
});

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
  // admin_settings.value is stored as JSONB — a bare string setting comes back
  // as the quoted form '"https://..."'. Parse it before using as a URL.
  const rawHoldMusic = settingsMap.hold_music_url;
  let holdMusicUrl = '';
  if (typeof rawHoldMusic === 'string') {
    try {
      const parsed = JSON.parse(rawHoldMusic);
      holdMusicUrl = typeof parsed === 'string' ? parsed : rawHoldMusic;
    } catch {
      holdMusicUrl = rawHoldMusic;
    }
  }
  // Guard against whitespace-only / empty values that would produce <Play></Play>.
  holdMusicUrl = holdMusicUrl.trim();
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

  // Smart estimated wait time: average recent call duration × queue position
  const { data: recentCalls } = await supabase
    .from('calls')
    .select('billable_duration_seconds')
    .not('billable_duration_seconds', 'is', null)
    .gt('billable_duration_seconds', 0)
    .order('ended_at', { ascending: false })
    .limit(20);

  const avgSeconds = recentCalls && recentCalls.length > 0
    ? recentCalls.reduce((sum: number, c: { billable_duration_seconds: number }) => sum + c.billable_duration_seconds, 0) / recentCalls.length
    : 300;
  // When the caller is #1 in queue, no one is ahead of them — the rep
  // typically picks up within seconds, so cap the announced wait at 1 minute.
  // For anyone behind them, fall back to (avg call length × position).
  const estimatedWaitMinutes = position <= 1
    ? 1
    : Math.max(1, Math.ceil((avgSeconds * (position - 1)) / 60));

  const elements: string[] = [];

  if (queueTimeSeconds > maxWait * 60 || position > callbackThreshold) {
    elements.push(
      laml.gather(
        { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-callback-choice`, timeout: 10 },
        [laml.say(`You are currently number ${position} in the queue. Estimated wait is about ${estimatedWaitMinutes} minute${estimatedWaitMinutes === 1 ? '' : 's'}. Press 1 to receive a callback instead of waiting, or press 2 to continue holding.`)]
      )
    );
  } else if (announcePosition) {
    elements.push(laml.say(`You are currently number ${position} in the queue. Estimated wait: about ${estimatedWaitMinutes} minute${estimatedWaitMinutes === 1 ? '' : 's'}. A representative will be with you shortly.`));
  }

  // Play a SHORT music chunk between announcements. SignalWire re-requests
  // this waitUrl after each chunk, so shorter chunks = more frequent
  // position updates ("you are number 2 in queue", etc.). Caller hears the
  // queue status roughly every ~25 seconds instead of every ~2 minutes.
  if (holdMusicUrl) {
    elements.push(laml.play(holdMusicUrl));
  } else {
    elements.push(laml.play('https://cdn.signalwire.com/default-music/welcome.mp3'));
  }

  // Brief reassurance that overrides music — only every other loop to avoid
  // chatter. We use queueTimeSeconds % 60 as a simple parity flag.
  if (queueTimeSeconds > 30 && Math.floor(queueTimeSeconds / 30) % 2 === 0) {
    const served = servedToday || 0;
    if (served > 0) {
      elements.push(laml.say(`Thanks for holding. We've assisted ${served} customers in the last 24 hours. We'll be right with you.`));
    } else {
      elements.push(laml.say('Thanks for holding. A representative will be right with you.'));
    }
  }

  const xml = laml.buildLamlResponse(elements);
  return new Response(xml, { headers: { 'Content-Type': 'application/xml' } });
});

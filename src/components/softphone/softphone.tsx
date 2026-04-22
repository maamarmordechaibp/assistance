'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Phone,
  PhoneOff,
  PhoneIncoming,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Loader2,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { edgeFn } from '@/lib/supabase/edge';

/* SignalWire JS v3 — Call Fabric SDK.
   Architecture note: we do NOT call client.online(). SAT tokens issued
   by /api/fabric/subscribers/tokens reject subscriber.online with -32603
   on v3.30 (see signalwire-legacy-js#1339). Instead, inbound callers are
   parked in SignalWire queues (rep_<id> or 'general') by the sw-inbound
   LaML webhook, which also inserts a call_queue row in Supabase. This
   component subscribes to call_queue via Supabase Realtime, shows an
   incoming ring when a row arrives, and on Answer it:
     1) POSTs to call-claim to atomically reserve the row, then
     2) client.dial({ to: 'queue:<name>' }) — SignalWire bridges us to
        the oldest caller in that queue. */

interface SoftphoneProps {
  token: string | null;
  projectId: string | null;
  host: string | null;
  identity: string | null;
  /** Rep UUID (reps.id == auth.users.id). Needed to filter queue rows. */
  repId: string | null;
  onCallStarted?: (callId: string, fromNumber: string) => void;
  onCallEnded?: () => void;
  /** Called once the client is ready — receives a function to initiate an outbound call */
  onReady?: (makeCall: (toNumber: string) => Promise<void>) => void;
}

type CallState = 'idle' | 'connecting' | 'ringing' | 'active' | 'ending';

interface PendingQueueRing {
  queueId: string;
  queueName: string;
  fromNumber: string;
  callerName: string | null;
}

export default function Softphone({ token, projectId, host, identity, repId, onCallStarted, onCallEnded, onReady }: SoftphoneProps) {
  const [callState, setCallState] = useState<CallState>('idle');
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [duration, setDuration] = useState(0);
  const [callerNumber, setCallerNumber] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionLog, setConnectionLog] = useState<string[]>([]);

  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    console.log(`[Softphone] ${msg}`);
    setConnectionLog(prev => [`${ts} ${msg}`, ...prev].slice(0, 20));
  }, []);

  const clientRef = useRef<unknown>(null);
  const pendingRingRef = useRef<PendingQueueRing | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const callRef = useRef<any>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  // Hidden div where the v3 SDK mounts audio elements for the call
  const audioRootRef = useRef<HTMLDivElement | null>(null);

  // ── SignalWire client init (for outbound dial + answering queues) ──
  useEffect(() => {
    if (!token || !projectId) return;

    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let clientInstance: any = null;

    addLog(`Connecting: project=${projectId} identity=${identity ?? '?'}`);

    async function initClient() {
      try {
        // Dynamic import: WebRTC modules only load in browser context
        const { SignalWire } = await import('@signalwire/js');
        if (cancelled) return;

        addLog('SDK loaded, authenticating...');
        clientInstance = await SignalWire({
          project: projectId!,
          token: token!,
        });
        if (cancelled) { clientInstance.disconnect?.().catch(() => {}); return; }

        clientRef.current = clientInstance;
        setConnected(true);
        setError(null);
        addLog(`Ready (queue-mode) — waiting for calls as ${identity ?? 'unknown'}`);

        // Expose outbound call capability to parent
        if (onReady) {
          const makeOutboundCall = async (toNumber: string) => {
            if (!clientInstance) throw new Error('Not connected');
            setCallState('connecting');
            setCallerNumber(toNumber);
            addLog(`Dialing ${toNumber}...`);
            try {
              // Prime mic permission before dial (SDK needs it)
              try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                stream.getTracks().forEach(t => t.stop());
              } catch (permErr) {
                addLog(`Mic permission denied: ${permErr instanceof Error ? permErr.message : permErr}`);
                setCallState('idle');
                setCallerNumber('');
                throw permErr;
              }
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const call: any = await (clientInstance as any).dial({
                to: toNumber,
                rootElement: audioRootRef.current ?? undefined,
                audio: true,
                video: false,
              });
              callRef.current = call;
              setCallState('active');
              addLog(`Outbound call active to ${toNumber}`);
              onCallStarted?.(call.id ?? 'call', toNumber);
              try { call.on('destroy', () => { callRef.current = null; setCallState('idle'); setCallerNumber(''); onCallEnded?.(); }); } catch { /* ignore */ }
            } catch (err) {
              addLog(`Dial failed: ${err instanceof Error ? err.message : err}`);
              setCallState('idle');
              setCallerNumber('');
              throw err;
            }
          };
          onReady(makeOutboundCall);
        }
      } catch (err: unknown) {
        if (cancelled) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg = err instanceof Error ? err.message : ((err as any)?.message ?? JSON.stringify(err));
        console.error('[Softphone] init error:', err);
        addLog(`FAILED: ${msg.slice(0, 120)}`);
        setError('Phone connection failed: ' + msg.slice(0, 100));
      }
    }

    initClient();

    return () => {
      cancelled = true;
      pendingRingRef.current = null;
      callRef.current = null;
      const c = clientInstance;
      clientInstance = null;
      clientRef.current = null;
      setConnected(false);
      if (c) {
        addLog('Disconnecting...');
        c.disconnect?.().catch(() => {});
      }
    };
  }, [token, projectId, host, identity, addLog, onReady, onCallStarted, onCallEnded]);

  // ── Supabase Realtime (primary) + polling (fallback) for call_queue rows ──
  useEffect(() => {
    if (!repId) return;
    const supabase = createClient();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tryPickupRow = (row: any, source: string) => {
      if (!row || row.status !== 'waiting') return;
      if (row.target_rep_id && row.target_rep_id !== repId) return;
      if (pendingRingRef.current || callRef.current) return;
      pendingRingRef.current = {
        queueId: row.id,
        queueName: row.queue_name,
        fromNumber: row.from_number,
        callerName: row.caller_name,
      };
      setCallerNumber(row.caller_name || row.from_number);
      setCallState('ringing');
      addLog(`RINGING (${source}) from ${row.from_number} [queue=${row.queue_name}]`);
    };

    // Poll every 2s for waiting rows — robust fallback regardless of Realtime.
    let firstPoll = true;
    const poll = async () => {
      try {
        const { data, error } = await supabase
          .from('call_queue')
          .select('id, queue_name, from_number, caller_name, target_rep_id, status')
          .eq('status', 'waiting')
          .or(`target_rep_id.eq.${repId},target_rep_id.is.null`)
          .order('enqueued_at', { ascending: true })
          .limit(1);
        if (error) {
          addLog(`queue poll error: ${error.message.slice(0, 80)}`);
          return;
        }
        if (firstPoll) {
          addLog(`poll ok — ${data?.length ?? 0} waiting row(s) visible to me`);
          firstPoll = false;
        }
        if (data && data[0]) tryPickupRow(data[0], 'poll');
      } catch { /* ignore transient */ }
    };
    poll();
    const pollInterval = setInterval(poll, 2000);

    const channel = supabase
      .channel(`call-queue-rep-${repId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'call_queue' },
        (payload) => tryPickupRow(payload.new, 'realtime')
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'call_queue' },
        (payload) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const row = payload.new as any;
          if (!row) return;
          // If the ringing row got claimed elsewhere or ended, clear the ring.
          if (pendingRingRef.current && pendingRingRef.current.queueId === row.id && row.status !== 'waiting') {
            const claimedByUs = row.claimed_by_rep_id === repId && row.status === 'claimed';
            if (!claimedByUs) {
              pendingRingRef.current = null;
              setCallerNumber('');
              setCallState('idle');
              addLog(`Ring cleared (row ${row.status})`);
            }
          }
        }
      )
      .subscribe((status) => {
        addLog(`queue channel: ${status}`);
      });

    return () => {
      clearInterval(pollInterval);
      supabase.removeChannel(channel).catch(() => {});
    };
  }, [repId, addLog]);


  // Duration timer
  useEffect(() => {
    if (callState === 'active') {
      const start = Date.now();
      timerRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - start) / 1000));
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (callState === 'idle') setDuration(0);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [callState]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const answerCall = useCallback(async () => {
    const ring = pendingRingRef.current;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientInstance: any = clientRef.current;
    if (!ring || !clientInstance) return;
    try {
      setCallState('connecting');
      addLog(`Claiming queue row ${ring.queueId}...`);
      const claimRes = await edgeFn('call-claim', {
        method: 'POST',
        body: JSON.stringify({ queue_id: ring.queueId }),
        headers: { 'Content-Type': 'application/json' },
      });
      if (!claimRes.ok) {
        addLog(`Claim failed (${claimRes.status}) — another rep got it`);
        pendingRingRef.current = null;
        setCallState('idle');
        setCallerNumber('');
        return;
      }
      const { queue_name } = await claimRes.json();
      // Prime the microphone BEFORE dial(): the SignalWire SDK's
      // createDeviceWatcher() throws if getUserMedia has never run in
      // this page. Also surfaces permission prompts promptly.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        stream.getTracks().forEach(t => t.stop());
        addLog('Mic permission ok');
      } catch (permErr) {
        addLog(`Mic permission denied: ${permErr instanceof Error ? permErr.message : permErr}`);
        pendingRingRef.current = null;
        setCallState('idle');
        setCallerNumber('');
        return;
      }
      addLog(`Claimed. Dialing queue:${queue_name}...`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const call: any = await clientInstance.dial({
        to: `queue:${queue_name}`,
        rootElement: audioRootRef.current ?? undefined,
        audio: true,
        video: false,
      });
      callRef.current = call;
      pendingRingRef.current = null;
      setCallState('active');
      addLog('Call active');
      onCallStarted?.(call.id ?? 'call', ring.fromNumber);

      const handleCallEnded = () => {
        if (callRef.current === call) {
          callRef.current = null;
          setCallState('idle');
          setCallerNumber('');
          setMuted(false);
          setDeafened(false);
          addLog('Call ended (remote)');
          onCallEnded?.();
        }
      };
      try { call.on('destroy', handleCallEnded); } catch { /* ignore */ }
      try { call.on('call.left', handleCallEnded); } catch { /* ignore */ }
    } catch (err) {
      console.error('Answer error:', err);
      addLog(`Answer failed: ${err instanceof Error ? err.message : err}`);
      callRef.current = null;
      pendingRingRef.current = null;
      setCallState('idle');
      setCallerNumber('');
    }
  }, [onCallStarted, onCallEnded, addLog]);

  const hangup = useCallback(async () => {
    try {
      setCallState('ending');
      if (pendingRingRef.current) {
        // Decline: we simply ignore locally; other reps may still claim.
        addLog('Declining ring (caller stays in queue)');
        pendingRingRef.current = null;
      } else if (callRef.current) {
        addLog('Ending call...');
        await callRef.current.hangup?.().catch(() => {});
        await callRef.current.end?.().catch(() => {});
      }
    } catch (err) {
      console.error('Hangup error:', err);
    } finally {
      callRef.current = null;
      pendingRingRef.current = null;
      setCallState('idle');
      setCallerNumber('');
      setMuted(false);
      setDeafened(false);
      onCallEnded?.();
    }
  }, [onCallEnded, addLog]);

  const toggleMute = useCallback(async () => {
    if (!callRef.current) return;
    try {
      if (muted) {
        await callRef.current.audioUnmute?.();
      } else {
        await callRef.current.audioMute?.();
      }
      setMuted(!muted);
    } catch (err) {
      // Queue-dialed calls don't expose mute capability on the SDK.
      // Fall back to muting the local mic tracks directly.
      try {
        const pc = callRef.current?.peer?.instance as RTCPeerConnection | undefined;
        pc?.getSenders().forEach((s: RTCRtpSender) => {
          if (s.track && s.track.kind === 'audio') s.track.enabled = muted; // toggle
        });
        setMuted(!muted);
        addLog(muted ? 'Unmuted (local)' : 'Muted (local)');
      } catch {
        console.warn('Mute unsupported:', err);
      }
    }
  }, [muted, addLog]);

  const toggleDeafen = useCallback(async () => {
    if (!callRef.current) return;
    try {
      if (deafened) {
        await callRef.current.undeaf?.();
      } else {
        await callRef.current.deaf?.();
      }
      setDeafened(!deafened);
    } catch (err) {
      // Fallback: mute/unmute the audio element locally.
      try {
        const root = audioRootRef.current;
        const audios = root?.querySelectorAll('audio');
        audios?.forEach(a => { (a as HTMLAudioElement).muted = !deafened; });
        setDeafened(!deafened);
        addLog(deafened ? 'Undeafened (local)' : 'Deafened (local)');
      } catch {
        console.warn('Deafen unsupported:', err);
      }
    }
  }, [deafened, addLog]);

  // Color coding based on state
  const stateColors: Record<CallState, string> = {
    idle: 'bg-gray-100 border-gray-200',
    connecting: 'bg-yellow-50 border-yellow-200',
    ringing: 'bg-blue-50 border-blue-200 animate-pulse',
    active: 'bg-green-50 border-green-200',
    ending: 'bg-red-50 border-red-200',
  };

  const stateLabels: Record<CallState, string> = {
    idle: 'Ready',
    connecting: 'Connecting...',
    ringing: 'Incoming Call',
    active: 'On Call',
    ending: 'Ending...',
  };

  if (!token) {
    return (
      <div className="bg-gray-50 rounded-xl border p-4 text-center text-sm text-gray-500">
        <Phone className="w-6 h-6 mx-auto mb-2 text-gray-300" />
        Set yourself as Available to enable the softphone.
      </div>
    );
  }

  return (
    <div className={`rounded-xl border-2 p-4 transition-all ${stateColors[callState]}`}>
      {/* Hidden div — v3 SDK mounts audio elements here during a call */}
      <div ref={audioRootRef} style={{ display: 'none' }} aria-hidden="true" />

      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div
            className={`w-2.5 h-2.5 rounded-full ${
              callState === 'active'
                ? 'bg-green-500'
                : callState === 'ringing'
                ? 'bg-blue-500 animate-ping'
                : connected
                ? 'bg-green-400'
                : error
                ? 'bg-red-500'
                : 'bg-yellow-400 animate-pulse'
            }`}
          />
          <span className="text-sm font-medium">{stateLabels[callState]}</span>
        </div>
        {callState === 'active' && (
          <span className="text-sm font-mono text-gray-600">{formatTime(duration)}</span>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-100 text-red-700 rounded-lg px-3 py-2 text-xs mb-3">
          {error}
        </div>
      )}

      {/* Caller Info */}
      {callerNumber && (
        <div className="text-center mb-3">
          <div className="text-lg font-semibold">{callerNumber}</div>
          <div className="text-xs text-gray-500">Incoming call</div>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center justify-center gap-3">
        {callState === 'ringing' && (
          <button
            onClick={answerCall}
            className="flex items-center gap-2 bg-green-600 text-white px-5 py-2.5 rounded-full font-medium hover:bg-green-700 transition shadow-lg"
          >
            <PhoneIncoming className="w-5 h-5" />
            Answer
          </button>
        )}

        {callState === 'active' && (
          <>
            <button
              onClick={toggleMute}
              className={`p-2.5 rounded-full transition ${
                muted
                  ? 'bg-red-100 text-red-600 hover:bg-red-200'
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
              title={muted ? 'Unmute' : 'Mute'}
            >
              {muted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button>

            <button
              onClick={toggleDeafen}
              className={`p-2.5 rounded-full transition ${
                deafened
                  ? 'bg-red-100 text-red-600 hover:bg-red-200'
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
              title={deafened ? 'Undeafen' : 'Deafen'}
            >
              {deafened ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
            </button>
          </>
        )}

        {(callState === 'ringing' || callState === 'active') && (
          <button
            onClick={hangup}
            className="flex items-center gap-2 bg-red-600 text-white px-5 py-2.5 rounded-full font-medium hover:bg-red-700 transition shadow-lg"
          >
            <PhoneOff className="w-5 h-5" />
            {callState === 'ringing' ? 'Decline' : 'Hang Up'}
          </button>
        )}

        {(callState === 'connecting' || callState === 'ending') && (
          <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
        )}
      </div>

      {/* Connection Log */}
      <details className="mt-3">
        <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600">
          Connection Log {connected ? '(Connected)' : '(Disconnected)'}
        </summary>
        <div className="mt-1 max-h-32 overflow-y-auto bg-gray-50 rounded p-2 text-xs font-mono text-gray-500 space-y-0.5">
          {connectionLog.length === 0 ? (
            <div>No events yet</div>
          ) : (
            connectionLog.map((log, i) => <div key={i}>{log}</div>)
          )}
        </div>
      </details>
    </div>
  );
}

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
   Architecture: the rep browser does NOT client.dial() to pick up queued
   calls — "queue:<name>" is not a valid Call Fabric address and the SDK
   silently opens a dead media session with no bridged party. Instead:

   1. Inbound callers are <Enqueue>'d by the sw-inbound LaML webhook and a
      row is inserted in the call_queue table.
   2. This component subscribes to call_queue via Supabase Realtime +
      polling. When a row appears, it shows the ring UI.
   3. On Answer: POSTs call-claim, which atomically claims the row AND
      uses the SignalWire REST Update-Call API to redirect the caller's
      live leg to a new LaML endpoint that does
      <Dial><Client>identity</Client></Dial>.
   4. SignalWire delivers the resulting INVITE over this rep's already-
      connected SDK websocket session. IncomingCallManager fires our
      handler, which auto-accepts and joins the call.

   We register the websocket incoming-call handler via client.online(),
   tolerating the -32603 RPC error (see signalwire-legacy-js#1339) — the
   SDK registers the handler BEFORE the failing RPC, and the server routes
   INVITEs to any authenticated subscriber websocket regardless of the
   online RPC status. */

interface SoftphoneProps {
  token: string | null;
  projectId: string | null;
  host: string | null;
  identity: string | null;
  /** Rep UUID (reps.id == auth.users.id). Needed to filter queue rows. */
  repId: string | null;
  onCallStarted?: (callId: string, fromNumber: string) => void;
  onCallEnded?: () => void;
  /** Fires when a queued call is claimed. Payload includes the enriched
   *  call / customer / AI brief so the parent can show everything right
   *  away — critical for PSTN/SIP bridging where the browser never rings. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onCallClaimed?: (payload: any) => void;
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

export default function Softphone({ token, projectId, host, identity, repId, onCallStarted, onCallEnded, onCallClaimed, onReady }: SoftphoneProps) {
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
  // When true, an incoming invite arriving on the websocket should be
  // auto-accepted (the rep already clicked Answer).
  const awaitingInviteRef = useRef(false);
  const inviteWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // If set, an outbound PSTN call is in-flight (server-initiated via REST).
  // When the invite arrives and we accept, 'destroy' posts call-outbound end.
  const outboundTrackingRef = useRef<{ callId: string | null; startedAt: number } | null>(null);
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

        // ── Register incoming-call handler ──
        // client.online() does two things: (1) registers the notification
        // handler synchronously, then (2) sends subscriber.online RPC which
        // fails with -32603 on SAT tokens. The handler IS still registered
        // by the time the RPC fails, and INVITEs routed to this subscriber
        // by LaML <Client> still reach us. So we call .online() and swallow
        // the RPC error.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handleInviteNotification = async (notification: any) => {
          const invite = notification?.invite;
          if (!invite) return;
          addLog(`Invite received (callID=${invite.details?.callID ?? '?'})`);
          if (!awaitingInviteRef.current) {
            // Rep didn't click Answer — reject politely.
            addLog('Rejecting invite (not awaiting).');
            try { await invite.reject(); } catch { /* ignore */ }
            return;
          }
          try {
            awaitingInviteRef.current = false;
            if (inviteWaitTimerRef.current) {
              clearTimeout(inviteWaitTimerRef.current);
              inviteWaitTimerRef.current = null;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const call: any = await invite.accept({
              rootElement: audioRootRef.current ?? undefined,
              audio: true,
              video: false,
            });
            callRef.current = call;
            setCallState('active');
            addLog('Invite accepted — call active');
            const ring = pendingRingRef.current;
            pendingRingRef.current = null;
            onCallStarted?.(call.id ?? 'call', ring?.fromNumber ?? '');
            const handleCallEnded = async () => {
              if (callRef.current === call) {
                callRef.current = null;
                setCallState('idle');
                setCallerNumber('');
                setMuted(false);
                setDeafened(false);
                // If this was an outbound REST call, post end to deduct minutes.
                const tracking = outboundTrackingRef.current;
                outboundTrackingRef.current = null;
                if (tracking?.callId) {
                  const durationSecs = Math.floor((Date.now() - tracking.startedAt) / 1000);
                  try {
                    await edgeFn('call-outbound', {
                      method: 'POST',
                      body: JSON.stringify({
                        action: 'end',
                        call_id: tracking.callId,
                        duration_seconds: durationSecs,
                      }),
                    });
                    addLog(`Call ended (${durationSecs}s, ${Math.ceil(durationSecs / 60)} min deducted)`);
                  } catch (endErr) {
                    console.warn('[softphone] end-track error:', endErr);
                  }
                } else {
                  addLog('Call ended (remote)');
                }
                onCallEnded?.();
              }
            };
            try { call.on('destroy', handleCallEnded); } catch { /* ignore */ }
            try { call.on('call.left', handleCallEnded); } catch { /* ignore */ }
          } catch (acceptErr) {
            console.error('[softphone] accept error:', acceptErr);
            addLog(`Accept failed: ${acceptErr instanceof Error ? acceptErr.message : acceptErr}`);
            setCallState('idle');
            setCallerNumber('');
          }
        };

        try {
          await clientInstance.online({
            incomingCallHandlers: {
              websocket: handleInviteNotification,
              all: handleInviteNotification,
            },
          });
          addLog('online() ok — listening for invites');
        } catch (onlineErr) {
          // Expected on SAT tokens; the handler is still registered.
          const m = onlineErr instanceof Error ? onlineErr.message : String(onlineErr);
          addLog(`online() rpc warn (handler still registered): ${m.slice(0, 100)}`);
        }

        // Expose outbound call capability to parent
        if (onReady) {
          const makeOutboundCall = async (toNumber: string) => {
            if (!clientInstance) throw new Error('Not connected');
            setCallState('connecting');
            setCallerNumber(toNumber);
            addLog(`Calling ${toNumber}...`);
            try {
              // Prime mic permission so SDK can build RTCPeerConnection
              // the moment the INVITE arrives.
              try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                stream.getTracks().forEach(t => t.stop());
              } catch (permErr) {
                addLog(`Mic permission denied: ${permErr instanceof Error ? permErr.message : permErr}`);
                setCallState('idle');
                setCallerNumber('');
                throw permErr;
              }

              // Arm auto-accept BEFORE triggering the call — SignalWire will
              // dial the customer, and when they answer, our LaML
              // (sw-inbound?step=outbound-bridge) dials our SDK via SIP.
              awaitingInviteRef.current = true;

              // Server-side place the call via REST Create-Call. This is
              // the ONLY reliable way to do PSTN dialing from a SAT
              // subscriber without a configured fromFabricAddress.
              const callStartedAt = Date.now();
              let trackedCallId: string | null = null;
              try {
                const startRes = await edgeFn('call-outbound', {
                  method: 'POST',
                  body: JSON.stringify({ action: 'start', to_number: toNumber }),
                });
                if (!startRes.ok) {
                  const errBody = await startRes.text().catch(() => '');
                  throw new Error(`Start failed (${startRes.status}): ${errBody.slice(0, 160)}`);
                }
                const j = await startRes.json();
                trackedCallId = j.call_id ?? null;
                if (j.customer_name) addLog(`Customer: ${j.customer_name} (${j.balance_minutes ?? '?'} min)`);
                addLog(`Ringing ${toNumber} via SignalWire (sid=${j.sw_call_sid ?? '?'})`);
              } catch (trackErr) {
                awaitingInviteRef.current = false;
                setCallState('idle');
                setCallerNumber('');
                throw trackErr;
              }

              // Safety timeout: if the SDK doesn't receive the INVITE
              // within 45s (customer didn't answer), reset.
              if (inviteWaitTimerRef.current) clearTimeout(inviteWaitTimerRef.current);
              inviteWaitTimerRef.current = setTimeout(() => {
                if (awaitingInviteRef.current) {
                  awaitingInviteRef.current = false;
                  addLog('No answer from customer (45s).');
                  setCallState('idle');
                  setCallerNumber('');
                  if (trackedCallId) {
                    edgeFn('call-outbound', {
                      method: 'POST',
                      body: JSON.stringify({ action: 'end', call_id: trackedCallId, duration_seconds: 0 }),
                    }).catch(() => {});
                  }
                }
              }, 45000);

              // Track call-end separately — the invite handler sets
              // callRef.current when it auto-accepts; hook 'destroy' there
              // to POST call-outbound end with proper duration.
              outboundTrackingRef.current = { callId: trackedCallId, startedAt: callStartedAt };
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

    // Stale-ring guard: any row enqueued more than 90s ago is treated as
    // dead. The customer would have hung up or been routed to voicemail
    // long before then, so we never ring on stale rows AND we mark them
    // as expired so other tabs/reps stop seeing them too.
    const STALE_MS = 90_000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tryPickupRow = (row: any, source: string) => {
      if (!row || row.status !== 'waiting') return;
      if (row.target_rep_id && row.target_rep_id !== repId) return;
      const ageMs = row.enqueued_at ? Date.now() - new Date(row.enqueued_at).getTime() : 0;
      if (ageMs > STALE_MS) {
        addLog(`Skipping stale ring (${Math.round(ageMs / 1000)}s old, id=${row.id})`);
        supabase.from('call_queue').update({ status: 'expired' }).eq('id', row.id).then(() => {});
        return;
      }
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
        // First: if we are currently ringing, verify that row is still
        // waiting AND fresh. If it was claimed/ended/expired (e.g. caller
        // hung up but no realtime event arrived), clear the UI.
        const ringing = pendingRingRef.current;
        if (ringing) {
          const { data: cur } = await supabase
            .from('call_queue')
            .select('id, status, enqueued_at')
            .eq('id', ringing.queueId)
            .maybeSingle();
          const ageMs = cur?.enqueued_at ? Date.now() - new Date(cur.enqueued_at).getTime() : 0;
          if (!cur || cur.status !== 'waiting' || ageMs > STALE_MS) {
            pendingRingRef.current = null;
            setCallerNumber('');
            setCallState('idle');
            addLog(`Ring auto-cleared (status=${cur?.status ?? 'gone'} age=${Math.round(ageMs / 1000)}s)`);
            if (cur && cur.status === 'waiting' && ageMs > STALE_MS) {
              await supabase.from('call_queue').update({ status: 'expired' }).eq('id', cur.id);
            }
          }
        }
        const { data, error } = await supabase
          .from('call_queue')
          .select('id, queue_name, from_number, caller_name, target_rep_id, status, enqueued_at')
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
      // Prime mic BEFORE claim so the SDK can create its RTCPeerConnection
      // the moment the INVITE arrives.
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
      // Arm the incoming-invite handler to auto-accept, then claim.
      awaitingInviteRef.current = true;
      const claimRes = await edgeFn('call-claim', {
        method: 'POST',
        body: JSON.stringify({ queue_id: ring.queueId }),
        headers: { 'Content-Type': 'application/json' },
      });
      if (!claimRes.ok) {
        awaitingInviteRef.current = false;
        addLog(`Claim failed (${claimRes.status}) — another rep got it`);
        pendingRingRef.current = null;
        setCallState('idle');
        setCallerNumber('');
        return;
      }
      const claimData = await claimRes.json().catch(() => ({}));
      addLog(`Claimed (bridge_initiated=${claimData.bridge_initiated}, mode=${claimData.bridge_mode}). ${claimData.bridge_mode === 'browser' ? 'Waiting for invite…' : 'Forwarding to your phone — pick up there.'}`);

      // Hand the enriched claim payload up to the parent so it can render
      // the AI brief, customer context, credentials, findings etc. right
      // away — even before the rep answers their cell/SIP.
      try { onCallClaimed?.(claimData); } catch (err) { addLog('onCallClaimed error: ' + (err instanceof Error ? err.message : err)); }

      // For PSTN or SIP bridge modes the browser never receives an INVITE —
      // audio lives entirely on the rep's cell / deskphone. Don't arm the
      // invite-wait timer (which would otherwise expire after 45s and reset
      // the UI while the rep is actively on the phone).
      if (claimData.bridge_mode === 'pstn' || claimData.bridge_mode === 'sip') {
        awaitingInviteRef.current = false;
        if (inviteWaitTimerRef.current) {
          clearTimeout(inviteWaitTimerRef.current);
          inviteWaitTimerRef.current = null;
        }
        setCallState('active');
        setCallerNumber(ring.fromNumber);
        pendingRingRef.current = null;
        if (claimData.call?.id) {
          try { onCallStarted?.(claimData.call.id, ring.fromNumber); } catch { /* noop */ }
        }
        return;
      }
      // Browser softphone path — arm the invite-wait timer.
      // Safety timeout: if the SDK doesn't receive the INVITE within 45s,
      // something upstream failed — reset so the rep can try again. (Bumped
      // from 20s because the conference-bridge origination path can take
      // a few extra seconds for the REST round-trip + SDK invite.)
      if (inviteWaitTimerRef.current) clearTimeout(inviteWaitTimerRef.current);
      inviteWaitTimerRef.current = setTimeout(() => {
        if (awaitingInviteRef.current) {
          awaitingInviteRef.current = false;
          addLog('Timeout waiting for invite (45s). Aborting.');
          pendingRingRef.current = null;
          setCallState('idle');
          setCallerNumber('');
        }
      }, 45000);
    } catch (err) {
      console.error('Answer error:', err);
      awaitingInviteRef.current = false;
      addLog(`Answer failed: ${err instanceof Error ? err.message : err}`);
      callRef.current = null;
      pendingRingRef.current = null;
      setCallState('idle');
      setCallerNumber('');
    }
  }, [addLog, onCallClaimed, onCallStarted]);

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
      awaitingInviteRef.current = false;
      if (inviteWaitTimerRef.current) { clearTimeout(inviteWaitTimerRef.current); inviteWaitTimerRef.current = null; }
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

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

/* SignalWire JS v3 — Call Fabric SDK.
   Loaded via dynamic import (prevents SSR/WebRTC module issues).
   SignalWire() connects to the SPACE URL (accuinfo.signalwire.com)
   and registers the resource as a proper <Client> target so that
   LaML <Dial><Client>identity</Client> can reach it.
   The v1 Relay SDK connected to relay.signalwire.com (blade protocol)
   which does NOT register for <Dial><Client> routing — hence the
   DialCallStatus=failed. This v3 client fixes that. */

interface SoftphoneProps {
  token: string | null;
  projectId: string | null;
  host: string | null;
  identity: string | null;
  onCallStarted?: (callId: string, fromNumber: string) => void;
  onCallEnded?: () => void;
}

type CallState = 'idle' | 'connecting' | 'ringing' | 'active' | 'ending';

export default function Softphone({ token, projectId, host, identity, onCallStarted, onCallEnded }: SoftphoneProps) {
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inviteRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const callRef = useRef<any>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  // Hidden div where the v3 SDK mounts audio elements for the call
  const audioRootRef = useRef<HTMLDivElement | null>(null);

  // Connect to SignalWire Call Fabric and register for incoming calls.
  // Uses dynamic import so WebRTC code never runs during SSR.
  // The space URL (accuinfo.signalwire.com) is the correct host for the
  // Call Fabric protocol — this is what <Dial><Client> routes to.
  useEffect(() => {
    if (!token || !projectId) return;

    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let clientInstance: any = null;

    // Strip any protocol prefix — SignalWire() wants just the hostname
    const spaceHost = host?.replace(/^https?:\/\//, '').replace(/\/$/, '') || undefined;
    addLog(`Connecting: project=${projectId} host=${spaceHost ?? 'default'} identity=${identity ?? '?'}`);

    async function initClient() {
      try {
        // Dynamic import: WebRTC modules only load in browser context
        const { SignalWire } = await import('@signalwire/js');
        if (cancelled) return;

        addLog('SDK loaded, authenticating...');
        clientInstance = await SignalWire({
          host: spaceHost,
          project: projectId!,
          token: token!,
        });
        if (cancelled) { clientInstance.disconnect?.().catch(() => {}); return; }

        clientRef.current = clientInstance;
        addLog('Authenticated, going online for incoming calls...');

        await clientInstance.online({
          incomingCallHandlers: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            websocket: (notification: any) => {
              if (cancelled) return;
              const { invite } = notification;
              inviteRef.current = invite;
              const from = invite.details?.caller_id_number
                || invite.details?.caller_id_name
                || 'Unknown';
              addLog(`RINGING — incoming call from ${from}`);
              setCallerNumber(from);
              setCallState('ringing');
            },
          },
        });
        if (cancelled) return;

        setConnected(true);
        setError(null);
        addLog(`CONNECTED — listening for calls as ${identity ?? 'unknown'}`);
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Softphone] init error:', err);
        addLog(`FAILED: ${msg}`);
        setError('Phone connection failed: ' + msg.slice(0, 100));
      }
    }

    initClient();

    return () => {
      cancelled = true;
      inviteRef.current = null;
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
  }, [token, projectId, host, identity, addLog]);

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
    if (!inviteRef.current) return;
    try {
      setCallState('connecting');
      addLog('Answering call...');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const call: any = await inviteRef.current.accept({
        audio: true,
        video: false,
        negotiateVideo: false,
        rootElement: audioRootRef.current ?? undefined,
      });
      callRef.current = call;
      inviteRef.current = null;
      setCallState('active');
      addLog('Call active');
      const from = callerNumber;
      onCallStarted?.(call.id ?? 'call', from);

      // Detect remote hangup / call destroyed
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
      // v3 Call Fabric fires 'destroy' when the session ends
      try { call.on('destroy', handleCallEnded); } catch { /* ignore */ }
      try { call.on('call.left', handleCallEnded); } catch { /* ignore */ }
    } catch (err) {
      console.error('Answer error:', err);
      addLog(`Answer failed: ${err instanceof Error ? err.message : err}`);
      callRef.current = null;
      inviteRef.current = null;
      setCallState('idle');
    }
  }, [callerNumber, onCallStarted, onCallEnded, addLog]);

  const hangup = useCallback(async () => {
    try {
      setCallState('ending');
      if (inviteRef.current) {
        addLog('Rejecting call...');
        await inviteRef.current.reject().catch(() => {});
        inviteRef.current = null;
      } else if (callRef.current) {
        addLog('Ending call...');
        await callRef.current.end().catch(() => {});
      }
    } catch (err) {
      console.error('Hangup error:', err);
    } finally {
      callRef.current = null;
      inviteRef.current = null;
      setCallState('idle');
      setCallerNumber('');
      setMuted(false);
      setDeafened(false);
      onCallEnded?.();
    }
  }, [onCallEnded]);

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
      console.error('Mute toggle error:', err);
    }
  }, [muted]);

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
      console.error('Deafen toggle error:', err);
    }
  }, [deafened]);

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

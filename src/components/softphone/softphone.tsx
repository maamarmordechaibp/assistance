'use client';

import Script from 'next/script';
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

/* The SignalWire JS v1 (legacy) bundle is loaded via CDN as a <script>.
   It exports Relay, Verto, CantinaAuth onto window. We use the Verto
   class which connects to wss://space.signalwire.com — the VERTO endpoint
   that LaML <Dial><Client> routes calls through. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare global { interface Window { Verto: any; } }

const SW_CDN_URL = 'https://unpkg.com/@signalwire/js@1.5.1-rc.5/dist/index.min.js';

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
  const [sdkReady, setSdkReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connectionLog, setConnectionLog] = useState<string[]>([]);

  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    console.log(`[Softphone] ${msg}`);
    setConnectionLog(prev => [`${ts} ${msg}`, ...prev].slice(0, 20));
  }, []);

  const clientRef = useRef<unknown>(null);
  const callRef = useRef<unknown>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Initialize SignalWire Verto client for incoming calls via <Dial><Client>
  useEffect(() => {
    if (!token || typeof token !== 'string' || !host || !identity || !sdkReady) return;
    if (!window.Verto) { setError('SignalWire SDK not loaded'); return; }

    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let clientInstance: any = null;

    addLog(`Initializing Verto: host=${host} identity=${identity}`);

    async function initClient() {
      try {
        // Verto connects directly to wss://space.signalwire.com — the
        // VERTO endpoint that LaML <Dial><Client> routes calls to.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const client: any = new window.Verto({
          host,
          login: identity,
          passwd: token,
          remoteElement: 'sw-remote-audio',
          localElement: 'sw-local-audio',
        });
        if (cancelled) return;
        clientInstance = client;

        // Handle call notifications (fired by BaseCall.setState → _dispatchNotification)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client.on('signalwire.notification', (notification: any) => {
          if (cancelled) return;
          addLog(`Notification: type=${notification.type} state=${notification.call?.state}`);
          if (notification.type === 'callUpdate') {
            const call = notification.call;
            const state = call.state; // e.g. 'ringing', 'active', 'hangup', 'destroy'
            if (state === 'ringing' && !callRef.current) {
              callRef.current = call;
              const from = call.options?.remoteCallerNumber || call.from || 'Unknown';
              setCallerNumber(from);
              setCallState('ringing');
            } else if (state === 'active') {
              setCallState('active');
              const from = call.options?.remoteCallerNumber || call.from || 'Unknown';
              onCallStarted?.(call.id, from);
            } else if (state === 'hangup' || state === 'destroy') {
              callRef.current = null;
              setCallState('idle');
              setCallerNumber('');
              setMuted(false);
              setDeafened(false);
              onCallEnded?.();
            }
          }
        });

        client.on('signalwire.ready', () => {
          if (cancelled) return;
          setError(null);
          setConnected(true);
          addLog('CONNECTED — Verto client ready, listening for calls');
        });

        client.on('signalwire.error', (err: Error) => {
          console.error('SignalWire error:', err);
          addLog(`ERROR: ${err?.message || err}`);
          if (!cancelled) setError('Phone connection error');
        });

        client.on('signalwire.socket.open', () => {
          addLog('WebSocket opened');
        });

        client.on('signalwire.socket.close', () => {
          addLog('WebSocket CLOSED');
          if (!cancelled) { setError('Phone disconnected'); setConnected(false); }
        });

        client.on('signalwire.socket.error', (e: unknown) => {
          addLog(`WebSocket ERROR: ${e}`);
        });

        addLog('Calling client.connect()...');
        await client.connect();
        clientRef.current = clientInstance;
        addLog('client.connect() returned');
      } catch (err) {
        console.error('SignalWire init error:', err);
        addLog(`INIT FAILED: ${err}`);
        setError('Failed to connect to phone system');
      }
    }

    initClient();

    return () => {
      cancelled = true;
      if (clientInstance) {
        addLog('Disconnecting...');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = clientInstance as any;
        c.disconnect?.();
        c.destroy?.();
        clientInstance = null;
        clientRef.current = null;
        setConnected(false);
      }
    };
  }, [token, host, identity, sdkReady, onCallStarted, onCallEnded, addLog]);

  // Timer for active calls
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
    if (!callRef.current) return;
    try {
      setCallState('connecting');
      const call = callRef.current as { answer: () => Promise<void> };
      await call.answer();
    } catch (err) {
      console.error('Answer error:', err);
      setCallState('idle');
    }
  }, []);

  const hangup = useCallback(async () => {
    if (!callRef.current) return;
    try {
      setCallState('ending');
      const call = callRef.current as { hangup: () => Promise<void> };
      await call.hangup();
    } catch (err) {
      console.error('Hangup error:', err);
    } finally {
      callRef.current = null;
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
      const call = callRef.current as {
        toggleAudioMute?: () => void;
        muteAudio?: () => void;
        unmuteAudio?: () => void;
      };
      if (call.toggleAudioMute) {
        call.toggleAudioMute();
      } else if (muted) {
        call.unmuteAudio?.();
      } else {
        call.muteAudio?.();
      }
      setMuted(!muted);
    } catch (err) {
      console.error('Mute toggle error:', err);
    }
  }, [muted]);

  const toggleDeafen = useCallback(async () => {
    if (!callRef.current) return;
    try {
      const call = callRef.current as {
        toggleDeaf?: () => void;
        deaf?: () => void;
        undeaf?: () => void;
      };
      if (call.toggleDeaf) {
        call.toggleDeaf();
      } else if (deafened) {
        call.undeaf?.();
      } else {
        call.deaf?.();
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
      <>
        <Script src={SW_CDN_URL} strategy="afterInteractive" onLoad={() => setSdkReady(true)} />
        <div className="bg-gray-50 rounded-xl border p-4 text-center text-sm text-gray-500">
          <Phone className="w-6 h-6 mx-auto mb-2 text-gray-300" />
          Set yourself as Available to enable the softphone.
        </div>
      </>
    );
  }

  return (
    <>
      <Script src={SW_CDN_URL} strategy="afterInteractive" onLoad={() => setSdkReady(true)} />
    <div className={`rounded-xl border-2 p-4 transition-all ${stateColors[callState]}`}>
      {/* Hidden audio elements for WebRTC media */}
      <audio id="sw-remote-audio" ref={audioRef} autoPlay />
      <audio id="sw-local-audio" style={{ display: 'none' }} />

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
    </>
  );
}

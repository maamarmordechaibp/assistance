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

interface SoftphoneProps {
  token: string | null;
  projectId: string | null;
  host: string | null;
  onCallStarted?: (callId: string, fromNumber: string) => void;
  onCallEnded?: () => void;
}

type CallState = 'idle' | 'connecting' | 'ringing' | 'active' | 'ending';

export default function Softphone({ token, projectId, host, onCallStarted, onCallEnded }: SoftphoneProps) {
  const [callState, setCallState] = useState<CallState>('idle');
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [duration, setDuration] = useState(0);
  const [callerNumber, setCallerNumber] = useState('');
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<unknown>(null);
  const callRef = useRef<unknown>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Initialize SignalWire client (v3 API) for incoming calls via <Dial><Client>
  useEffect(() => {
    if (!token || typeof token !== 'string' || !host) return;

    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let clientInstance: any = null;

    async function initClient() {
      try {
        // @signalwire/js v3 uses the SignalWire() factory function
        const SW = await import('@signalwire/js');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const SignalWireFn = (SW as any).SignalWire || (SW as any).default?.SignalWire;

        // Fallback: try the legacy WebRTC.Client API if SignalWire() doesn't exist
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const WebRTCClient = (SW as any).WebRTC?.Client;

        if (SignalWireFn) {
          // v3 API: SignalWire({ host, token })
          const client = await SignalWireFn({ host, token });
          if (cancelled) { client.disconnect?.(); return; }
          clientInstance = client;

          // Register for incoming calls
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const handleCallReceived = async (call: any) => {
            if (cancelled) return;
            callRef.current = call;
            setCallerNumber(call.from || call.headers?.['X-CallerNumber'] || 'Unknown');
            setCallState('ringing');

            // Listen for call state changes
            call.on?.('call.state', (state: string) => {
              if (cancelled) return;
              if (state === 'active' || state === 'answering') {
                setCallState('active');
                onCallStarted?.(call.id, call.from || 'Unknown');
              } else if (state === 'ending' || state === 'hangup' || state === 'destroy') {
                callRef.current = null;
                setCallState('idle');
                setCallerNumber('');
                setMuted(false);
                setDeafened(false);
                onCallEnded?.();
              }
            });
          };

          client.on?.('call.received', handleCallReceived);

          // Also try the online() registration if available
          if (typeof client.online === 'function') {
            await client.online({
              incomingCallHandlers: { all: handleCallReceived },
            });
          }

          setError(null);
          console.log('SignalWire v3 client connected, ready for calls');
        } else if (WebRTCClient && projectId) {
          // Legacy v2 API fallback: new WebRTC.Client({ project, token })
          const client = new WebRTCClient({ project: projectId, token });
          if (cancelled) return;
          clientInstance = client;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          client.on('signalwire.notification', (notification: any) => {
            if (cancelled) return;
            if (notification.type === 'callUpdate') {
              const call = notification.call;
              if (call.state === 'ringing' && call.direction === 'inbound') {
                callRef.current = call;
                setCallerNumber(call.from || 'Unknown');
                setCallState('ringing');
              } else if (call.state === 'active') {
                setCallState('active');
                onCallStarted?.(call.id, call.from || 'Unknown');
              } else if (call.state === 'hangup' || call.state === 'destroy') {
                callRef.current = null;
                setCallState('idle');
                setCallerNumber('');
                setMuted(false);
                setDeafened(false);
                onCallEnded?.();
              }
            }
          });

          await client.connect();
          setError(null);
          console.log('SignalWire WebRTC.Client (legacy) connected, ready for calls');
        } else {
          throw new Error('No compatible SignalWire API found');
        }

        clientRef.current = clientInstance;
      } catch (err) {
        console.error('SignalWire init error:', err);
        setError('Failed to connect to phone system');
      }
    }

    initClient();

    return () => {
      cancelled = true;
      if (clientInstance) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = clientInstance as any;
        c.disconnect?.();
        c.destroy?.();
        clientInstance = null;
        clientRef.current = null;
      }
    };
  }, [token, projectId, host, onCallStarted, onCallEnded]);

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
      <div className="bg-gray-50 rounded-xl border p-4 text-center text-sm text-gray-500">
        <Phone className="w-6 h-6 mx-auto mb-2 text-gray-300" />
        Set yourself as Available to enable the softphone.
      </div>
    );
  }

  return (
    <div className={`rounded-xl border-2 p-4 transition-all ${stateColors[callState]}`}>
      {/* Hidden audio element for remote audio */}
      <audio ref={audioRef} autoPlay />

      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div
            className={`w-2.5 h-2.5 rounded-full ${
              callState === 'active'
                ? 'bg-green-500'
                : callState === 'ringing'
                ? 'bg-blue-500 animate-ping'
                : error
                ? 'bg-red-500'
                : 'bg-gray-400'
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
    </div>
  );
}

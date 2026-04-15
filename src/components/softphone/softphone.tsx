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
  onCallStarted?: (callId: string, fromNumber: string) => void;
  onCallEnded?: () => void;
}

type CallState = 'idle' | 'connecting' | 'ringing' | 'active' | 'ending';

export default function Softphone({ token, onCallStarted, onCallEnded }: SoftphoneProps) {
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

  // Initialize SignalWire Fabric client
  useEffect(() => {
    if (!token || typeof token !== 'string') return;

    let cancelled = false;

    async function initClient() {
      try {
        const { SignalWire } = await import('@signalwire/js');

        const client = await SignalWire({
          token: token!,
        });

        if (cancelled) return;
        clientRef.current = client;
        setError(null);

        // Fabric SDK: go online and register for incoming calls
        const fabricClient = client as unknown as {
          online: (opts: {
            incomingCallHandlers: {
              all?: (invite: unknown) => void;
              websocket?: (invite: unknown) => void;
            };
          }) => Promise<unknown>;
          offline: () => Promise<unknown>;
          on: (event: string, handler: (...args: unknown[]) => void) => void;
          disconnect: () => Promise<void>;
        };

        await fabricClient.online({
          incomingCallHandlers: {
            all: (inviteEvent: unknown) => {
              if (cancelled) return;
              const evt = inviteEvent as {
                invite: {
                  details: { callerIdNumber?: string; callerIdName?: string; callID?: string };
                  accept: () => Promise<unknown>;
                  reject: () => Promise<void>;
                };
              };
              const invite = evt.invite;
              callRef.current = invite;
              const num = invite.details?.callerIdNumber || invite.details?.callerIdName || 'Unknown';
              setCallerNumber(num);
              setCallState('ringing');
            },
          },
        });

        console.log('SignalWire client online, ready for calls');
      } catch (err) {
        console.error('SignalWire init error:', err);
        setError('Failed to connect to phone system');
      }
    }

    initClient();

    return () => {
      cancelled = true;
      if (clientRef.current) {
        const c = clientRef.current as {
          offline?: () => Promise<void>;
          disconnect?: () => Promise<void>;
        };
        c.offline?.().catch(() => {});
        c.disconnect?.();
      }
    };
  }, [token]);

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
      // Fabric SDK: callRef holds the invite object from incomingCallHandlers
      const invite = callRef.current as {
        accept: () => Promise<unknown>;
        answer?: () => Promise<void>;
      };
      const roomSession = await invite.accept();
      // Store the room session for hangup/mute
      if (roomSession) callRef.current = roomSession;
      setCallState('active');
    } catch (err) {
      console.error('Answer error:', err);
      setCallState('idle');
    }
  }, []);

  const hangup = useCallback(async () => {
    if (!callRef.current) return;
    try {
      setCallState('ending');
      const call = callRef.current as {
        hangup?: () => Promise<void>;
        leave?: () => Promise<void>;
        reject?: () => Promise<void>;
      };
      // Fabric SDK: active calls use leave(), invites use reject()
      await (call.hangup || call.leave || call.reject)?.();
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
        audioMute?: () => Promise<void>;
        audioUnmute?: () => Promise<void>;
      };
      if (muted) {
        await call.audioUnmute?.();
      } else {
        await call.audioMute?.();
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
        deaf?: () => Promise<void>;
        undeaf?: () => Promise<void>;
      };
      if (deafened) {
        await call.undeaf?.();
      } else {
        await call.deaf?.();
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

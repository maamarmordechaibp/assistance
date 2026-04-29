'use client';

// RepSessionGate
// ---------------------------------------------------------------------------
// Client wrapper mounted at the top of the rep area. Owns:
//   * Shift session: starts on first mount, ends on manual click or on
//     idle-timeout. Heartbeats every 30s.
//   * Activity tracker: any mousemove/keydown/click bumps last-active.
//     Being on a call ALSO counts as activity (we force-heartbeat).
//   * Idle warning modal: shows at idle_warning_seconds, auto-logs-out at
//     idle_timeout_seconds.
//   * Post-call questionnaire: when the rep's `reps.status` flips to
//     'wrap_up' a modal opens. Soft 60s grace then auto-submit.
//   * ShiftBar: shown via children props from layout.

import * as React from 'react';
import { createClient } from '@/lib/supabase/client';
import { edgeFn } from '@/lib/supabase/edge';
import { ShiftBar } from '@/components/rep/ShiftBar';
import { IdleWarningModal } from '@/components/rep/IdleWarningModal';
import { CallOutcomeForm } from '@/components/rep/CallOutcomeForm';

interface Settings {
  rep_idle_timeout_seconds: number;
  rep_idle_warning_seconds: number;
  wrap_up_grace_seconds: number;
}
const DEFAULT_SETTINGS: Settings = {
  rep_idle_timeout_seconds: 600,
  rep_idle_warning_seconds: 540,
  wrap_up_grace_seconds: 60,
};

interface ShiftSession {
  id: string;
  started_at: string;
  rep_id: string;
}

interface RepRow {
  id: string;
  status: 'available' | 'busy' | 'offline' | 'on_call' | 'wrap_up';
  full_name: string | null;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const ACTIVITY_TICK_MS = 5_000;

export function RepSessionGate({
  userId,
  children,
}: {
  userId: string;
  children: React.ReactNode;
}) {
  const supabase = React.useMemo(() => createClient(), []);
  const lastActivityRef = React.useRef<number>(Date.now());
  const [settings, setSettings] = React.useState<Settings>(DEFAULT_SETTINGS);
  const [session, setSession] = React.useState<ShiftSession | null>(null);
  const [rep, setRep] = React.useState<RepRow | null>(null);
  const [showIdleWarning, setShowIdleWarning] = React.useState(false);
  const [pendingCallId, setPendingCallId] = React.useState<string | null>(null);

  // ----- Track activity -----
  React.useEffect(() => {
    const bump = () => { lastActivityRef.current = Date.now(); };
    const events = ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'];
    for (const e of events) window.addEventListener(e, bump, { passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, bump);
    };
  }, []);

  // ----- Load settings -----
  React.useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('admin_settings')
        .select('key, value')
        .in('key', [
          'rep_idle_timeout_seconds',
          'rep_idle_warning_seconds',
          'wrap_up_grace_seconds',
        ]);
      if (!data) return;
      const next = { ...DEFAULT_SETTINGS };
      for (const row of data) {
        const k = row.key as keyof Settings;
        const v = typeof row.value === 'number' ? row.value : Number(row.value);
        if (!Number.isNaN(v)) next[k] = v;
      }
      setSettings(next);
    })();
  }, [supabase]);

  // ----- Start shift -----
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await edgeFn('rep-shift/start', { method: 'POST' });
        const data = await res.json();
        if (!cancelled && data?.session) setSession(data.session);
      } catch (err) {
        console.error('[RepSessionGate] shift start failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ----- Subscribe to own reps row -----
  React.useEffect(() => {
    let mounted = true;
    (async () => {
      const { data } = await supabase
        .from('reps')
        .select('id, status, full_name')
        .eq('id', userId)
        .maybeSingle();
      if (mounted && data) setRep(data as RepRow);
    })();
    const channel = supabase
      .channel(`rep-self-${userId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'reps', filter: `id=eq.${userId}` },
        (payload) => {
          if (mounted) setRep(payload.new as RepRow);
        },
      )
      .subscribe();
    return () => {
      mounted = false;
      supabase.removeChannel(channel);
    };
  }, [supabase, userId]);

  // ----- When status flips to wrap_up, find the most recent ended call to question -----
  React.useEffect(() => {
    if (rep?.status !== 'wrap_up') {
      setPendingCallId(null);
      return;
    }
    (async () => {
      const { data } = await supabase
        .from('calls')
        .select('id')
        .eq('rep_id', userId)
        .not('ended_at', 'is', null)
        .order('ended_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data?.id) setPendingCallId(data.id);
    })();
  }, [rep?.status, supabase, userId]);

  // ----- Heartbeat + idle check tick -----
  React.useEffect(() => {
    let lastHeartbeat = 0;

    const tick = async () => {
      const now = Date.now();
      const onCall = rep?.status === 'on_call';
      // Active call counts as activity
      if (onCall) lastActivityRef.current = now;
      const idleMs = now - lastActivityRef.current;
      const idleSecs = Math.floor(idleMs / 1000);

      // Show warning modal at warning threshold
      if (idleSecs >= settings.rep_idle_warning_seconds && idleSecs < settings.rep_idle_timeout_seconds) {
        setShowIdleWarning(true);
      } else if (idleSecs < settings.rep_idle_warning_seconds) {
        setShowIdleWarning(false);
      }

      // Force logout
      if (idleSecs >= settings.rep_idle_timeout_seconds) {
        try {
          await edgeFn('rep-shift/end', {
            method: 'POST',
            body: JSON.stringify({ reason: 'idle_timeout' }),
          });
        } finally {
          await supabase.auth.signOut();
          window.location.href = '/login?reason=idle';
        }
        return;
      }

      // Heartbeat every HEARTBEAT_INTERVAL_MS
      if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
        lastHeartbeat = now;
        try {
          await edgeFn('rep-shift/heartbeat', { method: 'POST' });
        } catch (err) {
          console.warn('[RepSessionGate] heartbeat failed', err);
        }
      }
    };

    const id = window.setInterval(tick, ACTIVITY_TICK_MS);
    return () => window.clearInterval(id);
  }, [rep?.status, settings, supabase]);

  // ----- Manual clock-out -----
  const clockOut = React.useCallback(async () => {
    try {
      await edgeFn('rep-shift/end', {
        method: 'POST',
        body: JSON.stringify({ reason: 'manual' }),
      });
    } finally {
      await supabase.auth.signOut();
      window.location.href = '/login';
    }
  }, [supabase]);

  // ----- Stay-signed-in handler from idle modal -----
  const stayActive = React.useCallback(async () => {
    lastActivityRef.current = Date.now();
    setShowIdleWarning(false);
    try {
      await edgeFn('rep-shift/heartbeat', { method: 'POST' });
    } catch {}
  }, []);

  return (
    <>
      <ShiftBar
        startedAt={session?.started_at ?? null}
        repName={rep?.full_name ?? null}
        repStatus={rep?.status ?? 'offline'}
        onClockOut={clockOut}
      />
      {children}
      {showIdleWarning && (
        <IdleWarningModal
          idleTimeoutSeconds={settings.rep_idle_timeout_seconds}
          warningStartedAt={lastActivityRef.current + settings.rep_idle_warning_seconds * 1000}
          onStayActive={stayActive}
        />
      )}
      {rep?.status === 'wrap_up' && pendingCallId && (
        <CallOutcomeForm
          callId={pendingCallId}
          graceSeconds={settings.wrap_up_grace_seconds}
          onSubmitted={() => setPendingCallId(null)}
        />
      )}
    </>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { PageHeader } from '@/components/ui/page';
import { Loader2, Activity } from 'lucide-react';

type RepRow = {
  id: string;
  full_name: string;
  email: string | null;
  status: 'available' | 'on_call' | 'wrap_up' | 'busy' | 'offline' | 'break' | string;
};

type Session = {
  rep_id: string;
  started_at: string;
  total_call_seconds: number;
  ended_at: string | null;
  last_heartbeat_at: string | null;
};

const STATUS_BADGE: Record<string, string> = {
  available: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  on_call: 'bg-blue-500/15 text-blue-600 border-blue-500/30',
  wrap_up: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  busy: 'bg-rose-500/15 text-rose-600 border-rose-500/30',
  break: 'bg-purple-500/15 text-purple-600 border-purple-500/30',
  offline: 'bg-muted text-muted-foreground border-border',
};

function fmtHMS(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

export default function RepBoardPage() {
  const [reps, setReps] = useState<RepRow[]>([]);
  const [sessions, setSessions] = useState<Map<string, Session>>(new Map());
  const [todayCallSeconds, setTodayCallSeconds] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    const supabase = createClient();
    const [{ data: repData }, { data: openSessions }] = await Promise.all([
      supabase.from('reps').select('id, full_name, email, status').order('full_name'),
      supabase.from('rep_sessions').select('rep_id, started_at, total_call_seconds, ended_at, last_heartbeat_at').is('ended_at', null),
    ]);
    setReps(repData || []);
    setSessions(new Map((openSessions || []).map((s) => [s.rep_id, s as Session])));

    // Today's total call seconds per rep — sum calls.total_duration_seconds
    // for calls ended after midnight (rep's local — use UTC for now).
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const { data: callRows } = await supabase
      .from('calls')
      .select('rep_id, total_duration_seconds')
      .gte('ended_at', startOfDay.toISOString())
      .not('rep_id', 'is', null);
    const map = new Map<string, number>();
    for (const r of callRows || []) {
      const rid = r.rep_id as string;
      map.set(rid, (map.get(rid) || 0) + (r.total_duration_seconds || 0));
    }
    setTodayCallSeconds(map);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const supabase = createClient();
    const ch = supabase
      .channel('admin-rep-board')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reps' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rep_sessions' }, () => load())
      .subscribe();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { supabase.removeChannel(ch).catch(() => {}); clearInterval(tick); };
  }, [load]);

  const summary = useMemo(() => {
    const counts = { available: 0, on_call: 0, wrap_up: 0, busy: 0, offline: 0, break: 0 };
    for (const r of reps) {
      if (r.status in counts) (counts as Record<string, number>)[r.status]++;
    }
    return counts;
  }, [reps]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Rep board"
        description="Live status and shift activity"
        icon={<Activity className="h-5 w-5" />}
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
        {(['available', 'on_call', 'wrap_up', 'busy', 'break', 'offline'] as const).map((k) => (
          <div key={k} className="rounded-md border border-border bg-card p-3">
            <div className="text-xs uppercase text-muted-foreground">{k.replace('_', ' ')}</div>
            <div className="mt-1 text-2xl font-semibold">{summary[k]}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Rep</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Shift</th>
                <th className="px-3 py-2 font-medium">Today on calls</th>
                <th className="px-3 py-2 font-medium">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {reps.map((r) => {
                const sess = sessions.get(r.id);
                const shiftSec = sess ? (now - new Date(sess.started_at).getTime()) / 1000 : 0;
                const callsToday = todayCallSeconds.get(r.id) || 0;
                const lastActivity = sess?.last_heartbeat_at
                  ? Math.floor((now - new Date(sess.last_heartbeat_at).getTime()) / 1000)
                  : null;
                return (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <Link href={`/admin/reps/${r.id}`} className="font-medium hover:underline">
                        {r.full_name}
                      </Link>
                      <div className="text-xs text-muted-foreground">{r.email}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[r.status] || STATUS_BADGE.offline}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {sess ? fmtHMS(shiftSec) : '—'}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{fmtHMS(callsToday)}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {lastActivity == null ? '—' : lastActivity < 60 ? `${lastActivity}s ago` : `${Math.floor(lastActivity / 60)}m ago`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

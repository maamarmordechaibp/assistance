'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, AlertTriangle, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { edgeFn } from '@/lib/supabase/edge';
import { Button } from '@/components/ui/button';

type Alert = {
  id: string;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  payload: Record<string, unknown> | null;
  created_at: string;
  seen_at: string | null;
};

const KIND_LABEL: Record<string, string> = {
  missed_call: 'Missed call',
  rep_idle: 'Rep auto-logged out',
  rep_no_answer: 'Rep ignored a call',
  rep_force_logout: 'Rep force-logged out',
  behavior_critical: 'Critical: rep behavior',
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export default function AlertsBell() {
  const [open, setOpen] = useState(false);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await edgeFn('admin-alerts?unseen=1&limit=20', { method: 'GET' });
      const json = (await res.json().catch(() => null)) as { alerts?: Alert[] } | null;
      if (json?.alerts) setAlerts(json.alerts);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + realtime subscribe
  useEffect(() => {
    load();
    const supabase = createClient();
    const ch = supabase
      .channel('admin-alerts-bell')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'admin_alerts' },
        () => load(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch).catch(() => {});
    };
  }, [load]);

  // Click-outside to close
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [open]);

  const ackOne = async (id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    await edgeFn('admin-alerts', { method: 'POST', body: JSON.stringify({ id }) }).catch(() => {});
  };
  const ackAll = async () => {
    setAlerts([]);
    await edgeFn('admin-alerts?ack_all=1', { method: 'POST' }).catch(() => {});
  };

  const unseenCount = alerts.length;
  const hasCritical = alerts.some((a) => a.severity === 'critical');

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={`Alerts${unseenCount ? ` (${unseenCount} new)` : ''}`}
        onClick={() => setOpen((v) => !v)}
        className={`relative inline-flex h-9 w-9 items-center justify-center rounded-md border transition ${
          hasCritical
            ? 'animate-pulse border-rose-500/60 bg-rose-500/10 text-rose-500'
            : 'border-border bg-background hover:bg-muted'
        }`}
      >
        <Bell className="h-4 w-4" />
        {unseenCount > 0 && (
          <span className={`absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium text-white ${hasCritical ? 'bg-rose-600' : 'bg-blue-600'}`}>
            {unseenCount > 99 ? '99+' : unseenCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-50 w-96 max-w-[90vw] overflow-hidden rounded-md border border-border bg-card shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-medium">Alerts</span>
            <div className="flex items-center gap-2">
              {alerts.length > 0 && (
                <Button size="sm" variant="ghost" onClick={ackAll}>Mark all read</Button>
              )}
              <button type="button" onClick={() => setOpen(false)} aria-label="Close">
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {loading && alerts.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">Loading…</div>
            ) : alerts.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">No new alerts</div>
            ) : (
              alerts.map((a) => {
                const isCritical = a.severity === 'critical';
                const isWarning = a.severity === 'warning';
                return (
                  <div key={a.id} className={`flex items-start gap-3 border-b border-border px-3 py-2 last:border-0 ${isCritical ? 'bg-rose-500/5' : ''}`}>
                    <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${isCritical ? 'text-rose-500' : isWarning ? 'text-amber-500' : 'text-muted-foreground'}`} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{KIND_LABEL[a.kind] || a.kind}</div>
                      <div className="text-xs text-muted-foreground">{timeAgo(a.created_at)}</div>
                      {a.payload && Object.keys(a.payload).length > 0 && (
                        <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                          {JSON.stringify(a.payload, null, 0).slice(0, 300)}
                        </pre>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => ackOne(a.id)}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Dismiss
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

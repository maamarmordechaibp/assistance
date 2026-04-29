'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Clock, LogOut } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ShiftBarProps {
  startedAt: string | null;
  repName: string | null;
  repStatus: 'available' | 'busy' | 'offline' | 'on_call' | 'wrap_up';
  onClockOut: () => void;
}

function formatHMS(totalSeconds: number) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const STATUS_PILL: Record<ShiftBarProps['repStatus'], { label: string; className: string }> = {
  available: { label: 'Available', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' },
  on_call:   { label: 'On call',  className: 'bg-blue-500/15 text-blue-700 dark:text-blue-400' },
  wrap_up:   { label: 'Wrap-up',  className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  busy:      { label: 'Busy',     className: 'bg-rose-500/15 text-rose-700 dark:text-rose-400' },
  offline:   { label: 'Offline',  className: 'bg-muted text-muted-foreground' },
};

export function ShiftBar({ startedAt, repName, repStatus, onClockOut }: ShiftBarProps) {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const elapsed = startedAt
    ? Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000))
    : 0;

  const pill = STATUS_PILL[repStatus] ?? STATUS_PILL.offline;
  const [confirming, setConfirming] = React.useState(false);

  return (
    <div className="sticky top-14 z-10 flex flex-wrap items-center gap-3 border-b border-border bg-card/80 px-4 py-2 backdrop-blur-md sm:px-6">
      <Clock className="size-4 text-muted-foreground" aria-hidden="true" />
      <span className="font-mono text-sm tabular-nums" aria-live="polite">
        {startedAt ? formatHMS(elapsed) : '--:--:--'}
      </span>
      <span className="text-xs text-muted-foreground">on shift</span>

      <span
        className={cn(
          'inline-flex h-6 items-center rounded-full px-2 text-xs font-medium',
          pill.className,
        )}
        aria-label={`Status: ${pill.label}`}
      >
        {pill.label}
      </span>

      {repName && <span className="ml-auto text-sm text-muted-foreground">{repName}</span>}

      {!confirming ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setConfirming(true)}
          className="text-xs"
        >
          <LogOut className="mr-1 size-3.5" aria-hidden="true" />
          Clock out
        </Button>
      ) : (
        <span className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">End shift?</span>
          <Button size="sm" variant="destructive" onClick={onClockOut}>Yes, clock out</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
        </span>
      )}
    </div>
  );
}

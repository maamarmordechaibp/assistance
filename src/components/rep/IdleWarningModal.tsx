'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';

interface IdleWarningModalProps {
  /** Wall-clock time when forced logout will fire (ms epoch). */
  warningStartedAt: number;
  /** Total idle timeout in seconds (used to compute remaining). */
  idleTimeoutSeconds: number;
  onStayActive: () => void;
}

/**
 * Idle warning modal — shows a countdown until forced logout.
 * Any user input (mousemove/keydown/click) outside this modal is already
 * tracked by RepSessionGate; clicking the button gives the same effect
 * but explicitly resets the activity timestamp.
 */
export function IdleWarningModal({
  warningStartedAt,
  idleTimeoutSeconds,
  onStayActive,
}: IdleWarningModalProps) {
  const logoutAt = warningStartedAt + idleTimeoutSeconds * 1000;
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const remaining = Math.max(0, Math.ceil((logoutAt - now) / 1000));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="idle-warning-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="w-full max-w-sm rounded-lg border border-border bg-background p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 text-amber-500" aria-hidden="true" />
          <div className="flex-1">
            <h2 id="idle-warning-title" className="text-base font-semibold">
              Are you still there?
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              You'll be clocked out automatically in{' '}
              <span className="font-mono font-semibold tabular-nums">{remaining}s</span>{' '}
              due to inactivity.
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <Button onClick={onStayActive} autoFocus>
            I'm still here
          </Button>
        </div>
      </div>
    </div>
  );
}

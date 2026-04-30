'use client';

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle, Copy, RefreshCw, X, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';

const LAUNCHER_HEALTH_URL = 'http://localhost:17345/health';

// Public installer URL — served from /public/launcher/install.ps1.
// Reps paste a single line into PowerShell to install + start it.
const INSTALL_URL =
  typeof window !== 'undefined'
    ? `${window.location.origin}/launcher/install.ps1`
    : 'https://offlinesbrowse.com/launcher/install.ps1';

const ONE_LINER = `irm ${INSTALL_URL} | iex`;

type Status = 'checking' | 'ok' | 'missing';

async function probeLauncher(): Promise<boolean> {
  try {
    const res = await fetch(LAUNCHER_HEALTH_URL, { method: 'GET', cache: 'no-store' });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return Boolean(data?.ok);
  } catch {
    return false;
  }
}

/**
 * Polls the local launcher and shows a banner + modal when missing.
 * Reps copy a single PowerShell command to install on their own PC.
 *
 * Use the exported `useLauncherSetup` hook elsewhere to imperatively
 * open the modal (e.g. from an "Open Chrome" failure toast action).
 */
export function LauncherSetup({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const [status, setStatus] = useState<Status>('checking');
  const [dismissed, setDismissed] = useState(false);

  const check = useCallback(async () => {
    setStatus('checking');
    const ok = await probeLauncher();
    setStatus(ok ? 'ok' : 'missing');
    return ok;
  }, []);

  useEffect(() => {
    void check();
    // Re-check periodically — picks up the launcher as soon as it boots.
    const id = window.setInterval(() => { void check(); }, 15_000);
    return () => window.clearInterval(id);
  }, [check]);

  // Auto-dismiss the banner once the launcher comes up.
  useEffect(() => {
    if (status === 'ok') setDismissed(false);
  }, [status]);

  const showBanner = status === 'missing' && !dismissed && !open;

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(ONE_LINER);
      toast.success('Command copied. Paste it into PowerShell.');
    } catch {
      toast.error('Could not copy. Select the command manually.');
    }
  };

  return (
    <>
      {showBanner && (
        <div className="mb-4 flex items-start gap-3 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="flex-1">
            <div className="font-medium">Customer browser is not set up on this PC</div>
            <div className="mt-0.5 text-muted-foreground">
              You won&apos;t be able to open Chrome windows for customers until you install
              the local launcher. It only takes a few seconds.
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => onOpenChange(true)}>
              Set up my PC
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDismissed(true)} aria-label="Dismiss">
              <X className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => onOpenChange(false)}
        >
          <div
            className="w-full max-w-xl rounded-lg border border-border bg-background p-6 shadow-elev-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Set up Customer Browser on your PC</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  This is a one-time setup. The launcher runs hidden in the background and
                  starts automatically every time you sign in to Windows.
                </p>
              </div>
              <Button size="icon-sm" variant="ghost" onClick={() => onOpenChange(false)} aria-label="Close">
                <X className="size-4" />
              </Button>
            </div>

            <ol className="mt-5 space-y-4 text-sm">
              <li className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-xs">
                  1
                </span>
                <div>
                  Right-click the Windows <strong>Start</strong> button and choose{' '}
                  <strong>&ldquo;Terminal&rdquo;</strong> or{' '}
                  <strong>&ldquo;Windows PowerShell&rdquo;</strong>.
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-xs">
                  2
                </span>
                <div className="flex-1">
                  <div>Paste this command and press <strong>Enter</strong>:</div>
                  <div className="mt-2 flex items-stretch gap-2">
                    <code className="flex-1 select-all overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs">
                      {ONE_LINER}
                    </code>
                    <Button size="sm" variant="outline" onClick={copyCommand}>
                      <Copy className="size-3.5" /> Copy
                    </Button>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    Windows may briefly show a security prompt — click <strong>Yes</strong> /{' '}
                    <strong>Run</strong> if it does.
                  </div>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-xs">
                  3
                </span>
                <div>
                  When PowerShell prints <strong>&ldquo;Done&rdquo;</strong>, come back here and
                  click <strong>Re-check</strong>. You&apos;re finished.
                </div>
              </li>
            </ol>

            <div className="mt-6 flex items-center justify-between gap-3 border-t border-border pt-4">
              <div className="flex items-center gap-2 text-sm">
                {status === 'checking' && (
                  <>
                    <RefreshCw className="size-4 animate-spin text-muted-foreground" />
                    <span className="text-muted-foreground">Checking launcher…</span>
                  </>
                )}
                {status === 'ok' && (
                  <>
                    <CheckCircle className="size-4 text-success" />
                    <span className="text-success">Launcher is running on this PC.</span>
                  </>
                )}
                {status === 'missing' && (
                  <>
                    <Terminal className="size-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Launcher not detected yet.</span>
                  </>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    const ok = await check();
                    if (ok) toast.success('Launcher detected. You can close this window.');
                    else toast.error('Still not detected. Make sure the install command finished.');
                  }}
                >
                  <RefreshCw className="size-3.5" /> Re-check
                </Button>
                {status === 'ok' ? (
                  <Button size="sm" onClick={() => onOpenChange(false)}>
                    Close
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

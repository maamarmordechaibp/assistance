import * as React from 'react';
import { Logo } from '@/components/brand/logo';
import { ShieldCheck, Headphones, Sparkles } from 'lucide-react';

interface AuthShellProps {
  children: React.ReactNode;
  /** Optional override for the marketing panel headline. */
  headline?: React.ReactNode;
  subhead?: React.ReactNode;
}

export function AuthShell({ children, headline, subhead }: AuthShellProps) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel */}
      <aside className="relative hidden overflow-hidden bg-sidebar text-sidebar-foreground lg:block">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,hsl(var(--accent)/0.25),transparent_55%),radial-gradient(circle_at_75%_80%,hsl(var(--primary)/0.4),transparent_60%)]" />
        <div className="absolute inset-0 opacity-[0.06] [background-image:linear-gradient(to_right,white_1px,transparent_1px),linear-gradient(to_bottom,white_1px,transparent_1px)] [background-size:48px_48px]" />

        <div className="relative flex h-full flex-col justify-between p-10 xl:p-14">
          <div className="flex items-center gap-3">
            <Logo variant="mark" size={36} />
            <span className="text-lg font-semibold tracking-tight">Offline</span>
          </div>

          <div className="max-w-md">
            <h2 className="text-3xl font-semibold leading-tight tracking-tight xl:text-4xl">
              {headline ?? 'Live customer assistance, focused.'}
            </h2>
            <p className="mt-4 text-sm text-sidebar-muted xl:text-base">
              {subhead ??
                'A calm, single-screen workspace for your reps — softphone, customer context, AI brief, payments and orders, all in one place.'}
            </p>

            <ul className="mt-8 space-y-3 text-sm text-sidebar-foreground/90">
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-accent">
                  <Headphones className="size-4" />
                </span>
                <span>Inbound + outbound calling with WebRTC, mute &amp; transcripts.</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-accent">
                  <Sparkles className="size-4" />
                </span>
                <span>AI intake brief and post-call analysis on every conversation.</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-accent">
                  <ShieldCheck className="size-4" />
                </span>
                <span>Vault-stored credentials, audited access, role-based controls.</span>
              </li>
            </ul>
          </div>

          <div className="text-xs text-sidebar-muted">
            &copy; {new Date().getFullYear()} Offline
          </div>
        </div>
      </aside>

      {/* Form panel */}
      <main className="flex items-center justify-center bg-background p-6 sm:p-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <Logo variant="mark" size={28} />
            <span className="text-base font-semibold tracking-tight">Offline</span>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

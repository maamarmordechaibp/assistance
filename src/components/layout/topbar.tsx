'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { cn } from '@/lib/utils';

interface TopbarProps {
  role: 'admin' | 'rep';
  /** Optional right-side slot (e.g. status badge, page-level action). */
  trailing?: React.ReactNode;
}

const ROUTE_LABELS: Record<string, string> = {
  admin: 'Admin',
  rep: 'Rep',
  customers: 'Customers',
  reps: 'Representatives',
  calls: 'Call review',
  voicemails: 'Voicemails',
  feedback: 'Feedback',
  packages: 'Packages',
  finance: 'Finance',
  reports: 'Reports',
  ivr: 'IVR editor',
  settings: 'Settings',
  history: 'Call history',
  callbacks: 'Callbacks',
  payments: 'Payments',
};

function labelFor(seg: string) {
  if (ROUTE_LABELS[seg]) return ROUTE_LABELS[seg];
  // Detail routes — IDs become "Detail"
  if (/^[0-9a-f-]{8,}$/i.test(seg)) return 'Detail';
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

export function Topbar({ role, trailing }: TopbarProps) {
  const pathname = usePathname();
  const segments = pathname.split('/').filter(Boolean);

  const crumbs = segments.map((seg, i) => {
    const href = '/' + segments.slice(0, i + 1).join('/');
    const isFirst = i === 0;
    return {
      label: isFirst ? (role === 'admin' ? 'Admin' : 'Rep') : labelFor(seg),
      href,
      isLast: i === segments.length - 1,
    };
  });

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-md sm:px-6">
      <button
        type="button"
        className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
        aria-label="Open menu"
      >
        <Menu className="size-4" />
      </button>

      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        {crumbs.map((c, i) => (
          <React.Fragment key={c.href}>
            {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />}
            {c.isLast ? (
              <span className="truncate font-medium text-foreground">{c.label}</span>
            ) : (
              <Link
                href={c.href}
                className={cn(
                  'truncate text-muted-foreground transition-colors hover:text-foreground',
                  i === 0 && 'hidden sm:inline'
                )}
              >
                {c.label}
              </Link>
            )}
          </React.Fragment>
        ))}
      </nav>

      <div className="flex items-center gap-1.5">
        {trailing}
        <ThemeToggle />
      </div>
    </header>
  );
}

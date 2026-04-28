'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Phone,
  Users,
  History,
  PhoneCall,
  LogOut,
  Settings,
  BarChart3,
  FileText,
  CreditCard,
  Package,
  Wallet,
  Star,
  Voicemail,
  MessageSquare,
  Mail,
  Truck,
  ChevronLeft,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { edgeFn } from '@/lib/supabase/edge';
import { cn } from '@/lib/utils';
import { Logo } from '@/components/brand/logo';

interface SidebarProps {
  role: 'admin' | 'rep';
  userName: string;
}

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  group?: string;
}

const repLinks: NavItem[] = [
  { href: '/rep', label: 'Workspace', icon: LayoutDashboard, group: 'Work' },
  { href: '/rep/callbacks', label: 'Callbacks', icon: PhoneCall, group: 'Work' },
  { href: '/rep/emails', label: 'Emails', icon: Mail, group: 'Work' },
  { href: '/rep/history', label: 'Call history', icon: History, group: 'Work' },
  { href: '/rep/customers', label: 'Customers', icon: Users, group: 'Records' },
  { href: '/rep/payments', label: 'Payments', icon: CreditCard, group: 'Records' },
];

const adminLinks: NavItem[] = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard, group: 'Overview' },
  { href: '/admin/reports', label: 'Reports', icon: BarChart3, group: 'Overview' },
  { href: '/admin/calls', label: 'Call review', icon: FileText, group: 'Operations' },
  { href: '/admin/voicemails', label: 'Voicemails', icon: Voicemail, group: 'Operations' },
  { href: '/admin/emails', label: 'Emails', icon: Mail, group: 'Operations' },
  { href: '/admin/orders', label: 'Orders', icon: Truck, group: 'Operations' },
  { href: '/admin/feedback', label: 'Feedback', icon: Star, group: 'Operations' },
  { href: '/admin/customers', label: 'Customers', icon: Users, group: 'Records' },
  { href: '/admin/reps', label: 'Representatives', icon: Phone, group: 'Records' },
  { href: '/admin/finance', label: 'Finance', icon: Wallet, group: 'Business' },
  { href: '/admin/packages', label: 'Packages', icon: Package, group: 'Business' },
  { href: '/admin/ivr', label: 'IVR editor', icon: MessageSquare, group: 'System' },
  { href: '/admin/settings', label: 'Settings', icon: Settings, group: 'System' },
];

const STORAGE_KEY = 'offline-sidebar-collapsed';

export default function Sidebar({ role, userName }: SidebarProps) {
  const pathname = usePathname();
  const links = role === 'admin' ? adminLinks : repLinks;

  const [collapsed, setCollapsed] = React.useState(false);
  React.useEffect(() => {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v === '1') setCollapsed(true);
    } catch {}
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {}
      return next;
    });
  };

  const handleLogout = async () => {
    try {
      await edgeFn('reps-me', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'offline' }),
      });
    } catch {}
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  };

  const grouped: { name: string; items: NavItem[] }[] = [];
  for (const link of links) {
    const g = link.group || '';
    let bucket = grouped.find((x) => x.name === g);
    if (!bucket) {
      bucket = { name: g, items: [] };
      grouped.push(bucket);
    }
    bucket.items.push(link);
  }

  const isActive = (href: string) =>
    pathname === href ||
    (href !== '/rep' && href !== '/admin' && pathname.startsWith(href + '/'));

  const initials =
    (userName || '?')
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase())
      .join('') || 'U';

  return (
    <aside
      className={cn(
        'sticky top-0 z-30 hidden h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 lg:flex',
        collapsed ? 'w-[68px]' : 'w-64'
      )}
    >
      <div
        className={cn(
          'flex h-16 items-center border-b border-sidebar-border',
          collapsed ? 'justify-center px-0' : 'px-5'
        )}
      >
        <Link
          href={role === 'admin' ? '/admin' : '/rep'}
          className="flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Logo variant="mark" size={32} />
          {!collapsed && (
            <span className="text-[17px] font-bold tracking-tight text-sidebar-foreground leading-none">
              Offline
            </span>
          )}
        </Link>
      </div>

      <nav className={cn('flex-1 overflow-y-auto py-3', collapsed ? 'px-2' : 'px-3')}>
        {grouped.map((group) => (
          <div key={group.name || 'default'} className="mb-4">
            {!collapsed && group.name ? (
              <div className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-sidebar-muted">
                {group.name}
              </div>
            ) : null}
            <ul className="space-y-0.5">
              {group.items.map((link) => {
                const active = isActive(link.href);
                const Icon = link.icon;
                return (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      title={collapsed ? link.label : undefined}
                      className={cn(
                        'group relative flex items-center gap-3 rounded-md text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                        collapsed ? 'h-10 w-full justify-center px-0' : 'h-9 px-2.5',
                        active
                          ? 'bg-accent/15 text-accent'
                          : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
                      )}
                    >
                      {active && (
                        <span
                          className="absolute left-0 top-1 bottom-1 w-1 rounded-r-full bg-accent"
                          aria-hidden
                        />
                      )}
                      <Icon
                        className={cn(
                          'size-[18px] shrink-0',
                          active
                            ? 'text-accent'
                            : 'text-sidebar-muted group-hover:text-sidebar-foreground'
                        )}
                      />
                      {!collapsed && <span className="truncate">{link.label}</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className={cn('border-t border-sidebar-border p-3', collapsed && 'px-2')}>
        <div
          className={cn(
            'flex items-center gap-3 rounded-md p-2',
            collapsed && 'justify-center p-0'
          )}
        >
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground">
            {initials}
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-sidebar-foreground">
                {userName}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-sidebar-muted">
                {role}
              </div>
            </div>
          )}
          {!collapsed && (
            <button
              onClick={handleLogout}
              title="Sign out"
              className="rounded-md p-1.5 text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <LogOut className="size-4" />
            </button>
          )}
        </div>
        {collapsed && (
          <button
            onClick={handleLogout}
            title="Sign out"
            className="mt-2 flex w-full items-center justify-center rounded-md p-2 text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <LogOut className="size-4" />
          </button>
        )}

        <button
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand' : 'Collapse'}
          className={cn(
            'mt-2 flex items-center gap-2 rounded-md text-xs text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            collapsed ? 'h-9 w-full justify-center' : 'h-8 w-full px-2.5'
          )}
        >
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}

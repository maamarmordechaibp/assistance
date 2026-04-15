'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
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
  Shield,
  CreditCard,
  Package,
  Wallet,
  Star,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface SidebarProps {
  role: 'admin' | 'rep';
  userName: string;
}

const repLinks = [
  { href: '/rep', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/rep/history', label: 'Call History', icon: History },
  { href: '/rep/customers', label: 'Customers', icon: Users },
  { href: '/rep/callbacks', label: 'Callbacks', icon: PhoneCall },
  { href: '/rep/payments', label: 'Payments', icon: CreditCard },
];

const adminLinks = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/customers', label: 'Customers', icon: Users },
  { href: '/admin/reps', label: 'Representatives', icon: Phone },
  { href: '/admin/calls', label: 'Call Review', icon: FileText },
  { href: '/admin/feedback', label: 'Feedback', icon: Star },
  { href: '/admin/packages', label: 'Packages', icon: Package },
  { href: '/admin/finance', label: 'Finance', icon: Wallet },
  { href: '/admin/reports', label: 'Reports', icon: BarChart3 },
  { href: '/admin/settings', label: 'Settings', icon: Settings },
];

export default function Sidebar({ role, userName }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const links = role === 'admin' ? adminLinks : repLinks;

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
  };

  return (
    <aside className="w-64 bg-gray-900 text-white flex flex-col min-h-screen">
      <div className="p-6 border-b border-gray-800">
        <h1 className="text-lg font-bold">CallVault</h1>
        <div className="flex items-center gap-2 mt-2">
          <Shield className="w-4 h-4 text-gray-400" />
          <span className="text-sm text-gray-400 capitalize">{role}</span>
        </div>
      </div>

      <nav className="flex-1 p-4 space-y-1">
        {links.map((link) => {
          const isActive =
            pathname === link.href ||
            (link.href !== '/rep' &&
              link.href !== '/admin' &&
              pathname.startsWith(link.href));
          const Icon = link.icon;

          return (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition',
                isActive
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-300 hover:bg-gray-800 hover:text-white'
              )}
            >
              <Icon className="w-5 h-5" />
              {link.label}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-gray-800">
        <div className="text-sm text-gray-400 mb-3 truncate">{userName}</div>
        <button
          onClick={handleLogout}
          className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition w-full"
        >
          <LogOut className="w-4 h-4" />
          Sign Out
        </button>
      </div>
    </aside>
  );
}

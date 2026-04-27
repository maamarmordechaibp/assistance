'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { formatMinutes, formatCurrency } from '@/lib/utils';
import {
  LayoutDashboard,
  Users,
  Phone,
  DollarSign,
  Clock,
  AlertTriangle,
  TrendingUp,
  PhoneCall,
  Activity,
} from 'lucide-react';
import { PageHeader, StatCard } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface Stats {
  totalCustomers: number;
  totalReps: number;
  totalCallsToday: number;
  totalMinutesToday: number;
  totalRevenueToday: number;
  flaggedCalls: number;
  pendingCallbacks: number;
  activeCalls: number;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    async function fetchStats() {
      try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayISO = today.toISOString();

        const [
          { count: customerCount },
          { count: repCount },
          { data: todayCalls },
          { count: flaggedCount },
          { count: callbackCount },
          { data: todayPayments },
          { data: activeCalls },
        ] = await Promise.all([
          supabase.from('customers').select('*', { count: 'exact', head: true }),
          supabase.from('reps').select('*', { count: 'exact', head: true }),
          supabase.from('calls').select('minutes_deducted').gte('started_at', todayISO),
          supabase.from('calls').select('*', { count: 'exact', head: true }).eq('flag_status', 'flagged'),
          supabase.from('callback_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
          supabase.from('payments').select('amount_paid').eq('payment_status', 'completed').gte('created_at', todayISO),
          supabase.from('calls').select('id').is('ended_at', null).not('connected_at', 'is', null),
        ]);

        const totalMinutes =
          todayCalls?.reduce((sum, c) => sum + (c.minutes_deducted || 0), 0) || 0;
        const totalRevenue =
          todayPayments?.reduce((sum, p) => sum + (p.amount_paid || 0), 0) || 0;

        setStats({
          totalCustomers: customerCount || 0,
          totalReps: repCount || 0,
          totalCallsToday: todayCalls?.length || 0,
          totalMinutesToday: totalMinutes,
          totalRevenueToday: totalRevenue,
          flaggedCalls: flaggedCount || 0,
          pendingCallbacks: callbackCount || 0,
          activeCalls: activeCalls?.length || 0,
        });
      } catch (err) {
        console.error('Stats error:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchStats();
  }, []);

  return (
    <div className="space-y-8">
      <PageHeader
        icon={<LayoutDashboard />}
        title="Dashboard"
        description="Today's activity, billed minutes, and items needing attention."
        actions={
          <>
            <Badge variant={stats && stats.activeCalls > 0 ? 'success' : 'muted'} className="gap-1.5">
              <span
                className={`size-2 rounded-full ${
                  stats && stats.activeCalls > 0 ? 'bg-success pulse-ring' : 'bg-muted-foreground/40'
                }`}
              />
              {stats?.activeCalls ?? 0} active call{(stats?.activeCalls ?? 0) === 1 ? '' : 's'}
            </Badge>
            <Button asChild variant="outline" size="sm">
              <Link href="/admin/reports">View reports</Link>
            </Button>
          </>
        }
      />

      {/* Today */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Today</h2>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Revenue today"
            value={formatCurrency(stats?.totalRevenueToday || 0)}
            icon={<DollarSign />}
            accent="success"
            loading={loading}
          />
          <StatCard
            label="Calls today"
            value={stats?.totalCallsToday ?? 0}
            icon={<Phone />}
            accent="accent"
            loading={loading}
          />
          <StatCard
            label="Minutes billed"
            value={formatMinutes(stats?.totalMinutesToday || 0)}
            icon={<Clock />}
            accent="default"
            loading={loading}
          />
          <StatCard
            label="Active right now"
            value={stats?.activeCalls ?? 0}
            icon={<Activity />}
            accent={stats && stats.activeCalls > 0 ? 'success' : 'default'}
            loading={loading}
          />
        </div>
      </section>

      {/* Needs attention */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Needs attention</h2>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Link href="/admin/calls?filter=flagged" className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <StatCard
              label="Flagged calls"
              value={stats?.flaggedCalls ?? 0}
              icon={<AlertTriangle />}
              accent={stats && stats.flaggedCalls > 0 ? 'warning' : 'default'}
              hint="Review and dismiss or escalate"
              loading={loading}
            />
          </Link>
          <Link href="/admin/voicemails" className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <StatCard
              label="Pending callbacks"
              value={stats?.pendingCallbacks ?? 0}
              icon={<PhoneCall />}
              accent={stats && stats.pendingCallbacks > 0 ? 'warning' : 'default'}
              hint="Customers waiting for a return call"
              loading={loading}
            />
          </Link>
        </div>
      </section>

      {/* Org overview */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Organization</h2>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <StatCard
            label="Customers"
            value={stats?.totalCustomers ?? 0}
            icon={<Users />}
            accent="default"
            loading={loading}
          />
          <StatCard
            label="Representatives"
            value={stats?.totalReps ?? 0}
            icon={<TrendingUp />}
            accent="default"
            loading={loading}
          />
        </div>
      </section>
    </div>
  );
}

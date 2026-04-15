'use client';

import { useEffect, useState } from 'react';
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
  Loader2,
} from 'lucide-react';

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
          supabase
            .from('calls')
            .select('minutes_deducted')
            .gte('started_at', todayISO),
          supabase
            .from('calls')
            .select('*', { count: 'exact', head: true })
            .eq('flag_status', 'flagged'),
          supabase
            .from('callback_requests')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'pending'),
          supabase
            .from('payments')
            .select('amount_paid')
            .eq('payment_status', 'completed')
            .gte('created_at', todayISO),
          supabase
            .from('calls')
            .select('id')
            .is('ended_at', null)
            .not('connected_at', 'is', null),
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const cards = [
    {
      label: 'Total Customers',
      value: stats?.totalCustomers || 0,
      icon: Users,
      color: 'bg-blue-100 text-blue-600',
    },
    {
      label: 'Total Reps',
      value: stats?.totalReps || 0,
      icon: Phone,
      color: 'bg-green-100 text-green-600',
    },
    {
      label: 'Calls Today',
      value: stats?.totalCallsToday || 0,
      icon: Phone,
      color: 'bg-purple-100 text-purple-600',
    },
    {
      label: 'Minutes Today',
      value: formatMinutes(stats?.totalMinutesToday || 0),
      icon: Clock,
      color: 'bg-orange-100 text-orange-600',
    },
    {
      label: 'Revenue Today',
      value: formatCurrency(stats?.totalRevenueToday || 0),
      icon: DollarSign,
      color: 'bg-emerald-100 text-emerald-600',
    },
    {
      label: 'Active Calls',
      value: stats?.activeCalls || 0,
      icon: TrendingUp,
      color: 'bg-cyan-100 text-cyan-600',
    },
    {
      label: 'Flagged Calls',
      value: stats?.flaggedCalls || 0,
      icon: AlertTriangle,
      color: 'bg-red-100 text-red-600',
    },
    {
      label: 'Pending Callbacks',
      value: stats?.pendingCallbacks || 0,
      icon: Phone,
      color: 'bg-yellow-100 text-yellow-600',
    },
  ];

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold flex items-center gap-2">
        <LayoutDashboard className="w-5 h-5" />
        Admin Dashboard
      </h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((card) => (
          <div
            key={card.label}
            className="bg-white rounded-xl shadow-sm border p-5"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-gray-600">{card.label}</span>
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${card.color}`}>
                <card.icon className="w-5 h-5" />
              </div>
            </div>
            <div className="text-2xl font-bold">{card.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

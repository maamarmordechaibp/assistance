'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { PageHeader } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { formatMinutes, formatDuration, formatCurrency } from '@/lib/utils';
import { BarChart3, Loader2, Calendar } from 'lucide-react';

interface ReportData {
  totalCalls: number;
  totalMinutesBilled: number;
  totalRevenue: number;
  avgCallDuration: number;
  resolvedCalls: number;
  unresolvedCalls: number;
  flaggedCalls: number;
  topCategories: Array<{ name: string; count: number }>;
  repStats: Array<{ name: string; calls: number; minutes: number; avgDuration: number }>;
}

export default function AdminReports() {
  const [report, setReport] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(7);
  const supabase = createClient();

  useEffect(() => {
    async function fetchReport() {
      setLoading(true);
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - days);
      const since = sinceDate.toISOString();

      try {
        const { data: calls } = await supabase
          .from('calls')
          .select(`
            *,
            rep:reps(full_name),
            task_category:task_categories(name)
          `)
          .gte('started_at', since);

        const { data: payments } = await supabase
          .from('payments')
          .select('amount_paid')
          .eq('payment_status', 'completed')
          .gte('created_at', since);

        if (!calls) { setLoading(false); return; }

        const totalCalls = calls.length;
        const totalMinutes = calls.reduce((s, c) => s + (c.minutes_deducted || 0), 0);
        const totalRevenue = payments?.reduce((s, p) => s + (p.amount_paid || 0), 0) || 0;
        const durations = calls.filter(c => c.total_duration_seconds).map(c => c.total_duration_seconds!);
        const avgDuration = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

        const resolved = calls.filter(c => c.outcome_status === 'resolved').length;
        const unresolved = calls.filter(c => c.outcome_status === 'unresolved').length;
        const flagged = calls.filter(c => c.flag_status === 'flagged').length;

        // Category breakdown
        const catCounts: Record<string, number> = {};
        calls.forEach(c => {
          const name = c.task_category?.name || 'Uncategorized';
          catCounts[name] = (catCounts[name] || 0) + 1;
        });
        const topCategories = Object.entries(catCounts)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count);

        // Rep breakdown
        const repMap: Record<string, { name: string; calls: number; minutes: number; totalDuration: number }> = {};
        calls.forEach(c => {
          const repName = c.rep?.full_name || 'Unassigned';
          if (!repMap[repName]) repMap[repName] = { name: repName, calls: 0, minutes: 0, totalDuration: 0 };
          repMap[repName].calls++;
          repMap[repName].minutes += c.minutes_deducted || 0;
          repMap[repName].totalDuration += c.total_duration_seconds || 0;
        });
        const repStats = Object.values(repMap)
          .map(r => ({ ...r, avgDuration: r.calls ? r.totalDuration / r.calls : 0 }))
          .sort((a, b) => b.calls - a.calls);

        setReport({
          totalCalls,
          totalMinutesBilled: totalMinutes,
          totalRevenue,
          avgCallDuration: avgDuration,
          resolvedCalls: resolved,
          unresolvedCalls: unresolved,
          flaggedCalls: flagged,
          topCategories,
          repStats,
        });
      } catch (err) {
        console.error('Report error:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchReport();
  }, [days]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<BarChart3 />}
        title="Reports"
        description="Performance metrics and trends across reps and calls."
        actions={
          <div className="flex gap-1">
            {[7, 14, 30, 90].map((d) => (
              <Button
                key={d}
                variant={days === d ? 'accent' : 'outline'}
                size="sm"
                onClick={() => setDays(d)}
              >
                {d}d
              </Button>
            ))}
          </div>
        }
      />

      {report && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-card rounded-xl shadow-sm border p-5">
              <div className="text-sm text-muted-foreground">Total Calls</div>
              <div className="text-2xl font-bold mt-1">{report.totalCalls}</div>
            </div>
            <div className="bg-card rounded-xl shadow-sm border p-5">
              <div className="text-sm text-muted-foreground">Minutes Billed</div>
              <div className="text-2xl font-bold mt-1">{formatMinutes(report.totalMinutesBilled)}</div>
            </div>
            <div className="bg-card rounded-xl shadow-sm border p-5">
              <div className="text-sm text-muted-foreground">Revenue</div>
              <div className="text-2xl font-bold mt-1 text-success">{formatCurrency(report.totalRevenue)}</div>
            </div>
            <div className="bg-card rounded-xl shadow-sm border p-5">
              <div className="text-sm text-muted-foreground">Avg Duration</div>
              <div className="text-2xl font-bold mt-1">{formatDuration(Math.round(report.avgCallDuration))}</div>
            </div>
          </div>

          {/* Outcome + Flags */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-card rounded-xl shadow-sm border p-5 text-center">
              <div className="text-2xl font-bold text-success">{report.resolvedCalls}</div>
              <div className="text-sm text-muted-foreground">Resolved</div>
            </div>
            <div className="bg-card rounded-xl shadow-sm border p-5 text-center">
              <div className="text-2xl font-bold text-destructive">{report.unresolvedCalls}</div>
              <div className="text-sm text-muted-foreground">Unresolved</div>
            </div>
            <div className="bg-card rounded-xl shadow-sm border p-5 text-center">
              <div className="text-2xl font-bold text-warning">{report.flaggedCalls}</div>
              <div className="text-sm text-muted-foreground">Flagged</div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Category breakdown */}
            <div className="bg-card rounded-xl shadow-sm border p-6">
              <h3 className="font-semibold mb-4">Calls by Category</h3>
              <div className="space-y-3">
                {report.topCategories.map((cat) => (
                  <div key={cat.name} className="flex items-center justify-between">
                    <span className="text-sm">{cat.name}</span>
                    <div className="flex items-center gap-2">
                      <div className="w-32 h-2 bg-muted rounded-full">
                        <div
                          className="h-2 bg-accent rounded-full"
                          style={{ width: `${Math.min(100, (cat.count / report.totalCalls) * 100)}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium w-8 text-right">{cat.count}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Rep breakdown */}
            <div className="bg-card rounded-xl shadow-sm border p-6">
              <h3 className="font-semibold mb-4">Rep Performance</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground text-xs">
                    <th className="text-left py-2">Rep</th>
                    <th className="text-right py-2">Calls</th>
                    <th className="text-right py-2">Minutes</th>
                    <th className="text-right py-2">Avg Dur.</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.repStats.map((rep) => (
                    <tr key={rep.name}>
                      <td className="py-2 font-medium">{rep.name}</td>
                      <td className="py-2 text-right">{rep.calls}</td>
                      <td className="py-2 text-right">{Math.round(rep.minutes)}</td>
                      <td className="py-2 text-right font-mono">{formatDuration(Math.round(rep.avgDuration))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

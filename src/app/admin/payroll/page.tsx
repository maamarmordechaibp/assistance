'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { PageHeader } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { Wallet, Loader2, Download } from 'lucide-react';

type Row = {
  rep_id: string;
  full_name: string;
  email: string | null;
  active_seconds: number;
  call_seconds: number;
  call_count: number;
};

function fmtHMS(s: number): string {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function PayrollPage() {
  const today = useMemo(() => new Date(), []);
  const defaultStart = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - 13);
    return d;
  }, [today]);

  const [from, setFrom] = useState<string>(isoDay(defaultStart));
  const [to, setTo] = useState<string>(isoDay(today));
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const fromIso = new Date(`${from}T00:00:00.000Z`).toISOString();
    // make `to` inclusive of the end of that day
    const toIso = new Date(`${to}T23:59:59.999Z`).toISOString();

    // Reps for name lookup.
    const { data: reps } = await supabase.from('reps').select('id, full_name, email');
    const repMap = new Map((reps || []).map((r) => [r.id, r]));

    // Closed sessions in range — sum total_active_seconds and total_call_seconds.
    const { data: sessions } = await supabase
      .from('rep_sessions')
      .select('rep_id, started_at, ended_at, total_active_seconds, total_call_seconds')
      .gte('started_at', fromIso)
      .lte('started_at', toIso)
      .not('ended_at', 'is', null);

    const agg = new Map<string, { active: number; calls: number }>();
    for (const s of sessions || []) {
      const cur = agg.get(s.rep_id) || { active: 0, calls: 0 };
      cur.active += s.total_active_seconds || 0;
      cur.calls += s.total_call_seconds || 0;
      agg.set(s.rep_id, cur);
    }

    // Call counts in range.
    const { data: callRows } = await supabase
      .from('calls')
      .select('rep_id')
      .gte('ended_at', fromIso)
      .lte('ended_at', toIso)
      .not('rep_id', 'is', null);
    const counts = new Map<string, number>();
    for (const r of callRows || []) {
      const id = r.rep_id as string;
      counts.set(id, (counts.get(id) || 0) + 1);
    }

    const out: Row[] = [];
    for (const [rep_id, v] of agg) {
      const rep = repMap.get(rep_id);
      out.push({
        rep_id,
        full_name: rep?.full_name || '—',
        email: rep?.email || null,
        active_seconds: v.active,
        call_seconds: v.calls,
        call_count: counts.get(rep_id) || 0,
      });
    }
    out.sort((a, b) => b.active_seconds - a.active_seconds);
    setRows(out);
    setLoading(false);
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  const totals = useMemo(() => rows.reduce(
    (t, r) => ({ active: t.active + r.active_seconds, calls: t.calls + r.call_seconds, count: t.count + r.call_count }),
    { active: 0, calls: 0, count: 0 },
  ), [rows]);

  const downloadCsv = () => {
    const header = ['Rep', 'Email', 'Active hours', 'Active seconds', 'On-call seconds', 'Calls'];
    const lines = [header.join(',')];
    for (const r of rows) {
      const hours = (r.active_seconds / 3600).toFixed(2);
      lines.push([
        JSON.stringify(r.full_name),
        JSON.stringify(r.email || ''),
        hours,
        r.active_seconds,
        r.call_seconds,
        r.call_count,
      ].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payroll-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payroll"
        description="Total signed-in hours per rep over a date range"
        icon={<Wallet className="h-5 w-5" />}
      />
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-card p-3">
        <label className="flex flex-col text-sm">
          <span className="mb-1 text-xs uppercase text-muted-foreground">From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-md border border-border bg-background px-2 py-1" />
        </label>
        <label className="flex flex-col text-sm">
          <span className="mb-1 text-xs uppercase text-muted-foreground">To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-md border border-border bg-background px-2 py-1" />
        </label>
        <Button onClick={load} disabled={loading}>
          {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Refresh
        </Button>
        <Button variant="outline" onClick={downloadCsv} disabled={rows.length === 0}>
          <Download className="mr-2 h-4 w-4" /> Download CSV
        </Button>
      </div>

      <div className="overflow-hidden rounded-md border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Rep</th>
              <th className="px-3 py-2 font-medium text-right">Active time</th>
              <th className="px-3 py-2 font-medium text-right">On calls</th>
              <th className="px-3 py-2 font-medium text-right">Calls handled</th>
              <th className="px-3 py-2 font-medium text-right">Hours</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.rep_id} className="border-t border-border">
                <td className="px-3 py-2">
                  <div className="font-medium">{r.full_name}</div>
                  <div className="text-xs text-muted-foreground">{r.email}</div>
                </td>
                <td className="px-3 py-2 text-right font-mono">{fmtHMS(r.active_seconds)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmtHMS(r.call_seconds)}</td>
                <td className="px-3 py-2 text-right font-mono">{r.call_count}</td>
                <td className="px-3 py-2 text-right font-mono">{(r.active_seconds / 3600).toFixed(2)}</td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr><td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground">No closed sessions in this range.</td></tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot className="bg-muted/30 font-medium">
              <tr>
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right font-mono">{fmtHMS(totals.active)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmtHMS(totals.calls)}</td>
                <td className="px-3 py-2 text-right font-mono">{totals.count}</td>
                <td className="px-3 py-2 text-right font-mono">{(totals.active / 3600).toFixed(2)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

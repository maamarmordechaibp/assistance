'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { formatDuration, formatPhone, formatDateTime } from '@/lib/utils';
import { PageHeader } from '@/components/ui/page';
import { History, Search, ChevronLeft, ChevronRight, PhoneCall } from 'lucide-react';
import { edgeFn } from '@/lib/supabase/edge';

interface Call {
  id: string;
  started_at: string;
  ended_at: string | null;
  total_duration_seconds: number | null;
  minutes_deducted: number;
  rep_notes: string | null;
  outcome_status: string | null;
  flag_status: string;
  customer?: { id: string; full_name: string; primary_phone: string } | null;
  task_category?: { id: string; name: string } | null;
}

export default function RepHistory() {
  const router = useRouter();
  const [calls, setCalls] = useState<Call[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const limit = 20;

  const fetchCalls = async (p: number) => {
    setLoading(true);
    try {
      const res = await edgeFn('calls', { params: { page: p.toString(), limit: limit.toString() } });
      if (res.ok) {
        const data = await res.json();
        setCalls(data.calls || []);
        setTotal(data.total || 0);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCalls(page);
  }, [page]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<History />}
        title="Call History"
        description="Your recent inbound and outbound calls."
      />

      <div className="bg-card rounded-xl shadow-sm border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Date</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Customer</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Category</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Duration</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Minutes</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Outcome</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {calls.map((call) => (
              <tr key={call.id} className="hover:bg-muted/50 transition">
                <td className="px-4 py-3 text-foreground">
                  {formatDateTime(call.started_at)}
                </td>
                <td className="px-4 py-3">
                  {call.customer ? (
                    <div>
                      <div className="font-medium">{call.customer.full_name}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatPhone(call.customer.primary_phone)}
                      </div>
                    </div>
                  ) : (
                    <span className="text-muted-foreground/80">Unknown</span>
                  )}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {call.task_category?.name || '—'}
                </td>
                <td className="px-4 py-3 font-mono text-foreground">
                  {call.total_duration_seconds
                    ? formatDuration(call.total_duration_seconds)
                    : '—'}
                </td>
                <td className="px-4 py-3 text-foreground">
                  {call.minutes_deducted || 0} min
                </td>
                <td className="px-4 py-3">
                  {call.outcome_status ? (
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        call.outcome_status === 'resolved'
                          ? 'bg-success/15 text-success'
                          : call.outcome_status === 'partial'
                          ? 'bg-warning/15 text-warning'
                          : 'bg-destructive/15 text-destructive'
                      }`}
                    >
                      {call.outcome_status}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-4 py-3">
                  {call.flag_status === 'flagged' && (
                    <span className="px-2 py-0.5 rounded text-xs font-medium bg-destructive/15 text-destructive">
                      Flagged
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {call.customer?.primary_phone ? (
                    <button
                      onClick={() => router.push(`/rep?dial=${encodeURIComponent(call.customer!.primary_phone)}`)}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-success text-white text-xs font-medium hover:bg-success/90 transition"
                      title={`Call back ${formatPhone(call.customer.primary_phone)}`}
                    >
                      <PhoneCall className="w-3.5 h-3.5" />
                      Call Back
                    </button>
                  ) : (
                    <span className="text-muted-foreground/80 text-xs">—</span>
                  )}
                </td>
              </tr>
            ))}
            {calls.length === 0 && !loading && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                  No call history found.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t bg-muted/40">
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages} ({total} total)
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page === 1}
                className="p-2 rounded-lg border bg-card hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                disabled={page === totalPages}
                className="p-2 rounded-lg border bg-card hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

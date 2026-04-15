'use client';

import { useEffect, useState } from 'react';
import { formatPhone, formatDuration, formatDateTime } from '@/lib/utils';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  FileText,
  Search,
  AlertTriangle,
  CheckCircle,
  Eye,
  ChevronLeft,
  ChevronRight,
  Filter,
} from 'lucide-react';
import { edgeFn } from '@/lib/supabase/edge';

interface Call {
  id: string;
  started_at: string;
  total_duration_seconds: number | null;
  minutes_deducted: number;
  outcome_status: string | null;
  flag_status: string;
  flag_reason: string | null;
  extensions_used: number;
  customer?: { id: string; full_name: string } | null;
  rep?: { id: string; full_name: string } | null;
  task_category?: { name: string } | null;
  analysis?: Array<{
    ai_summary: string;
    ai_success_status: string;
    ai_wasted_time_flag: boolean;
  }> | null;
}

export default function AdminCalls() {
  const [calls, setCalls] = useState<Call[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const limit = 25;

  const fetchCalls = async (p: number, flagFilter: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: p.toString(), limit: limit.toString() });
      if (flagFilter) params.set('flagStatus', flagFilter);
      const res = await edgeFn('calls', { params: Object.fromEntries(params) });
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
    fetchCalls(page, filter);
  }, [page, filter]);

  const handleReview = async (callId: string, decision: 'reviewed' | 'dismissed') => {
    const res = await edgeFn('calls', {
      method: 'PATCH',
      body: JSON.stringify({ id: callId, flagStatus: decision }),
    });
    if (res.ok) {
      setCalls(
        calls.map((c) =>
          c.id === callId ? { ...c, flag_status: decision } : c
        )
      );
      toast.success(decision === 'reviewed' ? 'Call marked as reviewed' : 'Flag dismissed');
    } else {
      toast.error('Failed to update call flag');
    }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <FileText className="w-5 h-5" />
          Call Review
        </h2>
        <div className="flex gap-2">
          <button
            onClick={() => { setFilter(''); setPage(1); }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium ${!filter ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            All
          </button>
          <button
            onClick={() => { setFilter('flagged'); setPage(1); }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium flex items-center gap-1 ${filter === 'flagged' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            <AlertTriangle className="w-3 h-3" />
            Flagged
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Date</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Customer</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Rep</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Category</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Duration</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Ext.</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">AI</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Flag</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {calls.map((call) => {
              const analysis = call.analysis?.[0];
              return (
                <tr key={call.id} className="hover:bg-gray-50 transition">
                  <td className="px-4 py-3 text-xs text-gray-700">
                    {formatDateTime(call.started_at)}
                  </td>
                  <td className="px-4 py-3 font-medium">
                    {call.customer?.full_name || 'Unknown'}
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {call.rep?.full_name || '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {call.task_category?.name || '—'}
                  </td>
                  <td className="px-4 py-3 font-mono">
                    {call.total_duration_seconds ? formatDuration(call.total_duration_seconds) : '—'}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {call.extensions_used > 0 ? (
                      <span className="text-orange-600 font-medium">{call.extensions_used}</span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {analysis?.ai_wasted_time_flag && (
                      <span className="px-1.5 py-0.5 rounded text-xs bg-red-100 text-red-800">
                        Wasted
                      </span>
                    )}
                    {analysis && !analysis.ai_wasted_time_flag && (
                      <span className="px-1.5 py-0.5 rounded text-xs bg-green-100 text-green-800">
                        OK
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {call.flag_status === 'flagged' ? (
                      <div className="flex items-center gap-1">
                        <AlertTriangle className="w-4 h-4 text-red-500" />
                        <div className="flex gap-1">
                          <button
                            onClick={() => handleReview(call.id, 'reviewed')}
                            className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-800 hover:bg-green-200"
                            title="Mark as reviewed"
                          >
                            ✓
                          </button>
                          <button
                            onClick={() => handleReview(call.id, 'dismissed')}
                            className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 hover:bg-gray-200"
                            title="Dismiss flag"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ) : call.flag_status === 'reviewed' ? (
                      <CheckCircle className="w-4 h-4 text-green-500" />
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/calls/${call.id}`}
                      className="p-1.5 rounded hover:bg-gray-100 inline-flex"
                    >
                      <Eye className="w-4 h-4 text-gray-500" />
                    </Link>
                  </td>
                </tr>
              );
            })}
            {calls.length === 0 && !loading && (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-gray-500">
                  No calls found.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50">
            <span className="text-sm text-gray-600">
              Page {page} of {totalPages} ({total} total)
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page === 1}
                className="p-2 rounded-lg border bg-white hover:bg-gray-50 disabled:opacity-50"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                disabled={page === totalPages}
                className="p-2 rounded-lg border bg-white hover:bg-gray-50 disabled:opacity-50"
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

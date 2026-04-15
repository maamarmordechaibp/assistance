'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Star, Trash2, Loader2, BarChart3 } from 'lucide-react';
import { edgeFn } from '@/lib/supabase/edge';

interface Feedback {
  id: string;
  customer_id: string;
  rep_id: string;
  call_id: string | null;
  rating: number;
  comment: string | null;
  created_at: string;
  customers: { full_name: string } | null;
  reps: { full_name: string } | null;
  calls: { started_at: string } | null;
}

interface RepSummary {
  repId: string;
  repName: string;
  avgRating: number;
  totalReviews: number;
}

export default function FeedbackPage() {
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [summary, setSummary] = useState<RepSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchFeedback();
  }, []);

  async function fetchFeedback() {
    setLoading(true);
    const res = await edgeFn('feedback');
    if (res.ok) {
      const data = await res.json();
      setFeedback(data.feedback || []);
      setSummary(data.summary || []);
    } else {
      toast.error('Failed to load feedback');
    }
    setLoading(false);
  }

  async function deleteFeedback(id: string) {
    const res = await edgeFn('feedback', { method: 'DELETE', params: { id } });
    if (res.ok) {
      setFeedback((prev) => prev.filter((f) => f.id !== id));
      toast.success('Feedback deleted');
    } else {
      toast.error('Failed to delete');
    }
  }

  function renderStars(rating: number) {
    return (
      <div className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map((i) => (
          <Star
            key={i}
            className={`w-4 h-4 ${i <= rating ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300'}`}
          />
        ))}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Customer Feedback</h1>

      {/* Rep Summary Cards */}
      {summary.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {summary.map((s) => (
            <div key={s.repId} className="bg-white rounded-xl shadow-sm border p-4">
              <div className="flex items-center gap-2 mb-2">
                <BarChart3 className="w-5 h-5 text-blue-600" />
                <span className="font-semibold text-sm">{s.repName}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-2xl font-bold">{s.avgRating}</span>
                {renderStars(Math.round(s.avgRating))}
              </div>
              <p className="text-xs text-gray-500 mt-1">{s.totalReviews} review{s.totalReviews !== 1 ? 's' : ''}</p>
            </div>
          ))}
        </div>
      )}

      {/* Feedback Table */}
      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Date</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Customer</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Representative</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Rating</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Comment</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {feedback.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-12 text-gray-500">
                  No feedback yet. Ratings will appear here as customers provide them via the phone system or manual entry.
                </td>
              </tr>
            ) : (
              feedback.map((fb) => (
                <tr key={fb.id} className="border-b last:border-b-0 hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-500">
                    {new Date(fb.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 font-medium">
                    {fb.customers?.full_name || 'Unknown'}
                  </td>
                  <td className="px-4 py-3">{fb.reps?.full_name || 'Unknown'}</td>
                  <td className="px-4 py-3">{renderStars(fb.rating)}</td>
                  <td className="px-4 py-3 text-gray-600 max-w-xs truncate">
                    {fb.comment || '—'}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => deleteFeedback(fb.id)}
                      className="text-gray-400 hover:text-red-600 transition"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

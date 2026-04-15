'use client';

import { useEffect, useState } from 'react';
import { formatPhone, formatDateTime } from '@/lib/utils';
import { toast } from 'sonner';
import { PhoneCall, Check, Clock, Loader2 } from 'lucide-react';
import { edgeFn } from '@/lib/supabase/edge';

interface Callback {
  id: string;
  phone_number: string;
  requested_at: string;
  status: string;
  notes: string | null;
  customer?: { id: string; full_name: string; primary_phone: string } | null;
}

export default function RepCallbacks() {
  const [callbacks, setCallbacks] = useState<Callback[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchCallbacks = async () => {
    setLoading(true);
    try {
      const res = await edgeFn('callbacks', { params: { status: 'pending' } });
      if (res.ok) {
        const data = await res.json();
        setCallbacks(data || []);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCallbacks();
  }, []);

  const markComplete = async (id: string) => {
    const res = await edgeFn('callbacks', {
      method: 'PATCH',
      body: JSON.stringify({ id, status: 'called_back' }),
    });
    if (res.ok) {
      setCallbacks(callbacks.filter((c) => c.id !== id));
      toast.success('Callback marked complete');
    } else {
      toast.error('Failed to update callback');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <PhoneCall className="w-5 h-5" />
          Pending Callbacks
        </h2>
        <button
          onClick={fetchCallbacks}
          className="px-4 py-2 bg-gray-100 rounded-lg text-sm font-medium hover:bg-gray-200 transition"
        >
          Refresh
        </button>
      </div>

      {callbacks.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border p-12 text-center text-gray-500">
          <PhoneCall className="w-12 h-12 mx-auto mb-3 text-gray-300" />
          <p className="text-lg font-medium">No pending callbacks</p>
          <p className="text-sm">All callback requests have been handled.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {callbacks.map((cb) => (
            <div
              key={cb.id}
              className="bg-white rounded-xl shadow-sm border p-4 flex items-center justify-between"
            >
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center">
                  <PhoneCall className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <div className="font-medium">
                    {cb.customer?.full_name || 'Unknown Caller'}
                  </div>
                  <div className="text-sm text-gray-500">
                    {formatPhone(cb.phone_number)}
                  </div>
                </div>
                <div className="flex items-center gap-1 text-sm text-gray-500">
                  <Clock className="w-4 h-4" />
                  Requested {formatDateTime(cb.requested_at)}
                </div>
              </div>
              <button
                onClick={() => markComplete(cb.id)}
                className="flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 transition"
              >
                <Check className="w-4 h-4" />
                Mark Complete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

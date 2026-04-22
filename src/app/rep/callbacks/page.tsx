'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatPhone, formatDateTime } from '@/lib/utils';
import { toast } from 'sonner';
import { PhoneCall, PhoneOutgoing, Check, Clock, Loader2, RefreshCw } from 'lucide-react';
import { edgeFn } from '@/lib/supabase/edge';

interface Callback {
  id: string;
  phone_number: string;
  caller_name: string | null;
  requested_at: string;
  status: string;
  notes: string | null;
  rep_id: string | null;
  is_general: boolean;
  customer?: { id: string; full_name: string; primary_phone: string } | null;
}

export default function RepCallbacks() {
  const [callbacks, setCallbacks] = useState<Callback[]>([]);
  const [loading, setLoading] = useState(true);
  const [callingId, setCallingId] = useState<string | null>(null);
  // makeCall is set by the parent portal page via the softphone onReady callback
  const makeCallRef = useRef<((to: string) => Promise<void>) | null>(null);

  const fetchCallbacks = useCallback(async (retryCount = 0) => {
    setLoading(true);
    try {
      const res = await edgeFn('callbacks', { params: { status: 'pending' } });
      if (res.ok) {
        const data = await res.json();
        setCallbacks(data || []);
      } else if (res.status === 401 && retryCount === 0) {
        // Auth session may not be ready yet — retry once after a short delay
        setTimeout(() => fetchCallbacks(1), 1200);
      } else {
        toast.error(`Failed to load callbacks (${res.status})`);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCallbacks();
    // Expose makeCallRef setter so the parent softphone can wire it in
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__repCallbacksMakeCallRef = makeCallRef;
  }, [fetchCallbacks]);

  const markComplete = async (id: string) => {
    const res = await edgeFn('callbacks', {
      method: 'PATCH',
      body: JSON.stringify({ id, status: 'called_back' }),
    });
    if (res.ok) {
      setCallbacks(prev => prev.filter((c) => c.id !== id));
      toast.success('Callback marked complete');
    } else {
      toast.error('Failed to update callback');
    }
  };

  const initiateCallback = async (cb: Callback) => {
    setCallingId(cb.id);
    try {
      // If the softphone is connected, use it directly for a browser-to-PSTN call
      if (makeCallRef.current) {
        await makeCallRef.current(cb.phone_number);
        // Optimistically mark as calling
        setCallbacks(prev => prev.map(c => c.id === cb.id ? { ...c, status: 'calling' } : c));
        toast.success(`Calling ${formatPhone(cb.phone_number)}...`);
      } else {
        // Fallback: trigger outbound call via REST API (SignalWire calls the customer)
        const res = await edgeFn('callbacks', {
          method: 'POST',
          body: JSON.stringify({ id: cb.id }),
        });
        if (res.ok) {
          setCallbacks(prev => prev.map(c => c.id === cb.id ? { ...c, status: 'calling' } : c));
          toast.success(`Calling ${formatPhone(cb.phone_number)} — answer your phone or browser to connect.`);
        } else {
          const err = await res.json();
          toast.error('Failed to initiate call: ' + (err.error || 'Unknown error'));
        }
      }
    } catch (err) {
      toast.error('Failed to call: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setCallingId(null);
    }
  };

  const pendingCallbacks = callbacks.filter(c => c.status === 'pending');
  const myCallbacks = pendingCallbacks.filter(c => c.rep_id !== null && !c.is_general);
  const generalCallbacks = pendingCallbacks.filter(c => c.rep_id === null || c.is_general);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const CallbackCard = ({ cb }: { cb: Callback }) => (
    <div className="bg-white rounded-xl shadow-sm border p-4 flex items-center justify-between gap-4">
      <div className="flex items-center gap-4 min-w-0">
        <div className="w-10 h-10 bg-blue-100 rounded-full flex-shrink-0 flex items-center justify-center">
          <PhoneCall className="w-5 h-5 text-blue-600" />
        </div>
        <div className="min-w-0">
          <div className="font-medium truncate">
            {cb.customer?.full_name || cb.caller_name || 'Unknown Caller'}
          </div>
          <div className="text-sm text-gray-500">{formatPhone(cb.phone_number)}</div>
          <div className="flex items-center gap-1 text-xs text-gray-400 mt-0.5">
            <Clock className="w-3 h-3" />
            {formatDateTime(cb.requested_at)}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={() => initiateCallback(cb)}
          disabled={callingId === cb.id || cb.status === 'calling'}
          className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition"
        >
          {callingId === cb.id ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <PhoneOutgoing className="w-4 h-4" />
          )}
          {cb.status === 'calling' ? 'Calling...' : 'Call Back'}
        </button>
        <button
          onClick={() => markComplete(cb.id)}
          className="flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 transition"
          title="Mark as handled (no call needed)"
        >
          <Check className="w-4 h-4" />
          Done
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <PhoneCall className="w-5 h-5" />
          Pending Callbacks
          {pendingCallbacks.length > 0 && (
            <span className="ml-1 bg-red-100 text-red-700 text-xs font-bold px-2 py-0.5 rounded-full">
              {pendingCallbacks.length}
            </span>
          )}
        </h2>
        <button
          onClick={() => fetchCallbacks()}
          className="flex items-center gap-1 px-4 py-2 bg-gray-100 rounded-lg text-sm font-medium hover:bg-gray-200 transition"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {pendingCallbacks.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border p-12 text-center text-gray-500">
          <PhoneCall className="w-12 h-12 mx-auto mb-3 text-gray-300" />
          <p className="text-lg font-medium">No pending callbacks</p>
          <p className="text-sm">All callback requests have been handled.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {myCallbacks.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                Requested for You ({myCallbacks.length})
              </h3>
              <div className="space-y-3">
                {myCallbacks.map(cb => <CallbackCard key={cb.id} cb={cb} />)}
              </div>
            </div>
          )}
          {generalCallbacks.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
                General Queue ({generalCallbacks.length})
              </h3>
              <div className="space-y-3">
                {generalCallbacks.map(cb => <CallbackCard key={cb.id} cb={cb} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

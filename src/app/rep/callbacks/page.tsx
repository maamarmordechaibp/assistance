'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatPhone, formatDateTime } from '@/lib/utils';
import { toast } from 'sonner';
import { PageHeader } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PhoneCall, PhoneOutgoing, X, Clock, Loader2, RefreshCw } from 'lucide-react';
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
  const router = useRouter();
  const [callbacks, setCallbacks] = useState<Callback[]>([]);
  const [loading, setLoading] = useState(true);
  const [callingId, setCallingId] = useState<string | null>(null);

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
  }, [fetchCallbacks]);

  const dismissCallback = async (id: string) => {
    // Require explicit confirmation — dismissing a callback means the
    // customer will NOT be called, so the rep should never hit this by
    // accident.
    if (!window.confirm('Dismiss this callback without calling the customer? This cannot be undone.')) {
      return;
    }
    const res = await edgeFn('callbacks', {
      method: 'PATCH',
      body: JSON.stringify({ id, status: 'called_back', notes: 'Dismissed by rep without callback' }),
    });
    if (res.ok) {
      setCallbacks(prev => prev.filter((c) => c.id !== id));
      toast.success('Callback dismissed');
    } else {
      toast.error('Failed to update callback');
    }
  };

  const initiateCallback = async (cb: Callback) => {
    setCallingId(cb.id);
    try {
      // Mark the callback as 'called_back' immediately — the rep is
      // taking ownership; if the call doesn't connect, they can manually
      // re-create the request from history. This also drops it from the
      // list so it isn't double-clicked.
      try {
        await edgeFn('callbacks', {
          method: 'PATCH',
          body: JSON.stringify({ id: cb.id, status: 'called_back' }),
        });
      } catch { /* non-fatal */ }

      // Navigate to the main rep dashboard with `dial` (auto-dials via
      // softphone) and `customerId` (auto-loads the customer profile so
      // the rep sees full context the moment the call connects).
      const params = new URLSearchParams({ dial: cb.phone_number });
      if (cb.customer?.id) params.set('customerId', cb.customer.id);
      params.set('callbackId', cb.id);
      toast.success(`Calling ${formatPhone(cb.phone_number)}…`);
      router.push(`/rep?${params.toString()}`);
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
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
      </div>
    );
  }

  const CallbackCard = ({ cb }: { cb: Callback }) => (
    <div className="bg-card rounded-xl shadow-sm border p-4 flex items-center justify-between gap-4">
      <div className="flex items-center gap-4 min-w-0">
        <div className="w-10 h-10 bg-accent/15 rounded-full flex-shrink-0 flex items-center justify-center">
          <PhoneCall className="w-5 h-5 text-accent" />
        </div>
        <div className="min-w-0">
          <div className="font-medium truncate">
            {cb.customer?.full_name || cb.caller_name || 'Unknown Caller'}
          </div>
          <div className="text-sm text-muted-foreground">{formatPhone(cb.phone_number)}</div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground/80 mt-0.5">
            <Clock className="w-3 h-3" />
            {formatDateTime(cb.requested_at)}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={() => initiateCallback(cb)}
          disabled={callingId === cb.id || cb.status === 'calling'}
          className="flex items-center gap-2 bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-50 transition"
        >
          {callingId === cb.id ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <PhoneOutgoing className="w-4 h-4" />
          )}
          {cb.status === 'calling' ? 'Calling...' : 'Call Back'}
        </button>
        <button
          onClick={() => dismissCallback(cb.id)}
          className="p-2 text-muted-foreground/80 hover:text-destructive hover:bg-destructive/10 rounded-lg transition"
          title="Dismiss without calling (requires confirmation)"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<PhoneCall />}
        title={
          <span className="flex items-center gap-2">
            Pending Callbacks
            {pendingCallbacks.length > 0 && (
              <Badge variant="destructive">{pendingCallbacks.length}</Badge>
            )}
          </span>
        }
        description="Customers waiting for a return call."
        actions={
          <Button variant="outline" size="sm" onClick={() => fetchCallbacks()}>
            <RefreshCw /> Refresh
          </Button>
        }
      />

      {pendingCallbacks.length === 0 ? (
        <div className="bg-card rounded-xl shadow-sm border p-12 text-center text-muted-foreground">
          <PhoneCall className="w-12 h-12 mx-auto mb-3 text-muted-foreground/60" />
          <p className="text-lg font-medium">No pending callbacks</p>
          <p className="text-sm">All callback requests have been handled.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {myCallbacks.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Requested for You ({myCallbacks.length})
              </h3>
              <div className="space-y-3">
                {myCallbacks.map(cb => <CallbackCard key={cb.id} cb={cb} />)}
              </div>
            </div>
          )}
          {generalCallbacks.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
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

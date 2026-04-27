'use client';

import { useCallback, useEffect, useState } from 'react';
import { Lock, Unlock, Loader2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { edgeFn } from '@/lib/supabase/edge';

interface LockState {
  customer_id: string;
  holder_rep_id: string | null;
  holder_pc_hostname: string | null;
  acquired_at: string | null;
  expires_at: string | null;
  last_heartbeat_at: string | null;
  holder?: { id: string; full_name: string } | null;
}

interface BlobState {
  last_uploaded_at: string | null;
  size_bytes: number | null;
  chrome_version: string | null;
}

export default function BrowserLockBadge({
  customerId,
  isAdmin = false,
  pollMs = 8000,
}: {
  customerId: string;
  isAdmin?: boolean;
  pollMs?: number;
}) {
  const [lock, setLock] = useState<LockState | null>(null);
  const [blob, setBlob] = useState<BlobState | null>(null);
  const [loading, setLoading] = useState(true);
  const [unlocking, setUnlocking] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await edgeFn('customer-browser-profile', { params: { customerId } });
      if (res.ok) {
        const data = await res.json();
        setLock(data.lock || null);
        setBlob(data.blob || null);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [customerId]);

  useEffect(() => {
    void load();
    const iv = setInterval(() => { void load(); }, pollMs);
    return () => clearInterval(iv);
  }, [load, pollMs]);

  const forceUnlock = async () => {
    if (!confirm('Force-unlock this customer’s browser profile? Any rep currently using it will lose unsaved changes on close.')) return;
    setUnlocking(true);
    try {
      const res = await edgeFn('customer-browser-profile', {
        method: 'POST',
        body: JSON.stringify({ action: 'force-unlock', customerId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      toast.success('Lock released');
      void load();
    } catch (e) {
      toast.error('Force-unlock failed: ' + (e as Error).message);
    } finally {
      setUnlocking(false);
    }
  };

  if (loading) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/80">
        <Loader2 className="w-3 h-3 animate-spin" /> sync status…
      </span>
    );
  }

  const now = Date.now();
  const expiresAt = lock?.expires_at ? new Date(lock.expires_at).getTime() : 0;
  const isLocked = !!lock && expiresAt > now;
  const holderName = lock?.holder?.full_name || null;

  return (
    <div className="inline-flex items-center gap-2 flex-wrap">
      {isLocked ? (
        <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-warning/15 text-warning font-medium">
          <Lock className="w-3 h-3" />
          In use
          {holderName ? ` by ${holderName}` : lock?.holder_rep_id ? ' by rep' : ''}
          {lock?.holder_pc_hostname ? ` (${lock.holder_pc_hostname})` : ''}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-success/10 text-success">
          <Unlock className="w-3 h-3" />
          Available
        </span>
      )}
      {blob?.last_uploaded_at && (
        <span className="text-[11px] text-muted-foreground/80">
          last sync {new Date(blob.last_uploaded_at).toLocaleString()}
        </span>
      )}
      {isAdmin && isLocked && (
        <button
          onClick={() => void forceUnlock()}
          disabled={unlocking}
          className="text-[10px] px-1.5 py-0.5 rounded border border-destructive/40 text-destructive hover:bg-destructive/10 inline-flex items-center gap-1 disabled:opacity-50"
          title="Force the lock open"
        >
          {unlocking ? <Loader2 className="w-3 h-3 animate-spin" /> : <AlertCircle className="w-3 h-3" />}
          Force unlock
        </button>
      )}
    </div>
  );
}

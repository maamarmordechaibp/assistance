'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw } from 'lucide-react';
import EmailInbox from '@/components/rep/email-inbox';
import { Button } from '@/components/ui/button';
import { edgeFn } from '@/lib/supabase/edge';

export default function AdminEmailsPage() {
  const [resyncing, setResyncing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const resync = async () => {
    setResyncing(true);
    try {
      const res = await edgeFn('email-resync', {
        method: 'POST',
        body: JSON.stringify({ limit: 200 }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || `Resync failed (${res.status})`, {
          description: json?.hint,
          duration: 12000,
        });
        return;
      }
      const skippedNote = json.skipped
        ? ` (${json.skipped} skipped${json.errors?.[0] ? `: ${json.errors[0]}` : ''})`
        : '';
      toast.success(
        `Pulled ${json.fetched} from Resend — ${json.inserted} new, ${json.updated} updated${skippedNote}`,
        { duration: 10000 },
      );
      if (json.skipped && !json.inserted && !json.updated) {
        // eslint-disable-next-line no-console
        console.log('[email-resync] response', json);
      }
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Resync failed');
    } finally {
      setResyncing(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={resync} loading={resyncing}>
          <RefreshCw /> Resync from Resend
        </Button>
      </div>
      <EmailInbox
        key={refreshKey}
        title="Email activity"
        description="All inbound and outbound customer-mailbox messages across the platform."
        isAdmin
      />
    </div>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Truck,
  RefreshCw,
  Package,
  CheckCircle2,
  Clock,
  AlertTriangle,
  ExternalLink,
  Search,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { edgeFn } from '@/lib/supabase/edge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { PageHeader, EmptyState } from '@/components/ui/page';
import { formatDateTime } from '@/lib/utils';

interface OrderRow {
  id: string;
  customer_id: string;
  merchant_name: string;
  merchant_order_id: string | null;
  item_summary: string;
  status: string;
  ordered_at: string;
  customer: {
    id: string;
    full_name: string | null;
    primary_phone: string | null;
  } | null;
  shipments: Array<{
    id: string;
    carrier: string | null;
    tracking_number: string | null;
    tracking_url: string | null;
    status: string;
    last_status_message: string | null;
    estimated_delivery_date: string | null;
  }> | null;
}

const STATUS_BADGES: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  placed:    { label: 'Placed',    variant: 'secondary' },
  paid:      { label: 'Paid',      variant: 'secondary' },
  shipped:   { label: 'Shipped',   variant: 'default' },
  delivered: { label: 'Delivered', variant: 'default' },
  cancelled: { label: 'Cancelled', variant: 'destructive' },
  refunded:  { label: 'Refunded',  variant: 'outline' },
};

const SHIP_STATUS_BADGES: Record<string, { label: string; tone: 'muted' | 'info' | 'success' | 'warn' }> = {
  pending:          { label: 'Awaiting tracking', tone: 'muted' },
  label_created:    { label: 'Label created',     tone: 'info'  },
  in_transit:       { label: 'In transit',         tone: 'info'  },
  out_for_delivery: { label: 'Out for delivery',   tone: 'info'  },
  delivered:        { label: 'Delivered',          tone: 'success' },
  exception:        { label: 'Exception',          tone: 'warn'  },
  returned:         { label: 'Returned',           tone: 'warn'  },
};

function shipTone(tone: 'muted' | 'info' | 'success' | 'warn'): string {
  switch (tone) {
    case 'success': return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
    case 'info':    return 'bg-blue-500/15 text-blue-700 dark:text-blue-300';
    case 'warn':    return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
    default:        return 'bg-muted text-muted-foreground';
  }
}

export default function AdminOrdersPage() {
  const supabase = useMemo(() => createClient(), []);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'open' | 'shipped' | 'delivered'>('all');
  const [backfilling, setBackfilling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('orders')
      .select(
        'id, customer_id, merchant_name, merchant_order_id, item_summary, status, ordered_at, ' +
          'customer:customers ( id, full_name, primary_phone ), ' +
          'shipments:order_shipments ( id, carrier, tracking_number, tracking_url, status, last_status_message, estimated_delivery_date )',
      )
      .order('ordered_at', { ascending: false })
      .limit(200);
    if (error) {
      toast.error('Failed to load orders: ' + error.message);
    } else {
      setOrders((data as unknown as OrderRow[]) || []);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  const backfill = async () => {
    setBackfilling(true);
    try {
      const res = await edgeFn('email-classify-backfill', {
        method: 'POST',
        body: JSON.stringify({ limit: 200, runCarrierRefresh: true }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || `Backfill failed (${res.status})`);
        return;
      }
      toast.success(
        `Scanned ${json.scanned} emails — matched ${json.matched}, ` +
          `created ${json.ordersCreated} orders, ${json.shipmentsCreated} shipments`,
        { duration: 10000 },
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Backfill failed');
    } finally {
      setBackfilling(false);
    }
  };

  const filtered = useMemo(() => {
    let list = orders;
    if (filter === 'open') {
      list = list.filter((o) => o.status === 'placed' || o.status === 'paid' || o.status === 'shipped');
    } else if (filter === 'shipped') {
      list = list.filter((o) => o.status === 'shipped');
    } else if (filter === 'delivered') {
      list = list.filter((o) => o.status === 'delivered');
    }
    const term = search.trim().toLowerCase();
    if (term) {
      list = list.filter((o) => {
        return (
          o.merchant_name.toLowerCase().includes(term) ||
          (o.merchant_order_id || '').toLowerCase().includes(term) ||
          o.item_summary.toLowerCase().includes(term) ||
          (o.customer?.full_name || '').toLowerCase().includes(term) ||
          (o.customer?.primary_phone || '').includes(term) ||
          (o.shipments || []).some((s) => (s.tracking_number || '').toLowerCase().includes(term))
        );
      });
    }
    return list;
  }, [orders, filter, search]);

  return (
    <div className="space-y-4">
      <PageHeader
        icon={<Truck className="size-5" />}
        title="Orders"
        description="Auto-derived from inbound merchant and carrier emails. Each order rolls up its shipments and live tracking status."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={loading ? 'animate-spin' : ''} /> Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={backfill} loading={backfilling}>
              <Package /> Re-scan emails
            </Button>
          </div>
        }
      />

      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search merchant, customer, tracking #…"
              className="pl-9"
            />
          </div>
          <div className="flex items-center gap-1">
            {(['all', 'open', 'shipped', 'delivered'] as const).map((f) => (
              <Button
                key={f}
                size="sm"
                variant={filter === f ? 'default' : 'outline'}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? 'All' : f === 'open' ? 'Open' : f === 'shipped' ? 'Shipped' : 'Delivered'}
              </Button>
            ))}
          </div>
        </div>
      </Card>

      {loading && filtered.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">Loading orders…</Card>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Package className="size-8" />}
          title="No orders yet"
          description={
            orders.length === 0
              ? 'Once merchant or carrier emails arrive at customer mailboxes, orders and tracking will appear here automatically. You can also click "Re-scan emails" to process historical messages.'
              : 'Nothing matches the current filter.'
          }
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((o) => {
            const sb = STATUS_BADGES[o.status] || STATUS_BADGES.placed;
            const ship = (o.shipments || [])[0];
            const shipBadge = ship ? SHIP_STATUS_BADGES[ship.status] : null;
            return (
              <Card key={o.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold capitalize">{o.merchant_name}</span>
                      <Badge variant={sb.variant}>{sb.label}</Badge>
                      {o.merchant_order_id && (
                        <code className="text-[11px] text-muted-foreground">#{o.merchant_order_id}</code>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-foreground line-clamp-2">{o.item_summary}</p>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="size-3" />
                        {formatDateTime(o.ordered_at)}
                      </span>
                      {o.customer && (
                        <span className="inline-flex items-center gap-1">
                          <span className="font-medium">{o.customer.full_name || 'Unknown'}</span>
                          {o.customer.primary_phone && (
                            <span className="text-muted-foreground/70">· {o.customer.primary_phone}</span>
                          )}
                        </span>
                      )}
                    </div>
                  </div>

                  {ship && (
                    <div className="text-right">
                      {shipBadge && (
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${shipTone(shipBadge.tone)}`}>
                          {shipBadge.tone === 'success' && <CheckCircle2 className="size-3" />}
                          {shipBadge.tone === 'warn' && <AlertTriangle className="size-3" />}
                          {shipBadge.label}
                        </span>
                      )}
                      {ship.tracking_number && (
                        <div className="mt-1 flex items-center justify-end gap-1 font-mono text-xs">
                          {ship.carrier && <span className="uppercase text-muted-foreground">{ship.carrier}</span>}
                          {ship.tracking_url ? (
                            <a
                              href={ship.tracking_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400"
                            >
                              {ship.tracking_number}
                              <ExternalLink className="size-3" />
                            </a>
                          ) : (
                            <span>{ship.tracking_number}</span>
                          )}
                        </div>
                      )}
                      {ship.last_status_message && (
                        <p className="mt-1 max-w-xs truncate text-xs text-muted-foreground">
                          {ship.last_status_message}
                        </p>
                      )}
                      {ship.estimated_delivery_date && (
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          ETA {ship.estimated_delivery_date}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

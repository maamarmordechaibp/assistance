'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Package,
  Plus,
  RefreshCw,
  Truck,
  Loader2,
  X,
  ExternalLink,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { edgeFn } from '@/lib/supabase/edge';
import { formatDateTime } from '@/lib/utils';

interface OrderRow {
  id: string;
  customer_id: string;
  rep_id: string | null;
  call_id: string | null;
  merchant_name: string | null;
  merchant_url: string | null;
  merchant_order_id: string | null;
  item_summary: string | null;
  item_count: number | null;
  total_amount: number | null;
  currency: string | null;
  status: string;
  ordered_at: string | null;
  internal_notes: string | null;
  shipment_id: string | null;
  carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipment_status: string | null;
  estimated_delivery_date: string | null;
  actual_delivery_date: string | null;
  last_status_message: string | null;
  last_status_check_at: string | null;
}

interface TrackingEvent {
  id: string;
  occurred_at: string;
  location: string | null;
  description: string | null;
  status_code: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  placed: 'bg-blue-100 text-blue-800',
  paid: 'bg-indigo-100 text-indigo-800',
  shipped: 'bg-purple-100 text-purple-800',
  delivered: 'bg-green-100 text-green-800',
  cancelled: 'bg-gray-200 text-gray-700',
  refunded: 'bg-yellow-100 text-yellow-800',
};

const SHIP_COLORS: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-700',
  label_created: 'bg-blue-100 text-blue-800',
  in_transit: 'bg-indigo-100 text-indigo-800',
  out_for_delivery: 'bg-purple-100 text-purple-800',
  delivered: 'bg-green-100 text-green-800',
  exception: 'bg-red-100 text-red-800',
  returned: 'bg-yellow-100 text-yellow-800',
};

export default function OrdersPanel({
  customerId,
  callId,
  compact = false,
}: {
  customerId: string;
  callId?: string | null;
  compact?: boolean;
}) {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [eventsByShipment, setEventsByShipment] = useState<Record<string, TrackingEvent[]>>({});
  const [draft, setDraft] = useState({
    merchantName: '',
    merchantOrderId: '',
    itemSummary: '',
    totalAmount: '',
    trackingNumber: '',
    carrier: '',
  });
  const [trackingInput, setTrackingInput] = useState<Record<string, { carrier: string; number: string }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await edgeFn('orders', { params: { customerId } });
      if (res.ok) {
        const data = await res.json();
        setOrders(data.orders || []);
      }
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => { void load(); }, [load]);

  const loadEvents = async (shipmentId: string) => {
    if (eventsByShipment[shipmentId]) return;
    try {
      const res = await edgeFn('orders', { params: { shipmentId, includeEvents: '1' } });
      if (res.ok) {
        const data = await res.json();
        setEventsByShipment(prev => ({ ...prev, [shipmentId]: data.events || [] }));
      }
    } catch { /* ignore */ }
  };

  const createOrder = async () => {
    if (!draft.merchantName.trim()) {
      toast.error('Merchant name is required');
      return;
    }
    setCreating(true);
    try {
      const res = await edgeFn('orders', {
        method: 'POST',
        body: JSON.stringify({
          customerId,
          callId: callId || undefined,
          merchantName: draft.merchantName.trim(),
          merchantOrderId: draft.merchantOrderId.trim() || undefined,
          itemSummary: draft.itemSummary.trim() || undefined,
          totalAmount: draft.totalAmount ? Number(draft.totalAmount) : undefined,
          trackingNumber: draft.trackingNumber.trim() || undefined,
          carrier: draft.carrier.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      toast.success('Order saved');
      setShowCreate(false);
      setDraft({ merchantName: '', merchantOrderId: '', itemSummary: '', totalAmount: '', trackingNumber: '', carrier: '' });
      await load();
    } catch (e) {
      toast.error('Failed to save order: ' + (e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const attachTracking = async (orderId: string) => {
    const t = trackingInput[orderId];
    if (!t?.number?.trim()) {
      toast.error('Tracking number required');
      return;
    }
    try {
      const res = await edgeFn('orders', {
        method: 'POST',
        body: JSON.stringify({
          action: 'attach-tracking',
          orderId,
          trackingNumber: t.number.trim(),
          carrier: t.carrier.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success('Tracking attached');
      setTrackingInput(prev => ({ ...prev, [orderId]: { carrier: '', number: '' } }));
      await load();
    } catch (e) {
      toast.error('Failed: ' + (e as Error).message);
    }
  };

  const refreshShipment = async (shipmentId: string) => {
    try {
      const res = await edgeFn('orders', {
        method: 'POST',
        body: JSON.stringify({ action: 'refresh-shipment', shipmentId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success('Refreshed from carrier');
      setEventsByShipment(prev => { const n = { ...prev }; delete n[shipmentId]; return n; });
      await load();
    } catch (e) {
      toast.error('Refresh failed: ' + (e as Error).message);
    }
  };

  const toggleExpand = (order: OrderRow) => {
    if (expanded === order.id) {
      setExpanded(null);
    } else {
      setExpanded(order.id);
      if (order.shipment_id) void loadEvents(order.shipment_id);
    }
  };

  return (
    <div className={`bg-white rounded-xl shadow-sm border ${compact ? 'p-3' : 'p-4'}`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-600 uppercase tracking-wide flex items-center gap-2">
          <Package className="w-4 h-4" />
          Orders &amp; Tracking
        </h3>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => void load()}
            disabled={loading}
            className="text-xs px-2 py-1 rounded border hover:bg-gray-50 flex items-center gap-1"
            title="Reload"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => setShowCreate(v => !v)}
            className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> New order
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="mb-3 p-3 border rounded-lg bg-gray-50 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-700">Log a new order</span>
            <button onClick={() => setShowCreate(false)}><X className="w-4 h-4 text-gray-500" /></button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              placeholder="Merchant (Amazon, Walmart…) *"
              value={draft.merchantName}
              onChange={e => setDraft({ ...draft, merchantName: e.target.value })}
              className="text-xs border rounded px-2 py-1.5"
            />
            <input
              placeholder="Merchant order # (optional)"
              value={draft.merchantOrderId}
              onChange={e => setDraft({ ...draft, merchantOrderId: e.target.value })}
              className="text-xs border rounded px-2 py-1.5"
            />
            <input
              placeholder="What was ordered"
              value={draft.itemSummary}
              onChange={e => setDraft({ ...draft, itemSummary: e.target.value })}
              className="text-xs border rounded px-2 py-1.5 col-span-2"
            />
            <input
              placeholder="Total amount (USD)"
              type="number"
              step="0.01"
              value={draft.totalAmount}
              onChange={e => setDraft({ ...draft, totalAmount: e.target.value })}
              className="text-xs border rounded px-2 py-1.5"
            />
            <select
              value={draft.carrier}
              onChange={e => setDraft({ ...draft, carrier: e.target.value })}
              className="text-xs border rounded px-2 py-1.5"
            >
              <option value="">Carrier (auto-detect)</option>
              <option value="ups">UPS</option>
              <option value="fedex">FedEx</option>
              <option value="usps">USPS</option>
              <option value="dhl">DHL</option>
            </select>
            <input
              placeholder="Tracking number (optional)"
              value={draft.trackingNumber}
              onChange={e => setDraft({ ...draft, trackingNumber: e.target.value })}
              className="text-xs border rounded px-2 py-1.5 col-span-2"
            />
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => void createOrder()}
              disabled={creating}
              className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {creating ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save order'}
            </button>
          </div>
        </div>
      )}

      {loading && orders.length === 0 ? (
        <div className="flex items-center justify-center py-6 text-gray-400 text-xs">
          <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> Loading…
        </div>
      ) : orders.length === 0 ? (
        <div className="text-center py-6 text-xs text-gray-400">
          No orders yet. Click <span className="font-medium">New order</span> after placing one for the customer.
        </div>
      ) : (
        <div className="space-y-2">
          {orders.map(o => {
            const isOpen = expanded === o.id;
            return (
              <div key={o.id} className="border rounded-lg overflow-hidden">
                <button
                  onClick={() => toggleExpand(o)}
                  className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-gray-50"
                >
                  {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
                  <span className="font-medium text-sm flex-1 truncate">
                    {o.merchant_name || 'Unknown merchant'}
                    {o.merchant_order_id ? <span className="text-gray-400 font-normal"> · #{o.merchant_order_id}</span> : null}
                  </span>
                  <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded font-medium ${STATUS_COLORS[o.status] || 'bg-gray-100 text-gray-700'}`}>
                    {o.status}
                  </span>
                  {o.shipment_status && (
                    <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded font-medium ${SHIP_COLORS[o.shipment_status] || 'bg-gray-100 text-gray-700'}`}>
                      <Truck className="w-2.5 h-2.5 inline -mt-0.5 mr-0.5" />
                      {o.shipment_status.replace(/_/g, ' ')}
                    </span>
                  )}
                </button>
                {isOpen && (
                  <div className="px-3 pb-3 pt-1 border-t bg-gray-50 text-xs space-y-2">
                    {o.item_summary && <div><span className="text-gray-500">Items:</span> {o.item_summary}</div>}
                    {typeof o.total_amount === 'number' && <div><span className="text-gray-500">Total:</span> ${o.total_amount.toFixed(2)} {o.currency || 'USD'}</div>}
                    {o.ordered_at && <div><span className="text-gray-500">Ordered:</span> {formatDateTime(o.ordered_at)}</div>}
                    {o.tracking_number ? (
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-gray-500">Tracking:</span>
                          <code className="font-mono">{o.tracking_number}</code>
                          <span className="text-gray-400">({o.carrier?.toUpperCase() || 'unknown'})</span>
                          {o.tracking_url && (
                            <a href={o.tracking_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-0.5">
                              <ExternalLink className="w-3 h-3" /> open
                            </a>
                          )}
                          {o.shipment_id && (
                            <button
                              onClick={() => void refreshShipment(o.shipment_id!)}
                              className="ml-auto text-[10px] px-1.5 py-0.5 border rounded hover:bg-white"
                              title="Re-poll the carrier"
                            >
                              <RefreshCw className="w-2.5 h-2.5 inline" /> Refresh
                            </button>
                          )}
                        </div>
                        {o.estimated_delivery_date && (
                          <div><span className="text-gray-500">ETA:</span> {new Date(o.estimated_delivery_date).toLocaleDateString()}</div>
                        )}
                        {o.last_status_message && (
                          <div className="text-gray-600">{o.last_status_message}</div>
                        )}
                        {o.shipment_id && eventsByShipment[o.shipment_id] && eventsByShipment[o.shipment_id].length > 0 && (
                          <div className="border-l-2 border-gray-300 pl-2 space-y-1 mt-2">
                            {eventsByShipment[o.shipment_id].map(ev => (
                              <div key={ev.id} className="text-[11px] text-gray-600">
                                <div className="font-medium">{ev.description || ev.status_code}</div>
                                <div className="text-gray-400">
                                  {formatDateTime(ev.occurred_at)}{ev.location ? ` · ${ev.location}` : ''}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 pt-1">
                        <select
                          value={trackingInput[o.id]?.carrier || ''}
                          onChange={e => setTrackingInput(prev => ({ ...prev, [o.id]: { ...(prev[o.id] || { number: '' }), carrier: e.target.value } }))}
                          className="text-[11px] border rounded px-1.5 py-1"
                        >
                          <option value="">auto</option>
                          <option value="ups">UPS</option>
                          <option value="fedex">FedEx</option>
                          <option value="usps">USPS</option>
                          <option value="dhl">DHL</option>
                        </select>
                        <input
                          placeholder="Paste tracking #"
                          value={trackingInput[o.id]?.number || ''}
                          onChange={e => setTrackingInput(prev => ({ ...prev, [o.id]: { ...(prev[o.id] || { carrier: '' }), number: e.target.value } }))}
                          className="flex-1 text-[11px] border rounded px-1.5 py-1"
                        />
                        <button
                          onClick={() => void attachTracking(o.id)}
                          className="text-[11px] px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                        >
                          Attach
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

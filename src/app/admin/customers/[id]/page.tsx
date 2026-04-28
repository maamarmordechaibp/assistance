'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { formatPhone, formatMinutes, formatCurrency, formatDateTime, formatDuration } from '@/lib/utils';
import { toast } from 'sonner';
import {
  User,
  Phone,
  Clock,
  DollarSign,
  History,
  Edit,
  Save,
  Loader2,
  ArrowLeft,
} from 'lucide-react';
import Link from 'next/link';
import { edgeFn } from '@/lib/supabase/edge';
import OrdersPanel from '@/components/rep/orders-panel';
import BrowserLockBadge from '@/components/rep/browser-lock-badge';
import ForwardingSetupCard from '@/components/rep/forwarding-setup-card';

interface Customer {
  id: string;
  full_name: string;
  primary_phone: string;
  secondary_phone: string | null;
  email: string | null;
  assigned_email: string | null;
  personal_email: string | null;
  forwarding_verified_at: string | null;
  address: string | null;
  internal_notes: string | null;
  status: string;
  current_balance_minutes: number;
  total_minutes_purchased: number;
  total_minutes_used: number;
  created_at: string;
}

interface LedgerEntry {
  id: string;
  entry_type: string;
  minutes_amount: number;
  dollar_amount: number | null;
  reason: string | null;
  created_at: string;
}

interface Call {
  id: string;
  started_at: string;
  total_duration_seconds: number | null;
  minutes_deducted: number;
  outcome_status: string | null;
  rep?: { full_name: string } | null;
  task_category?: { name: string } | null;
}

export default function AdminCustomerDetail() {
  const { id } = useParams();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [calls, setCalls] = useState<Call[]>([]);
  const [editing, setEditing] = useState(false);
  const [formData, setFormData] = useState<Partial<Customer>>({});
  const [loading, setLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    async function load() {
      const [{ data: cust }, ledgerRes, callsRes] = await Promise.all([
        supabase.from('customers').select('*').eq('id', id).single(),
        edgeFn('ledger', { params: { customerId: id as string, limit: '20' } }),
        edgeFn('calls', { params: { customerId: id as string, limit: '20' } }),
      ]);

      if (cust) {
        setCustomer(cust as Customer);
        setFormData(cust);
      }

      if (ledgerRes.ok) {
        const data = await ledgerRes.json();
        setLedger(data.entries || []);
      }

      if (callsRes.ok) {
        const data = await callsRes.json();
        setCalls(data.calls || []);
      }

      setLoading(false);
    }
    load();
  }, [id]);

  const handleSave = async () => {
    const res = await edgeFn('customers', {
      method: 'PATCH',
      body: JSON.stringify({
        id,
        fullName: formData.full_name,
        primaryPhone: formData.primary_phone,
        secondaryPhone: formData.secondary_phone,
        email: formData.email,
        address: formData.address,
        internalNotes: formData.internal_notes,
        status: formData.status,
      }),
    });
    if (res.ok) {
      const updated = await res.json();
      setCustomer(updated);
      setEditing(false);
      toast.success('Customer updated');
    } else {
      toast.error('Failed to update customer');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
      </div>
    );
  }

  if (!customer) {
    return <div className="text-center py-12 text-muted-foreground">Customer not found.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/admin/customers" className="p-2 rounded-lg hover:bg-muted">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <h2 className="text-xl font-semibold">{customer.full_name}</h2>
        <span
          className={`px-2 py-0.5 rounded text-xs font-medium ${
            customer.status === 'active'
              ? 'bg-success/15 text-success'
              : customer.status === 'flagged'
              ? 'bg-destructive/15 text-destructive'
              : 'bg-muted text-foreground'
          }`}
        >
          {customer.status}
        </span>
        <div className="ml-auto">
          <BrowserLockBadge customerId={customer.id} isAdmin />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Customer Info Card */}
        <div className="bg-card rounded-xl shadow-sm border p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">Customer Info</h3>
            <button
              onClick={() => (editing ? handleSave() : setEditing(true))}
              className="flex items-center gap-1 text-sm text-accent hover:text-accent"
            >
              {editing ? <Save className="w-4 h-4" /> : <Edit className="w-4 h-4" />}
              {editing ? 'Save' : 'Edit'}
            </button>
          </div>
          <div className="space-y-3 text-sm">
            {editing ? (
              <>
                <div>
                  <label className="text-muted-foreground text-xs">Full Name</label>
                  <input
                    value={formData.full_name || ''}
                    onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
                    className="w-full border rounded px-2 py-1 text-sm"
                  />
                </div>
                <div>
                  <label className="text-muted-foreground text-xs">Phone</label>
                  <input
                    value={formData.primary_phone || ''}
                    onChange={(e) => setFormData({ ...formData, primary_phone: e.target.value })}
                    className="w-full border rounded px-2 py-1 text-sm"
                  />
                </div>
                <div>
                  <label className="text-muted-foreground text-xs">Email</label>
                  <input
                    value={formData.email || ''}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    className="w-full border rounded px-2 py-1 text-sm"
                  />
                </div>
                <div>
                  <label className="text-muted-foreground text-xs">Status</label>
                  <select
                    value={formData.status || ''}
                    onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                    className="w-full border rounded px-2 py-1 text-sm"
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                    <option value="flagged">Flagged</option>
                  </select>
                </div>
                <div>
                  <label className="text-muted-foreground text-xs">Notes</label>
                  <textarea
                    value={formData.internal_notes || ''}
                    onChange={(e) => setFormData({ ...formData, internal_notes: e.target.value })}
                    rows={3}
                    className="w-full border rounded px-2 py-1 text-sm"
                  />
                </div>
              </>
            ) : (
              <>
                <div>
                  <span className="text-muted-foreground">Phone:</span> {formatPhone(customer.primary_phone)}
                </div>
                {customer.secondary_phone && (
                  <div>
                    <span className="text-muted-foreground">Alt Phone:</span> {formatPhone(customer.secondary_phone)}
                  </div>
                )}
                <div>
                  <span className="text-muted-foreground">Email:</span> {customer.email || 'N/A'}
                </div>
                <div>
                  <span className="text-muted-foreground">Address:</span> {customer.address || 'N/A'}
                </div>
                {customer.internal_notes && (
                  <div className="mt-2 p-2 bg-warning/10 rounded text-xs">
                    {customer.internal_notes}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Balance Card */}
        <div className="bg-card rounded-xl shadow-sm border p-6">
          <h3 className="font-semibold mb-4">Balance Overview</h3>
          <div className="space-y-4">
            <div className="text-center">
              <div className="text-3xl font-bold text-accent">
                {formatMinutes(customer.current_balance_minutes)}
              </div>
              <div className="text-sm text-muted-foreground">Current Balance</div>
            </div>
            <div className="grid grid-cols-2 gap-4 text-center">
              <div>
                <div className="text-lg font-semibold text-success">
                  {formatMinutes(customer.total_minutes_purchased)}
                </div>
                <div className="text-xs text-muted-foreground">Purchased</div>
              </div>
              <div>
                <div className="text-lg font-semibold text-warning">
                  {formatMinutes(customer.total_minutes_used)}
                </div>
                <div className="text-xs text-muted-foreground">Used</div>
              </div>
            </div>
          </div>
        </div>

        {/* Minute Ledger */}
        <div className="bg-card rounded-xl shadow-sm border p-6">
          <h3 className="font-semibold mb-4">Recent Transactions</h3>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {ledger.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between text-sm py-2 border-b last:border-0"
              >
                <div>
                  <span
                    className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                      entry.entry_type === 'purchase'
                        ? 'bg-success/15 text-success'
                        : entry.entry_type === 'deduction'
                        ? 'bg-destructive/15 text-destructive'
                        : 'bg-accent/15 text-accent'
                    }`}
                  >
                    {entry.entry_type}
                  </span>
                  <span className="ml-2 text-muted-foreground text-xs">{entry.reason}</span>
                </div>
                <span
                  className={`font-mono font-medium ${
                    entry.minutes_amount >= 0 ? 'text-success' : 'text-destructive'
                  }`}
                >
                  {entry.minutes_amount > 0 ? '+' : ''}{entry.minutes_amount} min
                </span>
              </div>
            ))}
            {ledger.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">No transactions yet.</p>
            )}
          </div>
        </div>
      </div>

      {/* Call History */}
      <div className="bg-card rounded-xl shadow-sm border overflow-hidden">
        <div className="px-6 py-4 border-b">
          <h3 className="font-semibold flex items-center gap-2">
            <History className="w-4 h-4" />
            Call History
          </h3>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-muted/40 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Date</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Rep</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Category</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Duration</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Minutes</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Outcome</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {calls.map((call) => (
              <tr key={call.id} className="hover:bg-muted/50">
                <td className="px-4 py-3">{formatDateTime(call.started_at)}</td>
                <td className="px-4 py-3">{call.rep?.full_name || '—'}</td>
                <td className="px-4 py-3">{call.task_category?.name || '—'}</td>
                <td className="px-4 py-3 font-mono">
                  {call.total_duration_seconds ? formatDuration(call.total_duration_seconds) : '—'}
                </td>
                <td className="px-4 py-3">{call.minutes_deducted} min</td>
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Email forwarding setup */}
      <ForwardingSetupCard
        customerId={customer.id}
        assignedEmail={customer.assigned_email}
        personalEmail={customer.personal_email}
        forwardingVerifiedAt={customer.forwarding_verified_at}
        onUpdate={(next) => setCustomer({ ...customer, personal_email: next.personal_email })}
      />

      {/* Orders & Tracking */}
      <OrdersPanel customerId={customer.id} />
    </div>
  );
}

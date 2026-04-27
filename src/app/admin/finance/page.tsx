'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DollarSign, TrendingUp, ArrowDownCircle, Loader2, Clock, Wallet } from 'lucide-react';
import { PageHeader } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { edgeFn } from '@/lib/supabase/edge';
import { formatCurrency } from '@/lib/utils';

interface Withdrawal {
  id: string;
  amount: number;
  method: string;
  notes: string | null;
  status: string;
  created_at: string;
}

interface Summary {
  totalRevenue: number;
  totalWithdrawn: number;
  estimatedCosts: number;
  availableBalance: number;
  totalMinutesUsed: number;
}

export default function AdminFinancePage() {
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('bank_transfer');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchData = async () => {
    const res = await edgeFn('withdrawals');
    if (res.ok) {
      const data = await res.json();
      setWithdrawals(data.withdrawals || []);
      setSummary(data.summary || null);
    }
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  const handleWithdraw = async () => {
    const num = parseFloat(amount);
    if (!num || num <= 0) {
      toast.error('Enter a valid amount');
      return;
    }
    if (summary && num > summary.availableBalance) {
      toast.error('Amount exceeds available balance');
      return;
    }
    setSubmitting(true);
    const res = await edgeFn('withdrawals', {
      method: 'POST',
      body: JSON.stringify({ amount: num, method, notes: notes || undefined }),
    });
    if (res.ok) {
      toast.success('Withdrawal recorded');
      setAmount('');
      setNotes('');
      setShowForm(false);
      fetchData();
    } else {
      toast.error('Failed to record withdrawal');
    }
    setSubmitting(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Wallet />}
        title="Finance & Withdrawals"
        description="Revenue, balances, and withdrawal history."
        actions={
          <Button variant="success" onClick={() => setShowForm(!showForm)}>
            <ArrowDownCircle /> Withdraw
          </Button>
        }
      />

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-card rounded-xl shadow-sm border p-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted-foreground">Total Revenue</span>
              <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-success/15 text-success">
                <TrendingUp className="w-5 h-5" />
              </div>
            </div>
            <div className="text-2xl font-bold text-success">{formatCurrency(summary.totalRevenue)}</div>
          </div>
          <div className="bg-card rounded-xl shadow-sm border p-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted-foreground">Estimated Costs</span>
              <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-destructive/15 text-destructive">
                <DollarSign className="w-5 h-5" />
              </div>
            </div>
            <div className="text-2xl font-bold text-destructive">{formatCurrency(summary.estimatedCosts)}</div>
            <div className="text-xs text-muted-foreground mt-1">{summary.totalMinutesUsed} min used @ $0.24/min</div>
          </div>
          <div className="bg-card rounded-xl shadow-sm border p-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted-foreground">Withdrawn</span>
              <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-warning/15 text-warning">
                <ArrowDownCircle className="w-5 h-5" />
              </div>
            </div>
            <div className="text-2xl font-bold text-warning">{formatCurrency(summary.totalWithdrawn)}</div>
          </div>
          <div className="bg-card rounded-xl shadow-sm border p-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted-foreground">Available Balance</span>
              <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-accent/15 text-accent">
                <Wallet className="w-5 h-5" />
              </div>
            </div>
            <div className={`text-2xl font-bold ${summary.availableBalance >= 0 ? 'text-accent' : 'text-destructive'}`}>
              {formatCurrency(summary.availableBalance)}
            </div>
          </div>
        </div>
      )}

      {/* Withdrawal form */}
      {showForm && (
        <div className="bg-card rounded-xl shadow-sm border p-6">
          <h3 className="font-semibold mb-4">Record Withdrawal</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Amount ($)</label>
              <input
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Method</label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="bank_transfer">Bank Transfer</option>
                <option value="check">Check</option>
                <option value="cash">Cash</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Notes</label>
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional"
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground">
              Cancel
            </button>
            <button
              onClick={handleWithdraw}
              disabled={submitting}
              className="flex items-center gap-2 px-4 py-2 bg-success text-white rounded-lg hover:bg-success/90 text-sm disabled:opacity-50"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowDownCircle className="w-4 h-4" />}
              Record Withdrawal
            </button>
          </div>
        </div>
      )}

      {/* Withdrawal history */}
      <div className="bg-card rounded-xl shadow-sm border overflow-hidden">
        <div className="px-6 py-4 border-b">
          <h3 className="font-semibold">Withdrawal History</h3>
        </div>
        {withdrawals.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">No withdrawals yet</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="px-6 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Date</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Amount</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Method</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Notes</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {withdrawals.map((w) => (
                <tr key={w.id}>
                  <td className="px-6 py-4 text-sm">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Clock className="w-4 h-4" />
                      {new Date(w.created_at).toLocaleDateString()} {new Date(w.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </td>
                  <td className="px-6 py-4 font-semibold text-success">{formatCurrency(Number(w.amount))}</td>
                  <td className="px-6 py-4 text-sm capitalize">{w.method.replace('_', ' ')}</td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">{w.notes || '—'}</td>
                  <td className="px-6 py-4">
                    <span className="px-2 py-1 rounded-full text-xs font-medium bg-success/15 text-success capitalize">
                      {w.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { formatPhone, formatMinutes, formatDateTime } from '@/lib/utils';
import { toast } from 'sonner';
import { Users, Search, Plus, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { PageHeader } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
import { edgeFn } from '@/lib/supabase/edge';

interface Customer {
  id: string;
  full_name: string;
  primary_phone: string;
  secondary_phone: string | null;
  email: string | null;
  current_balance_minutes: number;
  status: string;
  created_at: string;
}

export default function RepCustomers() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newCustomer, setNewCustomer] = useState({
    fullName: '',
    primaryPhone: '',
    email: '',
  });
  const limit = 25;

  const fetchCustomers = async (p: number, q: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: p.toString(), limit: limit.toString() });
      if (q) params.set('search', q);
      const res = await edgeFn('customers', { params: Object.fromEntries(params) });
      if (res.ok) {
        const data = await res.json();
        setCustomers(data.customers || []);
        setTotal(data.total || 0);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCustomers(page, search);
  }, [page]);

  const handleSearch = () => {
    setPage(1);
    fetchCustomers(1, search);
  };

  const handleAdd = async () => {
    if (!newCustomer.fullName.trim() || !newCustomer.primaryPhone.trim()) {
      toast.error('Name and phone number are required');
      return;
    }
    const res = await edgeFn('customers', {
      method: 'POST',
      body: JSON.stringify(newCustomer),
    });
    if (res.ok) {
      setShowAdd(false);
      setNewCustomer({ fullName: '', primaryPhone: '', email: '' });
      fetchCustomers(page, search);
      toast.success('Customer added');
    } else {
      toast.error('Failed to add customer');
    }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Users />}
        title="Customers"
        description="Your assigned customers and their account history."
        actions={
          <Button variant="accent" onClick={() => setShowAdd(true)}>
            <Plus /> Add Customer
          </Button>
        }
      />

      {/* Search */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/80" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Search by name, phone, or email..."
            className="w-full pl-10 pr-4 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <button
          onClick={handleSearch}
          className="px-4 py-2 bg-muted rounded-lg text-sm font-medium hover:bg-muted transition"
        >
          Search
        </button>
      </div>

      {/* Add Customer Modal */}
      {showAdd && (
        <div className="bg-card rounded-xl shadow-sm border p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">New Customer</h3>
            <button onClick={() => setShowAdd(false)}>
              <X className="w-5 h-5 text-muted-foreground" />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <input
              type="text"
              placeholder="Full Name *"
              value={newCustomer.fullName}
              onChange={(e) =>
                setNewCustomer({ ...newCustomer, fullName: e.target.value })
              }
              className="rounded-lg border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <input
              type="text"
              placeholder="Phone Number *"
              value={newCustomer.primaryPhone}
              onChange={(e) =>
                setNewCustomer({ ...newCustomer, primaryPhone: e.target.value })
              }
              className="rounded-lg border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <input
              type="email"
              placeholder="Email"
              value={newCustomer.email}
              onChange={(e) =>
                setNewCustomer({ ...newCustomer, email: e.target.value })
              }
              className="rounded-lg border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex justify-end mt-4">
            <button
              onClick={handleAdd}
              className="bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent/90"
            >
              Create Customer
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-card rounded-xl shadow-sm border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Phone</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Email</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Balance</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {customers.map((c) => (
              <tr key={c.id} className="hover:bg-muted/50 transition">
                <td className="px-4 py-3 font-medium">{c.full_name}</td>
                <td className="px-4 py-3 text-muted-foreground">{formatPhone(c.primary_phone)}</td>
                <td className="px-4 py-3 text-muted-foreground">{c.email || '—'}</td>
                <td className="px-4 py-3">
                  <span
                    className={`font-semibold ${
                      c.current_balance_minutes <= 0
                        ? 'text-destructive'
                        : c.current_balance_minutes <= 5
                        ? 'text-warning'
                        : 'text-success'
                    }`}
                  >
                    {formatMinutes(c.current_balance_minutes)}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      c.status === 'active'
                        ? 'bg-success/15 text-success'
                        : c.status === 'flagged'
                        ? 'bg-destructive/15 text-destructive'
                        : 'bg-muted text-foreground'
                    }`}
                  >
                    {c.status}
                  </span>
                </td>
              </tr>
            ))}
            {customers.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">
                  No customers found.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t bg-muted/40">
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages} ({total} total)
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page === 1}
                className="p-2 rounded-lg border bg-card hover:bg-muted/50 disabled:opacity-50"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                disabled={page === totalPages}
                className="p-2 rounded-lg border bg-card hover:bg-muted/50 disabled:opacity-50"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

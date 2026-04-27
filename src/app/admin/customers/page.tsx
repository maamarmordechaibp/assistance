'use client';

import { useEffect, useState } from 'react';
import { formatPhone, formatMinutes, formatDateTime } from '@/lib/utils';
import Link from 'next/link';
import { Users, Search, ChevronLeft, ChevronRight, Eye } from 'lucide-react';
import { edgeFn } from '@/lib/supabase/edge';
import { PageHeader } from '@/components/ui/page';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';

interface Customer {
  id: string;
  full_name: string;
  primary_phone: string;
  email: string | null;
  current_balance_minutes: number;
  total_minutes_purchased: number;
  total_minutes_used: number;
  status: string;
  created_at: string;
}

export default function AdminCustomers() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
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

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Users />}
        title="Customers"
        description={`${total.toLocaleString()} customer${total === 1 ? '' : 's'} on record`}
      />

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Search by name, phone, or email…"
            className="pl-9"
          />
        </div>
        <Button variant="secondary" onClick={handleSearch}>
          Search
        </Button>
      </div>

      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Balance</TableHead>
              <TableHead>Purchased</TableHead>
              <TableHead>Used</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {customers.map((c) => (
              <TableRow key={c.id} className="hover:bg-muted/40">
                <TableCell className="font-medium">{c.full_name}</TableCell>
                <TableCell className="text-muted-foreground">{formatPhone(c.primary_phone)}</TableCell>
                <TableCell>
                  <span
                    className={
                      c.current_balance_minutes <= 0
                        ? 'font-semibold text-destructive'
                        : 'font-semibold text-success'
                    }
                  >
                    {formatMinutes(c.current_balance_minutes)}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">{formatMinutes(c.total_minutes_purchased)}</TableCell>
                <TableCell className="text-muted-foreground">{formatMinutes(c.total_minutes_used)}</TableCell>
                <TableCell>
                  <Badge
                    variant={
                      c.status === 'active' ? 'success'
                      : c.status === 'flagged' ? 'destructive'
                      : 'muted'
                    }
                  >
                    {c.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{formatDateTime(c.created_at)}</TableCell>
                <TableCell>
                  <Button asChild variant="ghost" size="icon-sm">
                    <Link href={`/admin/customers/${c.id}`}>
                      <Eye className="size-4" />
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {customers.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={8} className="py-12 text-center text-muted-foreground">
                  No customers found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t bg-muted/30 px-4 py-3">
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages} ({total} total)
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="icon-sm"
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page === 1}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                disabled={page === totalPages}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

'use client';

// Shared email inbox view used by /rep/emails and /admin/emails.
//
// Reads directly from `customer_emails` via supabase-js (RLS already
// permits authenticated SELECT/UPDATE). Composing a new message hits
// the `email-send` edge function which sends FROM the customer's
// assigned mailbox via Resend and logs an outbound row.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { edgeFn } from '@/lib/supabase/edge';
import { formatDateTime, formatPhone } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Mail,
  MailOpen,
  Search,
  Send,
  RefreshCw,
  ExternalLink,
  Copy,
  CheckCircle2,
  Inbox,
  ArrowUpRight,
  Star,
  X,
  Reply,
  Loader2,
  KeyRound,
  Link as LinkIcon,
  Forward as ForwardIcon,
  Trash2,
  CheckCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { PageHeader, EmptyState } from '@/components/ui/page';
import { cn } from '@/lib/utils';

interface CustomerLite {
  id: string;
  full_name: string | null;
  primary_phone: string | null;
  assigned_email: string | null;
  personal_email?: string | null;
}

interface EmailRow {
  id: string;
  customer_id: string | null;
  mailbox: string;
  direction: 'inbound' | 'outbound';
  from_address: string | null;
  from_name: string | null;
  to_addresses: string[] | null;
  cc_addresses: string[] | null;
  reply_to: string | null;
  subject: string | null;
  text_body: string | null;
  html_body: string | null;
  snippet: string | null;
  detected_otp: string | null;
  message_id: string | null;
  is_read: boolean;
  starred: boolean;
  received_at: string;
  forwarded_at: string | null;
  forwarded_to: string | null;
  deleted_at: string | null;
  customer?: CustomerLite | null;
}

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

function extractLinks(text: string | null | undefined): string[] {
  if (!text) return [];
  const matches = text.match(URL_REGEX) || [];
  return Array.from(new Set(matches));
}

function copy(s: string) {
  try {
    navigator.clipboard.writeText(s);
    toast.success('Copied');
  } catch {
    toast.error('Copy failed');
  }
}

interface ComposeProps {
  customer: CustomerLite | null;
  defaultTo?: string;
  defaultSubject?: string;
  defaultReplyTo?: string;
  onClose: () => void;
  onSent: () => void;
}

function ComposeModal({ customer, defaultTo, defaultSubject, defaultReplyTo, onClose, onSent }: ComposeProps) {
  const supabase = useMemo(() => createClient(), []);
  const [picked, setPicked] = useState<CustomerLite | null>(customer);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerOptions, setCustomerOptions] = useState<CustomerLite[]>([]);
  const [searchingCustomers, setSearchingCustomers] = useState(false);
  const [to, setTo] = useState(defaultTo || '');
  const [subject, setSubject] = useState(defaultSubject || '');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  // Load matching customers when no customer is preset and the rep is typing.
  useEffect(() => {
    if (picked) return;
    let cancelled = false;
    const term = customerSearch.trim();
    setSearchingCustomers(true);
    const run = async () => {
      let q = supabase
        .from('customers')
        .select('id, full_name, primary_phone, assigned_email')
        .not('assigned_email', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(20);
      if (term) {
        // Match by name, phone or assigned mailbox.
        q = q.or(
          `full_name.ilike.%${term}%,primary_phone.ilike.%${term}%,assigned_email.ilike.%${term}%`
        );
      }
      const { data, error } = await q;
      if (cancelled) return;
      if (error) {
        toast.error('Customer search failed: ' + error.message);
        setCustomerOptions([]);
      } else {
        setCustomerOptions((data as unknown as CustomerLite[]) || []);
      }
      setSearchingCustomers(false);
    };
    const t = setTimeout(run, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [supabase, customerSearch, picked]);

  const send = async () => {
    if (!picked?.id) {
      toast.error('Pick a customer first');
      return;
    }
    if (!to.trim() || !subject.trim() || !body.trim()) {
      toast.error('To, subject, and body are required');
      return;
    }
    setSending(true);
    try {
      const res = await edgeFn('email-send', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: picked.id,
          to: to.split(',').map((s) => s.trim()).filter(Boolean),
          subject,
          text: body,
          reply_to: defaultReplyTo || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || `Send failed (${res.status})`);
        return;
      }
      toast.success('Email sent');
      onSent();
      onClose();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-xl border border-border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <Send className="size-4 text-accent" />
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">
                {picked ? `Send as ${picked.full_name || 'customer'}` : 'Compose email'}
              </div>
              {picked?.assigned_email && (
                <div className="text-xs text-muted-foreground truncate">From: {picked.assigned_email}</div>
              )}
            </div>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <X />
          </Button>
        </div>
        <div className="space-y-3 p-4">
          {!picked ? (
            <div>
              <label className="text-xs font-medium text-muted-foreground">Send as customer</label>
              <Input
                value={customerSearch}
                onChange={(e) => setCustomerSearch(e.target.value)}
                placeholder="Search by name, phone, or assigned mailbox…"
                autoFocus
              />
              <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-border">
                {searchingCustomers && customerOptions.length === 0 ? (
                  <div className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Searching…
                  </div>
                ) : customerOptions.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    No customers with an assigned mailbox match.
                  </div>
                ) : (
                  <ul className="divide-y divide-border">
                    {customerOptions.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-muted/50"
                          onClick={() => setPicked(c)}
                        >
                          <span className="text-sm font-medium">{c.full_name || 'Unnamed customer'}</span>
                          <span className="text-xs text-muted-foreground">
                            {c.assigned_email || 'no mailbox'}
                            {c.primary_phone ? ' · ' + formatPhone(c.primary_phone) : ''}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
              <span>
                Sending as <strong>{picked.full_name || 'customer'}</strong>
                {picked.assigned_email ? ` <${picked.assigned_email}>` : ''}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setPicked(null)}>
                Change
              </Button>
            </div>
          )}
          <div>
            <label className="text-xs font-medium text-muted-foreground">To (comma-separated)</label>
            <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient@example.com" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Subject</label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Message</label>
            <textarea
              className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              rows={10}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={sending}>
              Cancel
            </Button>
            <Button variant="accent" onClick={send} loading={sending} disabled={!picked}>
              <Send /> Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export interface EmailInboxProps {
  /** restrict to a single customer (used on customer detail pages) */
  customerId?: string;
  /** view label/icon for header */
  title?: string;
  description?: string;
  /** when true, exposes Trash view + Restore + Permanent delete (admin-only) */
  isAdmin?: boolean;
}

export default function EmailInbox({ customerId, title, description, isAdmin = false }: EmailInboxProps) {
  const supabase = useMemo(() => createClient(), []);
  const [emails, setEmails] = useState<EmailRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'unread' | 'inbound' | 'outbound' | 'otp'>('all');
  const [showTrash, setShowTrash] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeCustomer, setComposeCustomer] = useState<CustomerLite | null>(null);
  const [composeDefaults, setComposeDefaults] = useState<{ to?: string; subject?: string; replyTo?: string }>({});
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    let q = supabase
      .from('customer_emails')
      .select(
        'id, customer_id, mailbox, direction, from_address, from_name, to_addresses, cc_addresses, reply_to, subject, text_body, html_body, snippet, detected_otp, message_id, is_read, starred, received_at, forwarded_at, forwarded_to, deleted_at, customer:customers ( id, full_name, primary_phone, assigned_email, personal_email )'
      )
      .order('received_at', { ascending: false })
      .limit(200);
    if (showTrash && isAdmin) q = q.not('deleted_at', 'is', null);
    else q = q.is('deleted_at', null);
    if (customerId) q = q.eq('customer_id', customerId);
    const { data, error } = await q;
    if (error) {
      toast.error('Failed to load emails: ' + error.message);
    } else {
      setEmails((data as unknown as EmailRow[]) || []);
    }
    setLoading(false);
  }, [supabase, customerId, showTrash, isAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  // Realtime: refresh when new email arrives.
  useEffect(() => {
    const ch = supabase
      .channel('customer_emails_inbox')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'customer_emails' },
        () => {
          load();
        }
      )
      .subscribe();
    channelRef.current = ch;
    return () => {
      try {
        supabase.removeChannel(ch);
      } catch {}
    };
  }, [supabase, load]);

  const filtered = useMemo(() => {
    let rows = emails;
    if (filter === 'unread') rows = rows.filter((e) => !e.is_read && e.direction === 'inbound');
    else if (filter === 'inbound') rows = rows.filter((e) => e.direction === 'inbound');
    else if (filter === 'outbound') rows = rows.filter((e) => e.direction === 'outbound');
    else if (filter === 'otp') rows = rows.filter((e) => !!e.detected_otp);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter((e) =>
        [
          e.subject,
          e.snippet,
          e.text_body,
          e.from_address,
          e.from_name,
          e.mailbox,
          e.customer?.full_name,
          e.customer?.primary_phone,
        ]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(q))
      );
    }
    return rows;
  }, [emails, filter, search]);

  const selected = useMemo(() => filtered.find((e) => e.id === selectedId) || null, [filtered, selectedId]);

  const markRead = async (id: string, isRead: boolean) => {
    const { error } = await supabase.from('customer_emails').update({ is_read: isRead }).eq('id', id);
    if (error) toast.error('Update failed');
    else setEmails((rows) => rows.map((r) => (r.id === id ? { ...r, is_read: isRead } : r)));
  };

  const toggleStar = async (id: string, starred: boolean) => {
    const { error } = await supabase.from('customer_emails').update({ starred }).eq('id', id);
    if (error) toast.error('Update failed');
    else setEmails((rows) => rows.map((r) => (r.id === id ? { ...r, starred } : r)));
  };

  const forwardEmail = async (row: EmailRow, opts?: { force?: boolean }) => {
    if (row.direction !== 'inbound') {
      toast.error('Only inbound emails can be forwarded');
      return;
    }
    if (!row.customer?.personal_email) {
      toast.error("Customer has no personal email on file. Add it on the customer's page first.");
      return;
    }
    if (row.forwarded_at && !opts?.force) {
      const ok = window.confirm(
        `Already forwarded to ${row.forwarded_to || row.customer.personal_email} on ${formatDateTime(row.forwarded_at)}.\n\nForward again?`,
      );
      if (!ok) return;
    }
    const tid = toast.loading(`Forwarding to ${row.customer.personal_email}…`);
    try {
      const res = await edgeFn('email-forward', {
        method: 'POST',
        body: JSON.stringify({ email_id: row.id, force: Boolean(opts?.force || row.forwarded_at) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || `Forward failed (${res.status})`, { id: tid });
        return;
      }
      toast.success(`Forwarded to ${json.forwarded_to || row.customer.personal_email}`, { id: tid });
      setEmails((rows) =>
        rows.map((r) =>
          r.id === row.id
            ? { ...r, forwarded_at: json.forwarded_at || new Date().toISOString(), forwarded_to: json.forwarded_to || r.customer?.personal_email || null }
            : r,
        ),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { id: tid });
    }
  };

  const deleteEmail = async (row: EmailRow) => {
    if (!window.confirm('Delete this email? Reps cannot recover it — only admins can permanently remove or restore.')) return;
    const { error } = await supabase
      .from('customer_emails')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', row.id);
    if (error) {
      toast.error('Delete failed: ' + error.message);
      return;
    }
    toast.success('Email moved to trash');
    setEmails((rows) => rows.filter((r) => r.id !== row.id));
    if (selectedId === row.id) setSelectedId(null);
  };

  const restoreEmail = async (row: EmailRow) => {
    const { error } = await supabase
      .from('customer_emails')
      .update({ deleted_at: null, deleted_by: null })
      .eq('id', row.id);
    if (error) {
      toast.error('Restore failed: ' + error.message);
      return;
    }
    toast.success('Email restored');
    setEmails((rows) => rows.filter((r) => r.id !== row.id));
    if (selectedId === row.id) setSelectedId(null);
  };

  const permanentDelete = async (row: EmailRow) => {
    if (!window.confirm('Permanently delete this email? This cannot be undone.')) return;
    const { error } = await supabase.from('customer_emails').delete().eq('id', row.id);
    if (error) {
      toast.error('Permanent delete failed: ' + error.message);
      return;
    }
    toast.success('Email permanently deleted');
    setEmails((rows) => rows.filter((r) => r.id !== row.id));
    if (selectedId === row.id) setSelectedId(null);
  };

  const onSelect = (row: EmailRow) => {
    setSelectedId(row.id);
    if (!row.is_read && row.direction === 'inbound') markRead(row.id, true);
  };

  const startReply = (row: EmailRow) => {
    if (!row.customer) {
      toast.error('Cannot reply: this email is not linked to a customer');
      return;
    }
    setComposeCustomer(row.customer);
    setComposeDefaults({
      to: row.reply_to || row.from_address || '',
      subject: row.subject ? (row.subject.toLowerCase().startsWith('re:') ? row.subject : `Re: ${row.subject}`) : '',
    });
    setComposeOpen(true);
  };

  const startCompose = (cust?: CustomerLite | null) => {
    setComposeCustomer(cust || null);
    setComposeDefaults({});
    setComposeOpen(true);
  };

  const unreadCount = emails.filter((e) => !e.is_read && e.direction === 'inbound').length;
  const otpCount = emails.filter((e) => e.detected_otp).length;

  const links = selected ? extractLinks(selected.text_body || selected.html_body) : [];

  return (
    <div className="space-y-4">
      <PageHeader
        icon={<Mail />}
        title={
          <span className="flex items-center gap-2">
            {title || 'Customer emails'}
            {unreadCount > 0 && <Badge variant="destructive">{unreadCount}</Badge>}
          </span>
        }
        description={description || 'Shared inbox of every email sent or received from a customer mailbox.'}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load}>
              <RefreshCw /> Refresh
            </Button>
            <Button
              variant="accent"
              size="sm"
              onClick={() => {
                if (customerId) {
                  const cust = emails.find((e) => e.customer_id === customerId)?.customer || null;
                  startCompose(cust);
                } else {
                  startCompose(null);
                }
              }}
            >
              <Send /> Compose
            </Button>
          </>
        }
      />

      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search subject, sender, customer…"
              className="pl-8"
            />
          </div>
          <div className="flex gap-1">
            {(['all', 'unread', 'inbound', 'outbound', 'otp'] as const).map((f) => (
              <Button
                key={f}
                size="sm"
                variant={filter === f ? 'accent' : 'outline'}
                onClick={() => setFilter(f)}
                className="capitalize"
              >
                {f === 'otp' ? `OTP (${otpCount})` : f}
              </Button>
            ))}
            {isAdmin && (
              <Button
                size="sm"
                variant={showTrash ? 'destructive' : 'outline'}
                onClick={() => { setShowTrash((v) => !v); setSelectedId(null); }}
                title={showTrash ? 'Back to inbox' : 'Show deleted emails'}
              >
                <Trash2 /> {showTrash ? 'Trash (viewing)' : 'Trash'}
              </Button>
            )}
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(300px,420px)_1fr]">
        <Card className="overflow-hidden p-0">
          {loading ? (
            <div className="flex items-center justify-center p-12 text-muted-foreground">
              <Loader2 className="size-6 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState icon={<Inbox />} title="No emails" description="Nothing matches the current filter." />
          ) : (
            <ul className="max-h-[70vh] divide-y divide-border overflow-y-auto">
              {filtered.map((row) => {
                const isUnread = !row.is_read && row.direction === 'inbound';
                return (
                  <li key={row.id}>
                    <button
                      onClick={() => onSelect(row)}
                      className={cn(
                        'group flex w-full flex-col gap-1 px-3 py-3 text-left transition-colors',
                        selectedId === row.id ? 'bg-accent/10' : 'hover:bg-muted/50',
                        isUnread && 'bg-accent/[0.04]'
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          {row.direction === 'inbound' ? (
                            isUnread ? (
                              <Mail className="size-4 shrink-0 text-accent" />
                            ) : (
                              <MailOpen className="size-4 shrink-0 text-muted-foreground" />
                            )
                          ) : (
                            <ArrowUpRight className="size-4 shrink-0 text-success" />
                          )}
                          <span
                            className={cn(
                              'truncate text-sm',
                              isUnread ? 'font-semibold text-foreground' : 'text-foreground/80'
                            )}
                          >
                            {row.direction === 'inbound'
                              ? row.from_name || row.from_address || 'Unknown sender'
                              : row.to_addresses?.[0] || 'recipient'}
                          </span>
                        </div>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {formatDateTime(row.received_at)}
                        </span>
                      </div>
                      <div className="truncate text-xs font-medium text-foreground/90">
                        {row.subject || '(no subject)'}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate">{row.snippet || ''}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px]">
                        {row.customer ? (
                          <Badge variant="outline" className="text-[10px]">
                            {row.customer.full_name || formatPhone(row.customer.primary_phone || '')}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">
                            Unmatched: {row.mailbox}
                          </Badge>
                        )}
                        {row.detected_otp && (
                          <Badge variant="warning" className="text-[10px]">
                            <KeyRound className="mr-1 size-3" />
                            OTP {row.detected_otp}
                          </Badge>
                        )}
                        {extractLinks(row.text_body || row.html_body).length > 0 && (
                          <Badge variant="outline" className="text-[10px]">
                            <LinkIcon className="mr-1 size-3" />
                            link
                          </Badge>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="p-0">
          {!selected ? (
            <EmptyState icon={<Mail />} title="Pick an email" description="Select a message to read it." />
          ) : (
            <div className="flex h-full flex-col">
              <div className="border-b border-border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      {selected.direction === 'inbound' ? 'Received' : 'Sent'} · {formatDateTime(selected.received_at)}
                    </div>
                    <div className="mt-1 truncate text-lg font-semibold">{selected.subject || '(no subject)'}</div>
                    <div className="mt-2 grid gap-0.5 text-sm">
                      <div className="text-foreground/80">
                        <span className="text-muted-foreground">From: </span>
                        {selected.from_name ? `${selected.from_name} ` : ''}
                        &lt;{selected.from_address || '?'}&gt;
                      </div>
                      <div className="text-foreground/80">
                        <span className="text-muted-foreground">To: </span>
                        {(selected.to_addresses || []).join(', ') || selected.mailbox}
                      </div>
                      <div className="text-foreground/80">
                        <span className="text-muted-foreground">Mailbox: </span>
                        {selected.mailbox}
                        {selected.customer && (
                          <span className="text-muted-foreground">
                            {' '}
                            ({selected.customer.full_name}
                            {selected.customer.primary_phone
                              ? ' · ' + formatPhone(selected.customer.primary_phone)
                              : ''}
                            )
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => toggleStar(selected.id, !selected.starred)}
                        title={selected.starred ? 'Unstar' : 'Star'}
                      >
                        <Star className={cn(selected.starred && 'fill-warning text-warning')} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => markRead(selected.id, !selected.is_read)}
                        title={selected.is_read ? 'Mark unread' : 'Mark read'}
                      >
                        {selected.is_read ? <Mail /> : <MailOpen />}
                      </Button>
                    </div>
                    {selected.direction === 'inbound' && !showTrash && (
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button size="sm" variant="accent" onClick={() => startReply(selected)}>
                          <Reply /> Reply
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => forwardEmail(selected)}
                          disabled={!selected.customer?.personal_email}
                          title={
                            selected.customer?.personal_email
                              ? `Forward to ${selected.customer.personal_email}`
                              : 'Customer has no personal email on file'
                          }
                        >
                          <ForwardIcon /> {selected.forwarded_at ? 'Forward again' : 'Forward'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => deleteEmail(selected)} title="Delete">
                          <Trash2 /> Delete
                        </Button>
                      </div>
                    )}
                    {selected.direction === 'outbound' && !showTrash && (
                      <Button size="sm" variant="ghost" onClick={() => deleteEmail(selected)} title="Delete">
                        <Trash2 /> Delete
                      </Button>
                    )}
                    {showTrash && isAdmin && (
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => restoreEmail(selected)}>
                          <CheckCircle /> Restore
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => permanentDelete(selected)}>
                          <Trash2 /> Permanently delete
                        </Button>
                      </div>
                    )}
                  </div>
                </div>

                {selected.detected_otp && (
                  <div className="mt-3 flex items-center justify-between rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
                    <div className="flex items-center gap-2 text-sm">
                      <KeyRound className="size-4 text-warning" />
                      <span className="font-medium">One-time code detected</span>
                      <code className="rounded bg-background px-2 py-0.5 font-mono text-base font-semibold">
                        {selected.detected_otp}
                      </code>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => copy(selected.detected_otp!)}>
                      <Copy /> Copy
                    </Button>
                  </div>
                )}

                {selected.forwarded_at && (
                  <div className="mt-3 flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm">
                    <CheckCircle className="size-4 text-success" />
                    <span>
                      Forwarded to{' '}
                      <strong>{selected.forwarded_to || selected.customer?.personal_email}</strong>{' '}
                      on {formatDateTime(selected.forwarded_at)}
                    </span>
                  </div>
                )}

                {links.length > 0 && (
                  <div className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2">
                    <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                      <LinkIcon className="size-3.5" /> Links in this message ({links.length})
                    </div>
                    <ul className="space-y-1">
                      {links.slice(0, 8).map((href) => (
                        <li key={href} className="flex items-center gap-2 text-sm">
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="truncate text-accent underline-offset-2 hover:underline"
                          >
                            {href}
                          </a>
                          <Button variant="ghost" size="icon-sm" onClick={() => copy(href)} title="Copy link">
                            <Copy />
                          </Button>
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-muted-foreground hover:text-foreground"
                            title="Open"
                          >
                            <ExternalLink className="size-4" />
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-auto p-4">
                {selected.html_body ? (
                  // eslint-disable-next-line react/no-danger
                  <div
                    className="prose prose-sm max-w-none dark:prose-invert"
                    dangerouslySetInnerHTML={{ __html: selected.html_body }}
                  />
                ) : (
                  <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground/90">
                    {selected.text_body || selected.snippet || '(empty body)'}
                  </pre>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>

      {composeOpen && (
        <ComposeModal
          customer={composeCustomer}
          defaultTo={composeDefaults.to}
          defaultSubject={composeDefaults.subject}
          defaultReplyTo={composeDefaults.replyTo}
          onClose={() => setComposeOpen(false)}
          onSent={load}
        />
      )}
    </div>
  );
}

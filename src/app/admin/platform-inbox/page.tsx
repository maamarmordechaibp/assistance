'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { edgeFn } from '@/lib/supabase/edge';
import { formatDateTime } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Mail,
  MailOpen,
  Inbox,
  Star,
  RefreshCw,
  Copy,
  ExternalLink,
  X,
  Reply,
  Send,
  PenSquare,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const MAILBOXES = [
  { key: 'all',                          label: 'All',        color: 'text-foreground' },
  { key: 'office@offlinesbrowse.com',    label: 'Office',     color: 'text-blue-500'   },
  { key: 'complaints@offlinesbrowse.com',label: 'Complaints', color: 'text-red-500'    },
  { key: 'admin@offlinesbrowse.com',     label: 'Admin',      color: 'text-amber-500'  },
] as const;

type MailboxKey = (typeof MAILBOXES)[number]['key'];

const SEND_MAILBOXES = MAILBOXES.filter((m) => m.key !== 'all') as ReadonlyArray<{
  key: Exclude<MailboxKey, 'all'>;
  label: string;
  color: string;
}>;

interface PlatformEmail {
  id: string;
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
  message_id: string | null;
  is_read: boolean;
  starred: boolean;
  received_at: string;
}

function copy(s: string) {
  try {
    navigator.clipboard.writeText(s);
    toast.success('Copied');
  } catch {
    toast.error('Copy failed');
  }
}

function mailboxLabel(mailbox: string) {
  const found = MAILBOXES.find((m) => m.key === mailbox);
  return found ? found.label : mailbox;
}

function mailboxColor(mailbox: string) {
  const found = MAILBOXES.find((m) => m.key === mailbox);
  return found ? found.color : 'text-foreground';
}

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;
function extractLinks(text: string | null | undefined): string[] {
  if (!text) return [];
  return Array.from(new Set(text.match(URL_REGEX) || []));
}

interface ComposeModalProps {
  defaultFrom?: Exclude<MailboxKey, 'all'>;
  defaultTo?: string;
  defaultSubject?: string;
  defaultBody?: string;
  inReplyTo?: string | null;
  onClose: () => void;
  onSent: () => void;
}

function ComposeModal({
  defaultFrom,
  defaultTo,
  defaultSubject,
  defaultBody,
  inReplyTo,
  onClose,
  onSent,
}: ComposeModalProps) {
  const [from, setFrom] = useState<Exclude<MailboxKey, 'all'>>(
    defaultFrom || SEND_MAILBOXES[0].key,
  );
  const [to, setTo] = useState(defaultTo || '');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState(defaultSubject || '');
  const [body, setBody] = useState(defaultBody || '');
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!to.trim() || !subject.trim() || !body.trim()) {
      toast.error('To, subject, and body are required');
      return;
    }
    setSending(true);
    try {
      const res = await edgeFn('platform-email-send', {
        method: 'POST',
        body: JSON.stringify({
          from_mailbox: from,
          to: to.split(',').map((s) => s.trim()).filter(Boolean),
          cc: cc.split(',').map((s) => s.trim()).filter(Boolean),
          subject,
          text: body,
          in_reply_to: inReplyTo || undefined,
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl border border-border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Send className="size-4 text-accent" />
            <div className="text-sm font-semibold">
              {inReplyTo ? 'Reply' : 'New email'}
            </div>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <X />
          </Button>
        </div>
        <div className="space-y-3 p-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground">From</label>
            <select
              value={from}
              onChange={(e) => setFrom(e.target.value as Exclude<MailboxKey, 'all'>)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              {SEND_MAILBOXES.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label} &lt;{m.key}&gt;
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">To</label>
            <Input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="recipient@example.com (comma-separate multiple)"
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">CC (optional)</label>
            <Input
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              placeholder="someone@example.com"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Subject</label>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Message</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message…"
              className="mt-1 w-full min-h-48 rounded-md border border-border bg-background px-3 py-2 text-sm font-sans"
              rows={10}
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button variant="ghost" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={send} disabled={sending}>
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function PlatformInboxPage() {
  const supabase = useMemo(() => createClient(), []);
  const [emails, setEmails] = useState<PlatformEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<MailboxKey>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeDefaults, setComposeDefaults] = useState<{
    from?: Exclude<MailboxKey, 'all'>;
    to?: string;
    subject?: string;
    body?: string;
    inReplyTo?: string | null;
  }>({});
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('platform_emails')
      .select('id, mailbox, direction, from_address, from_name, to_addresses, cc_addresses, reply_to, subject, text_body, html_body, snippet, message_id, is_read, starred, received_at')
      .order('received_at', { ascending: false })
      .limit(300);
    if (error) {
      toast.error('Failed to load inbox: ' + error.message);
    } else {
      setEmails((data as PlatformEmail[]) || []);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  // Realtime updates
  useEffect(() => {
    const ch = supabase
      .channel('platform_emails_inbox')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'platform_emails' }, () => {
        load();
      })
      .subscribe();
    channelRef.current = ch;
    return () => { try { supabase.removeChannel(ch); } catch {} };
  }, [supabase, load]);

  const markRead = useCallback(async (id: string) => {
    await supabase.from('platform_emails').update({ is_read: true }).eq('id', id);
    setEmails((prev) => prev.map((e) => e.id === id ? { ...e, is_read: true } : e));
  }, [supabase]);

  const toggleStar = useCallback(async (id: string, current: boolean) => {
    await supabase.from('platform_emails').update({ starred: !current }).eq('id', id);
    setEmails((prev) => prev.map((e) => e.id === id ? { ...e, starred: !current } : e));
  }, [supabase]);

  const filtered = useMemo(() => {
    let rows = emails;
    if (tab !== 'all') rows = rows.filter((e) => e.mailbox === tab);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter((e) =>
        [e.subject, e.snippet, e.text_body, e.from_address, e.from_name]
          .some((f) => f?.toLowerCase().includes(q))
      );
    }
    return rows;
  }, [emails, tab, search]);

  const selected = emails.find((e) => e.id === selectedId) ?? null;

  const unreadCount = useMemo(
    () => emails.filter((e) => !e.is_read).length,
    [emails]
  );

  const handleSelect = (email: PlatformEmail) => {
    setSelectedId(email.id);
    if (!email.is_read) markRead(email.id);
  };

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col gap-3 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Inbox className="size-5 text-accent" />
            Office Inboxes
            {unreadCount > 0 && (
              <Badge variant="destructive" className="text-xs">{unreadCount}</Badge>
            )}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Internal platform mailboxes — admin only.
          </p>
        </div>
        <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          Refresh
        </Button>
        <Button
          size="sm"
          onClick={() => {
            const presetFrom = (tab !== 'all' ? tab : SEND_MAILBOXES[0].key) as Exclude<MailboxKey, 'all'>;
            setComposeDefaults({ from: presetFrom });
            setComposeOpen(true);
          }}
        >
          <PenSquare className="size-4" />
          Compose
        </Button>
      </div>
    </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border pb-2">
        {MAILBOXES.map((m) => {
          const count = m.key === 'all'
            ? emails.filter((e) => !e.is_read).length
            : emails.filter((e) => e.mailbox === m.key && !e.is_read).length;
          return (
            <button
              key={m.key}
              onClick={() => { setTab(m.key); setSelectedId(null); }}
              className={cn(
                'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                tab === m.key
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              )}
            >
              {m.label}
              {count > 0 && (
                <span className="ml-1.5 rounded-full bg-destructive/20 text-destructive px-1.5 py-0.5 text-xs">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Body */}
      <div className="flex flex-1 gap-3 overflow-hidden">
        {/* List panel */}
        <div className="flex w-80 shrink-0 flex-col gap-2 overflow-hidden">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search subject, sender…"
            className="h-8 text-sm"
          />
          <div className="flex-1 overflow-y-auto rounded-lg border border-border">
            {loading && filtered.length === 0 ? (
              <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">No emails.</div>
            ) : (
              <ul className="divide-y divide-border">
                {filtered.map((email) => (
                  <li
                    key={email.id}
                    onClick={() => handleSelect(email)}
                    className={cn(
                      'cursor-pointer px-3 py-2.5 transition-colors hover:bg-muted/50',
                      selectedId === email.id && 'bg-muted',
                      !email.is_read && 'bg-accent/5'
                    )}
                  >
                    <div className="flex items-start justify-between gap-1.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        {email.is_read
                          ? <MailOpen className="size-3.5 shrink-0 text-muted-foreground" />
                          : <Mail className="size-3.5 shrink-0 text-accent" />
                        }
                        <span className={cn('text-xs font-medium truncate', !email.is_read && 'text-foreground font-semibold')}>
                          {email.from_name || email.from_address || '(no sender)'}
                        </span>
                      </div>
                      <span className="text-[10px] text-muted-foreground shrink-0 mt-0.5">
                        {formatDateTime(email.received_at)}
                      </span>
                    </div>
                    <p className={cn('text-xs truncate mt-0.5', !email.is_read ? 'text-foreground' : 'text-muted-foreground')}>
                      {email.subject || '(no subject)'}
                    </p>
                    {email.snippet && (
                      <p className="text-[11px] text-muted-foreground truncate mt-0.5">{email.snippet}</p>
                    )}
                    <div className="flex items-center justify-between mt-1">
                      <span className={cn('text-[10px] font-medium', mailboxColor(email.mailbox))}>
                        {mailboxLabel(email.mailbox)}
                      </span>
                      {email.starred && <Star className="size-3 fill-amber-400 text-amber-400" />}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Detail panel */}
        <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
          {selected ? (
            <>
              {/* Detail header */}
              <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
                <div className="min-w-0">
                  <h2 className="font-semibold text-sm leading-snug truncate">
                    {selected.subject || '(no subject)'}
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    From{' '}
                    <span className="text-foreground">
                      {selected.from_name
                        ? `${selected.from_name} <${selected.from_address}>`
                        : (selected.from_address || '(unknown)')}
                    </span>
                    {' · '}
                    To <span className={cn('font-medium', mailboxColor(selected.mailbox))}>{selected.mailbox}</span>
                    {' · '}
                    {formatDateTime(selected.received_at)}
                  </p>
                  {selected.reply_to && selected.reply_to !== selected.from_address && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Reply-To: {selected.reply_to}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => toggleStar(selected.id, selected.starred)}
                    title={selected.starred ? 'Unstar' : 'Star'}
                  >
                    <Star className={cn('size-4', selected.starred && 'fill-amber-400 text-amber-400')} />
                  </Button>
                  {selected.reply_to || selected.from_address ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="Reply"
                      onClick={() => {
                        const addr = selected.reply_to || selected.from_address || '';
                        const subj = selected.subject ? `Re: ${selected.subject}` : '';
                        const quoted = selected.text_body
                          ? '\n\n---\nOn ' + formatDateTime(selected.received_at) +
                            ', ' + (selected.from_address || 'sender') + ' wrote:\n' +
                            selected.text_body.split('\n').map((l) => '> ' + l).join('\n')
                          : '';
                        setComposeDefaults({
                          from: selected.mailbox as Exclude<MailboxKey, 'all'>,
                          to: addr,
                          subject: subj,
                          body: quoted,
                          inReplyTo: selected.message_id,
                        });
                        setComposeOpen(true);
                      }}
                    >
                      <Reply className="size-4" />
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="icon-sm" onClick={() => setSelectedId(null)}>
                    <X className="size-4" />
                  </Button>
                </div>
              </div>

              {/* Body */}
              <div className="flex-1 overflow-y-auto p-4 text-sm">
                {selected.html_body ? (
                  <iframe
                    srcDoc={selected.html_body}
                    sandbox="allow-popups"
                    className="w-full min-h-64 border-0 rounded"
                    title="Email body"
                    style={{ height: '100%', minHeight: '300px' }}
                  />
                ) : selected.text_body ? (
                  <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground">
                    {selected.text_body}
                  </pre>
                ) : (
                  <p className="text-muted-foreground italic">No body content.</p>
                )}
              </div>

              {/* Links extracted from plain text */}
              {(() => {
                const links = extractLinks(selected.text_body);
                if (!links.length) return null;
                return (
                  <div className="border-t border-border px-4 py-2">
                    <p className="text-xs font-medium text-muted-foreground mb-1.5">Links</p>
                    <div className="flex flex-wrap gap-1.5">
                      {links.slice(0, 8).map((url) => (
                        <div key={url} className="flex items-center gap-1">
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-accent hover:underline flex items-center gap-0.5 max-w-xs truncate"
                          >
                            <ExternalLink className="size-3 shrink-0" />
                            {url.length > 55 ? url.slice(0, 55) + '…' : url}
                          </a>
                          <button onClick={() => copy(url)} className="text-muted-foreground hover:text-foreground">
                            <Copy className="size-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
              <Inbox className="size-10 opacity-20" />
              <p className="text-sm">Select an email to read it</p>
            </div>
          )}
        </div>
      </div>

      {composeOpen && (
        <ComposeModal
          defaultFrom={composeDefaults.from}
          defaultTo={composeDefaults.to}
          defaultSubject={composeDefaults.subject}
          defaultBody={composeDefaults.body}
          inReplyTo={composeDefaults.inReplyTo}
          onClose={() => setComposeOpen(false)}
          onSent={() => load()}
        />
      )}
    </div>
  );
}

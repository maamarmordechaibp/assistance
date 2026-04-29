"use client";
import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { edgeFn } from '@/lib/supabase/edge';
const supabase = createClient();

const RAW_SMS_NUMBER = process.env.NEXT_PUBLIC_SMS_RECEIVE_NUMBER ?? '+18459357587';
const DISPLAY_SMS_NUMBER = RAW_SMS_NUMBER.replace(/\+1(\d{3})(\d{3})(\d{4})/, '+1 ($1) $2-$3');

interface SmsRow {
  id: string;
  from_number: string;
  to_number: string;
  body: string;
  detected_otp: string | null;
  customer_id: string | null;
  call_id: string | null;
  rep_id: string | null;
  received_at: string;
  is_read: boolean;
  read_at: string | null;
  read_by_rep_id: string | null;
}

export default function RepSmsPage() {
  const [rows, setRows] = useState<SmsRow[]>([]);
  const [loading, setLoading] = useState(true);

  // compose state
  const [composeTo, setComposeTo] = useState('');
  const [composeMsg, setComposeMsg] = useState('');
  const [composeMedia, setComposeMedia] = useState('');
  const [showMedia, setShowMedia] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendSuccess, setSendSuccess] = useState<string | null>(null);
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function sendSms() {
    setSendError(null);
    setSendSuccess(null);
    if (!composeTo.trim() || !composeMsg.trim()) {
      setSendError('Phone number and message are required.');
      return;
    }
    setSending(true);
    try {
      const res = await edgeFn('sms-send', {
        method: 'POST',
        body: JSON.stringify({ to: composeTo.trim(), message: composeMsg.trim(), mediaUrl: composeMedia.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.detail || 'Send failed');
      setComposeMsg('');
      setComposeMedia('');
      setSendSuccess(`Sent to ${data.to}`);
      if (successTimer.current) clearTimeout(successTimer.current);
      successTimer.current = setTimeout(() => setSendSuccess(null), 4000);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    let sub: ReturnType<typeof supabase['channel']> | undefined;
    async function load() {
      setLoading(true);
      const { data } = await supabase
        .from('sms_inbound')
        .select('*')
        .order('received_at', { ascending: false })
        .limit(40);
      setRows(data || []);
      setLoading(false);
      sub = supabase
        .channel('rep_sms_inbound')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'sms_inbound' }, () => { load(); })
        .subscribe();
    }
    load();
    return () => { if (sub) supabase.removeChannel(sub); };
  }, []);

  return (
    <div className="max-w-3xl mx-auto py-8 space-y-6">
      <h1 className="text-2xl font-bold">SMS</h1>

      {/* Company SMS number banner */}
      <div className="p-4 rounded-xl bg-accent/10 border border-accent/30 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide font-semibold mb-0.5">
            Company SMS Number — give this to the customer
          </p>
          <p className="text-2xl font-mono font-bold tracking-widest">{DISPLAY_SMS_NUMBER}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            All texts sent to this number appear below. OTP codes are highlighted for quick copy.
          </p>
        </div>
        <button
          onClick={() => navigator.clipboard.writeText(RAW_SMS_NUMBER)}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-accent text-accent-foreground hover:bg-accent/80 self-start sm:self-center"
        >
          Copy number
        </button>
      </div>

      {/* Compose / Send SMS */}
      <div className="rounded-xl border bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Send SMS</h2>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="tel"
            placeholder="To: +1 (555) 000-0000"
            value={composeTo}
            onChange={e => setComposeTo(e.target.value)}
            className="flex-1 px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <textarea
          placeholder="Message…"
          value={composeMsg}
          onChange={e => setComposeMsg(e.target.value)}
          rows={3}
          className="w-full px-3 py-2 rounded-lg border bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setShowMedia(v => !v)}
            className="text-xs text-accent underline"
          >
            {showMedia ? 'Remove image (MMS)' : '+ Attach image URL (MMS)'}
          </button>
        </div>
        {showMedia && (
          <input
            type="url"
            placeholder="https://… (publicly accessible image URL)"
            value={composeMedia}
            onChange={e => setComposeMedia(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        )}
        {sendError && <p className="text-sm text-destructive">{sendError}</p>}
        {sendSuccess && <p className="text-sm text-green-600 dark:text-green-400">{sendSuccess}</p>}
        <button
          onClick={sendSms}
          disabled={sending}
          className="px-5 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-medium hover:bg-accent/80 disabled:opacity-50"
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>

      {/* Inbox */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Inbox</h2>
        {loading ? (
          <div className="text-muted-foreground py-8 text-center">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-muted-foreground py-8 text-center text-sm">
            No SMS messages received yet. Ask the customer to text the number above.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {rows.map(row => (
            <div
              key={row.id}
              className={`rounded-xl border p-4 flex flex-col gap-1 ${row.detected_otp ? 'border-accent/50 bg-accent/5' : 'border-border bg-card'}`}
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="font-mono text-sm font-semibold">{row.from_number}</span>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {new Date(row.received_at).toLocaleString()}
                </span>
              </div>
              <p className="text-sm whitespace-pre-wrap break-words">{row.body}</p>
              {row.detected_otp && (
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">OTP detected:</span>
                  <button
                    className="px-3 py-1 rounded bg-accent text-accent-foreground hover:bg-accent/80 font-mono font-bold text-sm"
                    onClick={() => navigator.clipboard.writeText(row.detected_otp!)}
                  >
                    {row.detected_otp}
                  </button>
                  <span className="text-xs text-muted-foreground">(click to copy)</span>
                </div>
              )}
            </div>
          ))}
          </div>
        )}
      </div>
    </div>
  );
}


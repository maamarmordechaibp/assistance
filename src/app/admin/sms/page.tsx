"use client";
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
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

export default function AdminSmsPage() {
  const [rows, setRows] = useState<SmsRow[]>([]);
  const [loading, setLoading] = useState(true);

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
        .channel('admin_sms_inbound')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'sms_inbound' }, () => { load(); })
        .subscribe();
    }
    load();
    return () => { if (sub) supabase.removeChannel(sub); };
  }, []);

  return (
    <div className="max-w-3xl mx-auto py-8">
      <h1 className="text-2xl font-bold mb-4">SMS OTP Inbox</h1>

      {/* Company SMS number banner */}
      <div className="mb-6 p-4 rounded-xl bg-accent/10 border border-accent/30 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide font-semibold mb-0.5">
            Company SMS Number
          </p>
          <p className="text-2xl font-mono font-bold tracking-widest">{DISPLAY_SMS_NUMBER}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Inbound SMS from customers — OTPs detected automatically
          </p>
        </div>
        <button
          onClick={() => navigator.clipboard.writeText(RAW_SMS_NUMBER)}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-accent text-accent-foreground hover:bg-accent/80 self-start sm:self-center"
        >
          Copy number
        </button>
      </div>

      {loading ? (
        <div className="text-muted-foreground py-8 text-center">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-muted-foreground py-8 text-center text-sm">
          No SMS messages received yet.
        </div>
      ) : (
        <table className="w-full text-sm border rounded-lg overflow-hidden">
          <thead>
            <tr className="bg-muted text-left">
              <th className="p-2">Received</th>
              <th className="p-2">From</th>
              <th className="p-2">To</th>
              <th className="p-2">OTP</th>
              <th className="p-2">Message</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.id} className={row.detected_otp ? 'bg-success/10' : ''}>
                <td className="p-2 whitespace-nowrap text-xs text-muted-foreground">
                  {new Date(row.received_at).toLocaleString()}
                </td>
                <td className="p-2">{row.from_number}</td>
                <td className="p-2 text-xs text-muted-foreground">{row.to_number}</td>
                <td className="p-2 font-mono">
                  {row.detected_otp ? (
                    <button
                      className="px-2 py-1 rounded bg-accent text-accent-foreground hover:bg-accent/80 font-bold"
                      onClick={() => navigator.clipboard.writeText(row.detected_otp!)}
                    >
                      {row.detected_otp}
                    </button>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="p-2 max-w-xs truncate" title={row.body}>{row.body}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}


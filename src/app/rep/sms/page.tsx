"use client";
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
const supabase = createClient();

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

  useEffect(() => {
    let sub: ReturnType<typeof supabase['channel']> | undefined;
    async function load() {
      setLoading(true);
      const { data } = await supabase.from('sms_inbound').select('*').order('received_at', { ascending: false }).limit(40);
      setRows(data || []);
      setLoading(false);
      sub = supabase
        .channel('sms_inbound')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'sms_inbound' }, payload => {
          load();
        })
        .subscribe();
    }
    load();
    return () => { if (sub) supabase.removeChannel(sub); };
  }, []);

  return (
    <div className="max-w-3xl mx-auto py-8">
      <h1 className="text-2xl font-bold mb-6">Your SMS OTPs</h1>
      {loading ? <div>Loading...</div> : (
        <table className="w-full text-sm border">
          <thead>
            <tr className="bg-muted">
              <th className="p-2">Received</th>
              <th className="p-2">From</th>
              <th className="p-2">To (Company #)</th>
              <th className="p-2">OTP</th>
              <th className="p-2">Body</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.id} className={row.detected_otp ? 'bg-success/10' : ''}>
                <td className="p-2 whitespace-nowrap">{new Date(row.received_at).toLocaleString()}</td>
                <td className="p-2">{row.from_number}</td>
                <td className="p-2">{row.to_number}</td>
                <td className="p-2 font-mono">
                  {row.detected_otp ? (
                    <button className="px-2 py-1 rounded bg-accent text-accent-foreground hover:bg-accent/80" onClick={() => navigator.clipboard.writeText(row.detected_otp!)}>
                      {row.detected_otp}
                    </button>
                  ) : <span className="text-muted-foreground">—</span>}
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

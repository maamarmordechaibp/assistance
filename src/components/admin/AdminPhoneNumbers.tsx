'use client';

import { useEffect, useState } from 'react';
import { Phone, Plus, Trash2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { edgeFn } from '@/lib/supabase/edge';
import { Button } from '@/components/ui/button';

const E164 = /^\+[1-9]\d{6,14}$/;

export default function AdminPhoneNumbers() {
  const [numbers, setNumbers] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await edgeFn('settings');
      if (res.ok) {
        const data = await res.json();
        const setting = (data.settings || []).find((s: { key: string; value: unknown }) => s.key === 'admin_phone_numbers');
        if (setting) {
          const v = setting.value;
          setNumbers(Array.isArray(v) ? v as string[] : []);
        }
      }
      setLoading(false);
    })();
  }, []);

  const persist = async (next: string[]) => {
    setSaving(true);
    const res = await edgeFn('settings', {
      method: 'PATCH',
      body: JSON.stringify({ key: 'admin_phone_numbers', value: next }),
    });
    setSaving(false);
    if (res.ok) {
      setNumbers(next);
      toast.success('Admin phone list updated');
    } else {
      toast.error('Failed to save');
    }
  };

  const addNumber = async () => {
    const v = input.trim();
    if (!E164.test(v)) {
      toast.error('Enter an E.164 number, e.g. +15551234567');
      return;
    }
    if (numbers.includes(v)) {
      toast.error('Number already in list');
      return;
    }
    setInput('');
    await persist([...numbers, v]);
  };

  const removeNumber = async (n: string) => {
    await persist(numbers.filter((x) => x !== n));
  };

  return (
    <div className="rounded-xl border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <Phone className="h-4 w-4 text-accent" />
          <h3 className="font-semibold">Admin phone numbers</h3>
        </div>
        <span className="text-xs text-muted-foreground">Called in order on critical alerts</span>
      </div>
      <div className="space-y-3 px-6 py-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            {numbers.length === 0 ? (
              <div className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
                No numbers configured. Critical alerts will only show in the bell — no phone calls will be placed.
              </div>
            ) : (
              <ul className="space-y-2">
                {numbers.map((n, i) => (
                  <li key={n} className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-sm">
                    <span className="font-mono">
                      <span className="mr-2 text-xs text-muted-foreground">{i + 1}.</span>
                      {n}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeNumber(n)}
                      disabled={saving}
                      className="text-rose-500 hover:text-rose-600 disabled:opacity-50"
                      aria-label={`Remove ${n}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2 pt-2">
              <input
                type="tel"
                placeholder="+15551234567"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addNumber(); }}
                className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <Button onClick={addNumber} disabled={saving} size="sm">
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                Add
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Use E.164 format: <code className="font-mono">+</code> country code, then number. Numbers are tried in order — the first to answer wins. Subject to <code className="font-mono">admin_phone_alert_throttle_seconds</code> to avoid duplicate pages.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

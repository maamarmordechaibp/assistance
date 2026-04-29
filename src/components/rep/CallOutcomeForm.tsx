'use client';

// CallOutcomeForm
// ---------------------------------------------------------------------------
// Modal post-call questionnaire. Opens when the rep's status flips to
// 'wrap_up'. Soft 60s grace period — when the timer hits 0 we still allow
// the rep to keep editing, but rep-monitor will have auto-submitted a blank
// outcome on the server and reset their status to 'available'.
//
// Submitting before the timer fires sends the form via the call-outcome edge
// function, which sets reps.status='available' so the next call can ring.

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';
import { edgeFn } from '@/lib/supabase/edge';
import { ClipboardCheck } from 'lucide-react';

interface Props {
  callId: string;
  graceSeconds: number;
  onSubmitted: () => void;
}

interface TaskCategory { id: string; name: string }

type Resolved = 'yes' | 'no' | 'partial' | '';

export function CallOutcomeForm({ callId, graceSeconds, onSubmitted }: Props) {
  const supabase = React.useMemo(() => createClient(), []);
  const [categories, setCategories] = React.useState<TaskCategory[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [openedAt] = React.useState<number>(() => Date.now());
  const [now, setNow] = React.useState(Date.now());

  const [resolved, setResolved] = React.useState<Resolved>('');
  const [taskCategoryId, setTaskCategoryId] = React.useState('');
  const [orderPlaced, setOrderPlaced] = React.useState(false);
  const [orderId, setOrderId] = React.useState('');
  const [paymentTaken, setPaymentTaken] = React.useState(false);
  const [paymentAmount, setPaymentAmount] = React.useState('');
  const [callbackNeeded, setCallbackNeeded] = React.useState(false);
  const [callbackAt, setCallbackAt] = React.useState('');
  const [notes, setNotes] = React.useState('');

  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  React.useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('task_categories')
        .select('id, name')
        .order('sort_order', { ascending: true });
      if (data) setCategories(data as TaskCategory[]);
    })();
  }, [supabase]);

  const remainingMs = Math.max(0, openedAt + graceSeconds * 1000 - now);
  const remainingSecs = Math.ceil(remainingMs / 1000);
  const expired = remainingMs <= 0;

  const submit = React.useCallback(async () => {
    setSubmitting(true);
    try {
      const payload = {
        call_id: callId,
        resolved: resolved || null,
        task_category_id: taskCategoryId || null,
        order_placed: orderPlaced,
        order_id: orderId || null,
        payment_taken: paymentTaken,
        payment_amount_cents: paymentTaken && paymentAmount
          ? Math.round(Number(paymentAmount) * 100)
          : null,
        callback_needed: callbackNeeded,
        callback_at: callbackNeeded && callbackAt
          ? new Date(callbackAt).toISOString()
          : null,
        notes: notes || null,
      };
      const res = await edgeFn('call-outcome', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.text();
        console.error('[CallOutcomeForm] submit failed', err);
        alert('Failed to submit: ' + err);
        return;
      }
      onSubmitted();
    } finally {
      setSubmitting(false);
    }
  }, [callId, resolved, taskCategoryId, orderPlaced, orderId, paymentTaken, paymentAmount, callbackNeeded, callbackAt, notes, onSubmitted]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="outcome-title"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border border-border bg-background p-6 shadow-2xl">
        <div className="mb-4 flex items-start gap-3">
          <ClipboardCheck className="mt-0.5 size-5 text-amber-500" aria-hidden="true" />
          <div className="flex-1">
            <h2 id="outcome-title" className="text-base font-semibold">
              Wrap up the call
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {expired
                ? 'Grace expired — the system has marked the queue as ready, but please still record what happened.'
                : `You have ${remainingSecs}s before the next call can ring you.`}
            </p>
          </div>
        </div>

        <div className="space-y-4">
          {/* Resolved */}
          <div>
            <Label className="mb-1 block">Was the request resolved?</Label>
            <div className="flex gap-2">
              {(['yes', 'partial', 'no'] as const).map((v) => (
                <Button
                  key={v}
                  type="button"
                  variant={resolved === v ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setResolved(v)}
                >
                  {v === 'yes' ? 'Yes' : v === 'no' ? 'No' : 'Partial'}
                </Button>
              ))}
            </div>
          </div>

          {/* Category */}
          <div>
            <Label htmlFor="outcome-cat" className="mb-1 block">Reason for call</Label>
            <select
              id="outcome-cat"
              value={taskCategoryId}
              onChange={(e) => setTaskCategoryId(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Select a category…</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Order */}
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={orderPlaced}
                onChange={(e) => setOrderPlaced(e.target.checked)}
              />
              Order placed
            </label>
            {orderPlaced && (
              <Input
                className="mt-2"
                placeholder="Order # / reference"
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
              />
            )}
          </div>

          {/* Payment */}
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={paymentTaken}
                onChange={(e) => setPaymentTaken(e.target.checked)}
              />
              Payment taken
            </label>
            {paymentTaken && (
              <Input
                type="number"
                step="0.01"
                min="0"
                className="mt-2"
                placeholder="Amount in dollars"
                value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)}
              />
            )}
          </div>

          {/* Callback */}
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={callbackNeeded}
                onChange={(e) => setCallbackNeeded(e.target.checked)}
              />
              Callback needed
            </label>
            {callbackNeeded && (
              <Input
                type="datetime-local"
                className="mt-2"
                value={callbackAt}
                onChange={(e) => setCallbackAt(e.target.value)}
              />
            )}
          </div>

          {/* Notes */}
          <div>
            <Label htmlFor="outcome-notes" className="mb-1 block">Notes</Label>
            <textarea
              id="outcome-notes"
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="What happened on the call?"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between">
          <span className={`text-xs ${expired ? 'text-muted-foreground' : 'font-mono text-amber-600 dark:text-amber-400'}`}>
            {expired ? 'queue resumed' : `${remainingSecs}s left`}
          </span>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? 'Saving…' : 'Submit'}
          </Button>
        </div>
      </div>
    </div>
  );
}

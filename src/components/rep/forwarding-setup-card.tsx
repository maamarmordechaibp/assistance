'use client';

// Phase 2: helps a rep walk a customer through Gmail forwarding setup.
//
// Flow:
//   1. Rep captures the customer's *personal* email (the Gmail account where
//      their Amazon/Walmart/etc. confirmations actually arrive).
//   2. Rep sends the customer the forwarding instructions (or reads them
//      aloud) — Gmail makes the customer add a forwarding address, click a
//      verification link Gmail emails to it, and create a filter that
//      forwards merchant emails to the customer's `assigned_email` mailbox.
//   3. Once the first merchant email lands at the assigned mailbox, the
//      `email-inbound` ingest helper auto-stamps `forwarding_verified_at`.
//
// This card is intentionally read-mostly — it shows progress + a small
// edit field for the personal email. Heavy operations live server-side.

import { useState } from 'react';
import { toast } from 'sonner';
import { Mail, Copy, CheckCircle2, Clock, ChevronDown, ChevronRight } from 'lucide-react';
import { edgeFn } from '@/lib/supabase/edge';
import { formatDateTime } from '@/lib/utils';

interface Props {
  customerId: string;
  assignedEmail: string | null;
  personalEmail: string | null;
  forwardingVerifiedAt: string | null;
  onUpdate?: (next: { personal_email: string | null }) => void;
  /** Compact = no instructions block by default; rep can expand. */
  compact?: boolean;
}

export default function ForwardingSetupCard({
  customerId,
  assignedEmail,
  personalEmail,
  forwardingVerifiedAt,
  onUpdate,
  compact = true,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(personalEmail ?? '');
  const [saving, setSaving] = useState(false);
  const [showSteps, setShowSteps] = useState(!compact);

  const verified = !!forwardingVerifiedAt;

  const save = async () => {
    const trimmed = draft.trim();
    if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      toast.error('Enter a valid email address');
      return;
    }
    setSaving(true);
    try {
      const res = await edgeFn('customers', {
        method: 'PATCH',
        body: JSON.stringify({ id: customerId, personalEmail: trimmed || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body?.error || 'Failed to save');
        return;
      }
      const data = await res.json();
      onUpdate?.({ personal_email: data.personal_email ?? trimmed ?? null });
      setEditing(false);
      toast.success('Saved');
    } finally {
      setSaving(false);
    }
  };

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied ${label}`);
    } catch {
      toast.error('Copy failed');
    }
  };

  return (
    <div className="bg-card rounded-xl shadow-sm border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
          <Mail className="w-4 h-4" />
          Email forwarding
        </h3>
        {verified ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="w-3 h-3" />
            Verified {formatDateTime(forwardingVerifiedAt!)}
          </span>
        ) : personalEmail ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
            <Clock className="w-3 h-3" />
            Awaiting first merchant email
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            Not set up
          </span>
        )}
      </div>

      {/* Assigned mailbox (read-only) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Assigned mailbox</p>
          {assignedEmail ? (
            <button
              type="button"
              onClick={() => copy(assignedEmail, 'assigned mailbox')}
              className="mt-0.5 inline-flex items-center gap-1.5 font-mono text-xs hover:underline"
            >
              {assignedEmail}
              <Copy className="w-3 h-3 text-muted-foreground" />
            </button>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground italic">
              No mailbox issued yet — reload after assignment.
            </p>
          )}
        </div>

        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Customer&apos;s personal email</p>
          {editing ? (
            <div className="mt-0.5 flex items-center gap-1">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="customer@gmail.com"
                className="flex-1 rounded border bg-background px-2 py-1 font-mono text-xs"
                autoFocus
              />
              <button
                onClick={save}
                disabled={saving}
                className="rounded bg-accent px-2 py-1 text-xs font-medium text-accent-foreground disabled:opacity-50"
              >
                {saving ? 'Saving' : 'Save'}
              </button>
              <button
                onClick={() => { setDraft(personalEmail ?? ''); setEditing(false); }}
                className="rounded border px-2 py-1 text-xs"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="mt-0.5 inline-flex items-center gap-1.5 font-mono text-xs hover:underline"
            >
              {personalEmail || <span className="italic text-muted-foreground">Click to add…</span>}
            </button>
          )}
        </div>
      </div>

      {/* Steps */}
      {assignedEmail && (
        <div className="border-t pt-2">
          <button
            type="button"
            onClick={() => setShowSteps((s) => !s)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {showSteps ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            Gmail forwarding setup steps
          </button>

          {showSteps && (
            <ol className="mt-2 space-y-2 text-xs text-foreground">
              <li>
                <span className="font-medium">1.</span> In the customer&apos;s Gmail, open
                <span className="mx-1 font-mono text-[11px]">Settings → See all settings → Forwarding and POP/IMAP</span>
                and click <span className="font-medium">Add a forwarding address</span>.
              </li>
              <li>
                <span className="font-medium">2.</span> Paste their assigned mailbox:
                <button
                  onClick={() => copy(assignedEmail, 'assigned mailbox')}
                  className="ml-1 inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted/80"
                >
                  {assignedEmail} <Copy className="w-3 h-3" />
                </button>
              </li>
              <li>
                <span className="font-medium">3.</span> Gmail will send a confirmation code to that address.
                Find it in <a href="/admin/emails" className="text-accent underline">/admin/emails</a> (or
                the rep&apos;s email panel) and paste it back into Gmail.
              </li>
              <li>
                <span className="font-medium">4.</span> Create a filter:
                <span className="mx-1 font-mono text-[11px]">From: amazon.com OR walmart.com OR target.com OR usps.com OR ups.com OR fedex.com</span>
                → <span className="font-medium">Forward to</span> the assigned mailbox →
                <span className="mx-1">Apply.</span>
              </li>
              <li>
                <span className="font-medium">5.</span> The next time the customer receives a real merchant
                email, this card will flip to <span className="text-emerald-600 dark:text-emerald-400">Verified</span> automatically.
              </li>
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

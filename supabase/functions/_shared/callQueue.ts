// Shared helper: insert a call_queue row and return the <Enqueue> LaML element.
// Used by sw-inbound and sw-preferred-rep to route callers into per-rep or
// general queues that rep browsers pick up via Supabase Realtime.
import { createServiceClient } from './supabase.ts';
import * as laml from './laml.ts';

interface EnqueueParams {
  callSid: string;
  from: string;
  callerName?: string | null;
  customerId?: string | null;
  /** If set, only this rep will see the ring in their browser. */
  targetRepId?: string | null;
  /** Base URL for function callbacks (typically `${SUPABASE_URL}/functions/v1`). */
  baseUrl: string;
  /** Optional override for the sort key used by the rep softphone. When a
   *  returning callback caller re-enters the queue we set this to the
   *  ORIGINAL enqueued_at of their previous call so they don't lose their
   *  place behind newer arrivals. Defaults to now() (i.e. back-of-line). */
  priorityAt?: string | null;
}

/** Insert a waiting row in call_queue and return the <Enqueue> LaML string.
 *  The queue name is `rep_<uuid>` when targeted, else `general`. */
export async function enqueueCaller(p: EnqueueParams): Promise<string> {
  const supabase = createServiceClient();
  const queueName = p.targetRepId ? `rep_${p.targetRepId}` : 'general';

  // ── Restore queue position for returning callback callers ─────────────
  // If this caller previously chose "callback" and we never reached them
  // (status still 'pending' with an original_enqueued_at), re-use that
  // earlier timestamp as the sort key so they don't lose their place
  // behind callers who arrived after them.
  let priorityAt = p.priorityAt ?? null;
  if (!priorityAt && p.from) {
    const { data: pendingCb } = await supabase
      .from('callback_requests')
      .select('id, original_enqueued_at')
      .eq('phone_number', p.from)
      .eq('status', 'pending')
      .not('original_enqueued_at', 'is', null)
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (pendingCb?.original_enqueued_at) {
      priorityAt = pendingCb.original_enqueued_at as string;
      // Mark the callback consumed so we don't repeatedly bump them on
      // every subsequent re-enqueue inside the same call.
      await supabase
        .from('callback_requests')
        .update({ status: 'called_back', called_back_at: new Date().toISOString() })
        .eq('id', pendingCb.id);
      console.log(`[call_queue] restoring priority_at=${priorityAt} for callback caller ${p.from}`);
    }
  }

  const insertRow: Record<string, unknown> = {
    call_sid: p.callSid,
    from_number: p.from,
    caller_name: p.callerName ?? null,
    customer_id: p.customerId ?? null,
    queue_name: queueName,
    target_rep_id: p.targetRepId ?? null,
  };
  if (priorityAt) insertRow.priority_at = priorityAt;
  const { data, error } = await supabase
    .from('call_queue')
    .insert(insertRow)
    .select('id')
    .single();
  if (error) {
    console.error(`[call_queue] insert failed: ${error.message}`, error);
  } else {
    console.log(`[call_queue] inserted id=${data?.id} queue=${queueName} target=${p.targetRepId ?? 'any'} from=${p.from}`);
  }
  const queueId = data?.id ?? '';
  return laml.enqueue(queueName, {
    waitUrl: `${p.baseUrl}/sw-queue-wait`,
    action: `${p.baseUrl}/sw-inbound?step=queue-exit&queueId=${queueId}`,
  });
}

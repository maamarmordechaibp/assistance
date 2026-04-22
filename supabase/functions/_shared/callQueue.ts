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
}

/** Insert a waiting row in call_queue and return the <Enqueue> LaML string.
 *  The queue name is `rep_<uuid>` when targeted, else `general`. */
export async function enqueueCaller(p: EnqueueParams): Promise<string> {
  const supabase = createServiceClient();
  const queueName = p.targetRepId ? `rep_${p.targetRepId}` : 'general';
  const { data, error } = await supabase
    .from('call_queue')
    .insert({
      call_sid: p.callSid,
      from_number: p.from,
      caller_name: p.callerName ?? null,
      customer_id: p.customerId ?? null,
      queue_name: queueName,
      target_rep_id: p.targetRepId ?? null,
    })
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

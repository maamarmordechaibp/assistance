// Edge Function: sw-preferred-rep (dial preferred or last rep, fallback to queue)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import * as laml from '../_shared/laml.ts';
import { toSwIdentity } from '../_shared/signalwire.ts';

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const customerId = url.searchParams.get('customerId');
  const step = url.searchParams.get('step') || 'dial';

  const supabase = createServiceClient();
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const baseUrl = `${supabaseUrl}/functions/v1`;

  const elements: string[] = [];

  if (!customerId) {
    elements.push(laml.say('Unable to determine your account. Connecting you to a representative.'));
    elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  const formData = step === 'fallback' ? null : await req.formData();
  const from = formData?.get('From') as string | null;

  if (step === 'dial') {
    // Find the preferred rep or last rep for this customer
    const { data: customer } = await supabase
      .from('customers')
      .select('preferred_rep_id')
      .eq('id', customerId)
      .single();

    let repId = customer?.preferred_rep_id;

    // If no explicit preferred rep, find the last rep they spoke with
    if (!repId) {
      const { data: lastCall } = await supabase
        .from('calls')
        .select('rep_id')
        .eq('customer_id', customerId)
        .not('rep_id', 'is', null)
        .order('started_at', { ascending: false })
        .limit(1)
        .single();
      repId = lastCall?.rep_id;
    }

    if (!repId) {
      elements.push(laml.say('We do not have a previous representative on file for you. Connecting you to the next available representative.'));
      elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }

    // Look up the rep to get their identity and availability
    const { data: rep } = await supabase
      .from('reps')
      .select('id, full_name, email, status')
      .eq('id', repId)
      .single();

    if (!rep || rep.status !== 'available') {
      const name = rep?.full_name || 'Your preferred representative';
      elements.push(laml.say(`${name} is not available right now. Connecting you to the next available representative.`));
      elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }

    // Dial the rep's WebRTC client (identity = sanitized email, matching the JWT resource)
    elements.push(laml.say(`Connecting you to ${rep.full_name}. Please hold.`));
    elements.push(laml.dialClient(toSwIdentity(rep.email), {
      record: true,
      timeLimit: 3600,
      timeout: 30,
      callerId: from || undefined,
      action: `${baseUrl}/sw-preferred-rep?step=fallback&customerId=${customerId}`,
    }));

    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Fallback: rep didn't answer or call ended ──
  if (step === 'fallback') {
    const fallbackData = await req.formData();
    const dialCallStatus = fallbackData.get('DialCallStatus') as string | null;

    if (dialCallStatus === 'completed') {
      // Call was completed normally — end
      elements.push(laml.hangup());
    } else {
      // Rep didn't answer — fall back to queue
      elements.push(laml.say('Your representative did not answer. Connecting you to the next available representative.'));
      elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
    }

    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // Default fallback
  elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
  return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
});

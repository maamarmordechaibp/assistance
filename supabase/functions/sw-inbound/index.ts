// Edge Function: sw-inbound (SignalWire inbound call webhook)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import * as laml from '../_shared/laml.ts';
import { formatMinuteAnnouncement } from '../_shared/utils.ts';
import { toSwIdentity } from '../_shared/signalwire.ts';

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const formData = await req.formData();
  const from = formData.get('From') as string;
  const callSid = formData.get('CallSid') as string;
  const digits = formData.get('Digits') as string | null;

  // Log all form params for debugging
  const allParams: Record<string, string> = {};
  formData.forEach((v, k) => { allParams[k] = String(v); });
  console.log('[sw-inbound] params:', JSON.stringify(allParams));

  const supabase = createServiceClient();
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const baseUrl = `${supabaseUrl}/functions/v1`;

  // Parse URL params BEFORE using them
  const url = new URL(req.url);
  const step = url.searchParams.get('step');
  const customerId = url.searchParams.get('customerId');

  // Store call trace for diagnostic UI
  await supabase.from('call_traces').insert({
    call_sid: callSid,
    step: step || 'initial',
    from_number: from,
    details: allParams,
  }).then(() => {}).catch(() => {});

  // ── Menu response handler ──
  // ── Dial fallback: rep didn't answer after direct dial, fall to queue ──
  if (step === 'dial-fallback' && customerId) {
    const elements: string[] = [];
    const dialCallStatus = formData.get('DialCallStatus') as string | null;
    const dialSid = formData.get('DialCallSid') as string | null;
    const dialDuration = formData.get('DialCallDuration') as string | null;
    console.log(`[sw-inbound] dial-fallback: status=${dialCallStatus} dialSid=${dialSid} duration=${dialDuration}`);
    if (dialCallStatus === 'completed') {
      elements.push(laml.hangup());
    } else {
      console.log(`[sw-inbound] Rep did not answer (status=${dialCallStatus}). Enqueueing caller.`);
      elements.push(laml.say('The representative did not answer. Please hold while we connect you.'));
      elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
    }
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Connect to rep: find available rep and dial their browser ──
  if (step === 'connect-rep') {
    const elements: string[] = [];
    const { data: availableRep } = await supabase
      .from('reps')
      .select('id, full_name, email, status')
      .eq('status', 'available')
      .limit(1)
      .single();

    const identity = availableRep ? toSwIdentity(availableRep.email) : null;
    console.log(`[sw-inbound] connect-rep: rep=${availableRep?.full_name || 'NONE'} identity=${identity} email=${availableRep?.email}`);
    if (availableRep && identity) {
      elements.push(laml.say(`Connecting you to ${availableRep.full_name}.`));
      elements.push(laml.dialClient(identity, {
        record: true,
        timeLimit: 3600,
        timeout: 30,
        callerId: from,
        action: `${baseUrl}/sw-inbound?step=dial-fallback&customerId=${customerId || ''}`,
      }));
    } else {
      elements.push(laml.say('All representatives are currently busy. Please hold.'));
      elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
    }
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  if (step === 'menu' && customerId && digits) {
    const elements: string[] = [];

    switch (digits) {
      case '1': { // Connect to representative
        // Find an available rep and dial their browser directly
        const { data: availableRep } = await supabase
          .from('reps')
          .select('id, full_name, email, status')
          .eq('status', 'available')
          .limit(1)
          .single();

        const identity = availableRep ? toSwIdentity(availableRep.email) : null;
        console.log(`[sw-inbound] menu=1: rep=${availableRep?.full_name || 'NONE'} identity=${identity} email=${availableRep?.email}`);
        if (availableRep && identity) {
          elements.push(laml.say(`Connecting you to ${availableRep.full_name}. Please hold.`));
          elements.push(laml.dialClient(identity, {
            record: true,
            timeLimit: 3600,
            timeout: 30,
            callerId: from,
            action: `${baseUrl}/sw-inbound?step=dial-fallback&customerId=${customerId}`,
          }));
        } else {
          elements.push(laml.say('All representatives are currently busy. Please hold.'));
          elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
        }
        break;
      }

      case '2': // Buy minutes
        elements.push(laml.redirect(`${baseUrl}/sw-package-select?customerId=${customerId}`));
        break;

      case '3': // Terms & conditions
        elements.push(laml.redirect(`${baseUrl}/sw-terms?customerId=${customerId}`));
        break;

      case '4': // Account lookup from different phone
        elements.push(laml.redirect(`${baseUrl}/sw-account-lookup?customerId=${customerId}`));
        break;

      case '5': // Preferred / last representative
        elements.push(laml.redirect(`${baseUrl}/sw-preferred-rep?customerId=${customerId}`));
        break;

      default:
        // Invalid input – replay the menu
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
        break;
    }

    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Replay menu (after T&C or invalid input) ──
  if ((step === 'replay' || step === 'menu') && customerId && !digits) {
    const { data: customer } = await supabase.from('customers').select('*').eq('id', customerId).single();
    return new Response(buildMainMenu(baseUrl, customer, customerId), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Initial inbound call ──
  // Look up customer by phone number
  let { data: customer } = await supabase
    .from('customers')
    .select('*')
    .or(`primary_phone.eq.${from},secondary_phone.eq.${from}`)
    .eq('status', 'active')
    .single();

  // Auto-create customer if not found
  if (!customer) {
    const { data: newCustomer } = await supabase.from('customers').insert({
      full_name: `Caller ${from}`,
      primary_phone: from,
      status: 'active',
      current_balance_minutes: 0,
      total_minutes_purchased: 0,
      total_minutes_used: 0,
    }).select().single();
    customer = newCustomer;
  }

  // Fetch active disclosures
  const { data: disclosures } = await supabase
    .from('disclosure_prompts')
    .select('*')
    .eq('is_enabled', true)
    .eq('plays_before_routing', true)
    .order('sort_order');

  // Fetch admin settings
  const { data: settings } = await supabase
    .from('admin_settings')
    .select('key, value')
    .in('key', ['minute_announcement_enabled', 'minute_announcement_text', 'low_balance_threshold']);

  const settingsMap: Record<string, unknown> = {};
  settings?.forEach((s: { key: string; value: unknown }) => { settingsMap[s.key] = s.value; });

  const announcementEnabled = settingsMap.minute_announcement_enabled !== false;
  const announcementText = (settingsMap.minute_announcement_text as string) || 'You currently have {minutes} minutes remaining.';

  const elements: string[] = [];

  // Play disclosure prompts
  if (disclosures && disclosures.length > 0) {
    for (const disclosure of disclosures) {
      elements.push(laml.say(disclosure.prompt_text));
      elements.push(laml.pause(1));
    }
  }

  if (customer) {
    // Create call record
    await supabase.from('calls').insert({
      customer_id: customer.id,
      inbound_phone: from,
      call_sid: callSid,
      started_at: new Date().toISOString(),
    });

    // Greet by name (returning) or generic (new)
    const isNewCaller = customer.full_name.startsWith('Caller ');
    if (isNewCaller) {
      elements.push(laml.say('Welcome to CallVault.'));
    } else {
      elements.push(laml.say(`Welcome back, ${customer.full_name}.`));
    }

    if (announcementEnabled) {
      const announcement = formatMinuteAnnouncement(customer.current_balance_minutes, announcementText);
      elements.push(laml.say(announcement));
      elements.push(laml.pause(1));
    }

    // Build the main menu
    elements.push(buildMenuGather(baseUrl, customer));

    // Fallthrough: if no input, try to connect to rep directly
    elements.push(laml.say('No input received. Connecting you to a representative.'));
    elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep&customerId=${customer.id}`));
  } else {
    // Fallback if customer creation failed
    await supabase.from('calls').insert({
      inbound_phone: from,
      call_sid: callSid,
      started_at: new Date().toISOString(),
    });

    elements.push(laml.say('Welcome to CallVault. We are connecting you to a representative who can assist you.'));
    elements.push(laml.pause(1));
    // Try to find available rep
    const { data: fallbackRep } = await supabase
      .from('reps')
      .select('id, full_name, email, status')
      .eq('status', 'available')
      .limit(1)
      .single();

    if (fallbackRep) {
      elements.push(laml.dialClient(toSwIdentity(fallbackRep.email), {
        record: true,
        timeLimit: 3600,
        timeout: 30,
        callerId: from,
        action: `${baseUrl}/sw-inbound?step=dial-fallback&customerId=`,
      }));
    } else {
      elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
    }
  }

  const xml = laml.buildLamlResponse(elements);
  return new Response(xml, { headers: { 'Content-Type': 'application/xml' } });
});

// ── Helper: build the <Gather> for the main menu ──
function buildMenuGather(baseUrl: string, customer: { id: string; preferred_rep_id?: string | null; current_balance_minutes: number }): string {
  const lines: string[] = [];
  lines.push('Press 1 to speak with a representative.');
  lines.push('Press 2 to purchase minutes.');
  lines.push('Press 3 to hear our terms and conditions.');
  lines.push('Press 4 if you are calling from a different phone number.');

  if (customer.preferred_rep_id) {
    lines.push('Press 5 to request your preferred representative.');
  }

  return laml.gather(
    { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=menu&customerId=${customer.id}`, timeout: 10 },
    [laml.say(lines.join(' '))]
  );
}

// ── Helper: build full menu XML for replays ──
function buildMainMenu(baseUrl: string, customer: { id: string; preferred_rep_id?: string | null; current_balance_minutes: number } | null, customerId: string): string {
  const elements: string[] = [];
  if (customer) {
    elements.push(buildMenuGather(baseUrl, customer));
  } else {
    elements.push(laml.say('Connecting you to a representative.'));
  }
  elements.push(laml.say('No input received. Connecting you to a representative.'));
  elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
  return laml.buildLamlResponse(elements);
}

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
  const sipDomain = Deno.env.get('SIGNALWIRE_SPACE_URL')!;

  // Parse URL params BEFORE using them
  const url = new URL(req.url);
  const step = url.searchParams.get('step');
  const customerId = url.searchParams.get('customerId');
  const repId = url.searchParams.get('repId');

  // Store call trace for diagnostic UI
  await supabase.from('call_traces').insert({
    call_sid: callSid,
    step: step || 'initial',
    from_number: from,
    details: allParams,
  }).then(() => {}).catch(() => {});

  // ── Rep greeting: played to rep when they answer, before caller bridges in ──
  if (step === 'rep-greeting') {
    const callerPhone = url.searchParams.get('callerPhone') || from || 'Unknown';
    const callerName = url.searchParams.get('callerName') || callerPhone;
    const elements: string[] = [];
    elements.push(laml.say(`Incoming call from ${callerName}. You are now being connected.`));
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Callback answer: customer picked up outbound callback, ring specific rep ──
  if (step === 'callback-answer' && repId) {
    const callbackId = url.searchParams.get('callbackId');
    const elements: string[] = [];
    const { data: rep } = await supabase
      .from('reps')
      .select('id, full_name, email, status')
      .eq('id', repId)
      .single();

    if (rep && rep.status === 'available') {
      const identity = toSwIdentity(rep.email);
      const greetingUrl = `${baseUrl}/sw-inbound?step=rep-greeting&callerPhone=${encodeURIComponent(from)}`;
      elements.push(laml.say(`You are receiving a callback. Connecting you to ${rep.full_name} now.`));
      elements.push(laml.dialClient(identity, {
        record: true, timeLimit: 3600, timeout: 30, callerId: from,
        action: `${baseUrl}/sw-inbound?step=callback-fallback&repId=${repId}&callbackId=${callbackId || ''}`,
        sipDomain, repGreetingUrl: greetingUrl,
      }));
    } else {
      // Rep not available — connect to general queue
      elements.push(laml.say('Your callback representative is not currently available. Connecting you to the next available representative.'));
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep`));
    }
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Callback fallback: rep didn't answer the callback ──
  if (step === 'callback-fallback') {
    const callbackId = url.searchParams.get('callbackId');
    const dialCallStatus = formData.get('DialCallStatus') as string | null;
    const elements: string[] = [];
    if (dialCallStatus === 'completed') {
      // Mark callback as done
      if (callbackId) {
        const supabaseInner = createServiceClient();
        await supabaseInner.from('callback_requests').update({ status: 'called_back', called_back_at: new Date().toISOString() }).eq('id', callbackId).catch(() => {});
      }
      elements.push(laml.hangup());
    } else {
      elements.push(laml.say('Your representative did not answer. Connecting you to the next available representative.'));
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep`));
    }
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Dial fallback: rep didn't answer after direct dial, fall to queue ──
  if (step === 'dial-fallback') {
    const elements: string[] = [];
    const dialCallStatus = formData.get('DialCallStatus') as string | null;
    const dialSid = formData.get('DialCallSid') as string | null;
    const dialDuration = formData.get('DialCallDuration') as string | null;
    console.log(`[sw-inbound] dial-fallback: status=${dialCallStatus} dialSid=${dialSid} duration=${dialDuration}`);
    if (dialCallStatus === 'completed') {
      elements.push(laml.hangup());
    } else {
      console.log(`[sw-inbound] Rep did not answer (status=${dialCallStatus}). Enqueueing caller.`);
      elements.push(laml.say('The representative did not answer. Please hold while we connect you to the next available representative.'));
      elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
    }
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Extension: busy choice (hold for this rep or next available) ──
  if (step === 'ext-busy' && repId) {
    const elements: string[] = [];
    const { data: rep } = await supabase.from('reps').select('full_name').eq('id', repId).single();
    const repName = rep?.full_name || 'This representative';
    if (digits === '1') {
      elements.push(laml.say(`Please hold. You will be connected to ${repName} when they become available.`));
      elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
    } else {
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep&customerId=${customerId || ''}`));
    }
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }
  if (step === 'ext-busy' && !digits && repId) {
    const elements: string[] = [];
    const { data: rep } = await supabase.from('reps').select('full_name').eq('id', repId).single();
    const repName = rep?.full_name || 'This representative';
    elements.push(laml.gather(
      { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=ext-busy&repId=${repId}&customerId=${customerId || ''}`, timeout: 10 },
      [laml.say(`${repName} is currently on a call. Press 1 to hold and wait for them, or press 2 to connect with the next available representative.`)]
    ));
    elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep&customerId=${customerId || ''}`));
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Extension: offline callback choice (request rep callback or next available) ──
  if (step === 'ext-offline') {
    const elements: string[] = [];
    const { data: rep } = await supabase.from('reps').select('full_name').eq('id', repId || '').single();
    const repName = rep?.full_name || 'This representative';
    if (digits === '1') {
      // Record callback request for this specific rep
      const { data: customer } = customerId
        ? await supabase.from('customers').select('full_name').eq('id', customerId).single()
        : { data: null };
      await supabase.from('callback_requests').insert({
        phone_number: from,
        caller_name: customer?.full_name || from,
        rep_id: repId,
        call_sid: callSid,
        status: 'pending',
        is_general: false,
      }).catch(() => {});
      elements.push(laml.say(`Your callback request has been noted. ${repName} will call you back soon. Goodbye.`));
      elements.push(laml.hangup());
    } else if (digits === '2') {
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep&customerId=${customerId || ''}`));
    } else {
      // First prompt (no digits yet)
      elements.push(laml.gather(
        { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=ext-offline&repId=${repId}&customerId=${customerId || ''}`, timeout: 10 },
        [laml.say(`${repName} is not available right now. Press 1 to request a callback from this representative, or press 2 to connect with the next available representative.`)]
      ));
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep&customerId=${customerId || ''}`));
    }
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Extension dialing: gather extension number ──
  if (step === 'extension') {
    const elements: string[] = [];
    elements.push(laml.gather(
      { input: 'dtmf', numDigits: 3, action: `${baseUrl}/sw-inbound?step=extension-dial&customerId=${customerId || ''}`, timeout: 10, finishOnKey: '#' },
      [laml.say('Please enter the three-digit extension number, or press pound to cancel.')]
    ));
    elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId || ''}`));
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Extension dial: route to the specific rep by extension ──
  if (step === 'extension-dial' && digits) {
    const ext = parseInt(digits, 10);
    const elements: string[] = [];
    const { data: rep } = await supabase
      .from('reps')
      .select('id, full_name, email, status, ivr_extension')
      .eq('ivr_extension', ext)
      .single();

    if (!rep) {
      elements.push(laml.say(`Extension ${digits} was not found. Please try again.`));
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=extension&customerId=${customerId || ''}`));
    } else if (rep.status === 'available') {
      const identity = toSwIdentity(rep.email);
      console.log(`[sw-inbound] ext-dial: ext=${ext} rep=${rep.full_name} identity=${identity}`);
      elements.push(laml.say(`Connecting you to ${rep.full_name}. Please hold.`));
      const greetingUrl = `${baseUrl}/sw-inbound?step=rep-greeting&callerPhone=${encodeURIComponent(from)}&customerId=${customerId || ''}`;
      elements.push(laml.dialClient(identity, {
        record: true, timeLimit: 3600, timeout: 30, callerId: from,
        action: `${baseUrl}/sw-inbound?step=dial-fallback&customerId=${customerId || ''}`,
        sipDomain, repGreetingUrl: greetingUrl,
      }));
    } else if (rep.status === 'busy') {
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=ext-busy&repId=${rep.id}&customerId=${customerId || ''}`));
    } else {
      // offline
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=ext-offline&repId=${rep.id}&customerId=${customerId || ''}`));
    }
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Connect to rep: find ALL available reps and SimRing them ──
  if (step === 'connect-rep') {
    const elements: string[] = [];
    const { data: availableReps } = await supabase
      .from('reps')
      .select('id, full_name, email, status')
      .eq('status', 'available');

    console.log(`[sw-inbound] connect-rep: found ${availableReps?.length || 0} available reps`);
    if (availableReps && availableReps.length > 0) {
      elements.push(laml.say('Connecting you to the next available representative. Please hold.'));
      const greetingUrl = `${baseUrl}/sw-inbound?step=rep-greeting&callerPhone=${encodeURIComponent(from)}&customerId=${customerId || ''}`;
      elements.push(laml.dialMultipleClients(
        availableReps.map(r => ({ identity: toSwIdentity(r.email), repGreetingUrl: greetingUrl })),
        { record: true, timeLimit: 3600, timeout: 30, callerId: from,
          action: `${baseUrl}/sw-inbound?step=dial-fallback&customerId=${customerId || ''}`,
          sipDomain }
      ));
    } else {
      elements.push(laml.say('All representatives are currently busy. Please hold.'));
      elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
    }
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Menu response ──
  if (step === 'menu' && customerId && digits) {
    const elements: string[] = [];

    switch (digits) {
      case '1': { // Connect to next available rep (SimRing all available)
        const { data: availableReps } = await supabase
          .from('reps')
          .select('id, full_name, email, status')
          .eq('status', 'available');

        console.log(`[sw-inbound] menu=1: ${availableReps?.length || 0} available reps`);
        if (availableReps && availableReps.length > 0) {
          elements.push(laml.say('Connecting you to a representative. Please hold.'));
          const greetingUrl = `${baseUrl}/sw-inbound?step=rep-greeting&callerPhone=${encodeURIComponent(from)}&customerId=${customerId}`;
          elements.push(laml.dialMultipleClients(
            availableReps.map(r => ({ identity: toSwIdentity(r.email), repGreetingUrl: greetingUrl })),
            { record: true, timeLimit: 3600, timeout: 30, callerId: from,
              action: `${baseUrl}/sw-inbound?step=dial-fallback&customerId=${customerId}`,
              sipDomain }
          ));
        } else {
          elements.push(laml.say('All representatives are currently busy. Please hold.'));
          elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
        }
        break;
      }

      case '0': // Dial by extension
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=extension&customerId=${customerId}`));
        break;

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
  let { data: customer } = await supabase
    .from('customers')
    .select('*')
    .or(`primary_phone.eq.${from},secondary_phone.eq.${from}`)
    .eq('status', 'active')
    .single();

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

  const { data: disclosures } = await supabase
    .from('disclosure_prompts')
    .select('*')
    .eq('is_enabled', true)
    .eq('plays_before_routing', true)
    .order('sort_order');

  const { data: settings } = await supabase
    .from('admin_settings')
    .select('key, value')
    .in('key', ['minute_announcement_enabled', 'minute_announcement_text', 'low_balance_threshold']);

  const settingsMap: Record<string, unknown> = {};
  settings?.forEach((s: { key: string; value: unknown }) => { settingsMap[s.key] = s.value; });

  const announcementEnabled = settingsMap.minute_announcement_enabled !== false;
  const announcementText = (settingsMap.minute_announcement_text as string) || 'You currently have {minutes} minutes remaining.';

  const elements: string[] = [];

  if (disclosures && disclosures.length > 0) {
    for (const disclosure of disclosures) {
      elements.push(laml.say(disclosure.prompt_text));
      elements.push(laml.pause(1));
    }
  }

  if (customer) {
    await supabase.from('calls').insert({
      customer_id: customer.id,
      inbound_phone: from,
      call_sid: callSid,
      started_at: new Date().toISOString(),
    });

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

    elements.push(buildMenuGather(baseUrl, customer));
    elements.push(laml.say('No input received. Connecting you to a representative.'));
    elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep&customerId=${customer.id}`));
  } else {
    // Fallback if customer creation failed
    await supabase.from('calls').insert({
      inbound_phone: from,
      call_sid: callSid,
      started_at: new Date().toISOString(),
    });
    elements.push(laml.say('Welcome to CallVault. Connecting you to a representative.'));
    elements.push(laml.pause(1));
    elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep&customerId=`));
  }

  const xml = laml.buildLamlResponse(elements);
  return new Response(xml, { headers: { 'Content-Type': 'application/xml' } });
});

// ── Helper: build the <Gather> for the main menu ──
function buildMenuGather(baseUrl: string, customer: { id: string; preferred_rep_id?: string | null; current_balance_minutes: number }): string {
  const lines: string[] = [];
  lines.push('Press 1 to speak with the next available representative.');
  lines.push('Press 0 to reach a specific representative by extension.');
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
        sipDomain: Deno.env.get('SIGNALWIRE_SPACE_URL'),
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
            sipDomain: Deno.env.get('SIGNALWIRE_SPACE_URL'),
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
        sipDomain: Deno.env.get('SIGNALWIRE_SPACE_URL'),
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

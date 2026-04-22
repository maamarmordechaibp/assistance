// Edge Function: sw-inbound (SignalWire inbound call webhook)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import * as laml from '../_shared/laml.ts';
import { formatMinuteAnnouncement } from '../_shared/utils.ts';
import { enqueueCaller } from '../_shared/callQueue.ts';

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
  const repId = url.searchParams.get('repId');

  // Store call trace for diagnostic UI
  await supabase.from('call_traces').insert({
    call_sid: callSid,
    step: step || 'initial',
    from_number: from,
    details: allParams,
  }).then(() => {}).catch(() => {});

  // ── Queue exit: fires when caller leaves the SignalWire <Enqueue> either
  //    because a rep bridged to them OR because they hung up. Reconcile the
  //    call_queue row so the UI doesn't show stale rings. ──
  if (step === 'queue-exit') {
    const queueId = url.searchParams.get('queueId');
    const queueResult = formData.get('QueueResult') as string | null;
    // QueueResult: 'bridged', 'hangup', 'leave', 'error', 'redirected', ...
    // 'redirected' means we REST-updated the call to dial the rep via
    // connect-claimed-rep — that handler owns the row, don't touch it.
    // 'bridged' is the legacy <Dial><Queue> flow.
    if (queueId && queueResult !== 'redirected') {
      const finalStatus = queueResult === 'bridged' ? 'completed' : 'abandoned';
      await supabase
        .from('call_queue')
        .update({
          status: finalStatus,
          ended_at: new Date().toISOString(),
        })
        .eq('id', queueId)
        // Only reconcile from 'waiting' — if already 'claimed' or 'completed',
        // the rep-bridge flow is in charge.
        .eq('status', 'waiting')
        .then(() => {})
        .catch(() => {});
    }
    return new Response(laml.buildLamlResponse([laml.hangup()]), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Connect claimed rep: invoked by REST Update-Call from call-claim. Pulls
  //    caller out of the <Enqueue> hold room and dials the rep's Call Fabric
  //    subscriber identity, which routes the INVITE to their browser SDK. ──
  if (step === 'connect-claimed-rep') {
    const identity = url.searchParams.get('identity');
    const queueId = url.searchParams.get('queueId');
    const elements: string[] = [];
    if (!identity) {
      console.error('[sw-inbound] connect-claimed-rep missing identity');
      elements.push(laml.say('We are unable to connect you right now. Please try again.'));
      elements.push(laml.hangup());
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }

    // Mark the queue row completed right away (the <Enqueue> action URL
    // won't fire a second time because we REST-redirected).
    if (queueId) {
      await supabase
        .from('call_queue')
        .update({ status: 'completed', ended_at: new Date().toISOString() })
        .eq('id', queueId)
        .in('status', ['waiting', 'claimed'])
        .then(() => {})
        .catch(() => {});
    }

    elements.push(laml.dialClient(identity, {
      timeLimit: 14400,
      action: `${baseUrl}/sw-inbound?step=queue-exit&queueId=${queueId ?? ''}`,
      timeout: 30,
      record: true,
    }));
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

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
      elements.push(laml.say(`You are receiving a callback. Connecting you to ${rep.full_name} now.`));
      elements.push(await enqueueCaller({
        callSid, from, targetRepId: rep.id, baseUrl,
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
      elements.push(laml.say('No representative is available right now. We are placing you in a short hold queue — someone will be with you shortly. Please stay on the line.'));
      elements.push(await enqueueCaller({ callSid, from, baseUrl }));
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
      elements.push(await enqueueCaller({ callSid, from, targetRepId: repId, baseUrl }));
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
      console.log(`[sw-inbound] ext-dial: ext=${ext} rep=${rep.full_name} id=${rep.id}`);
      elements.push(laml.say(`Connecting you to ${rep.full_name}. Please hold.`));
      elements.push(await enqueueCaller({
        callSid, from, customerId, targetRepId: rep.id, baseUrl,
      }));
    } else if (rep.status === 'busy') {
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=ext-busy&repId=${rep.id}&customerId=${customerId || ''}`));
    } else {
      // offline
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=ext-offline&repId=${rep.id}&customerId=${customerId || ''}`));
    }
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Connect to rep: skill-based routing (category-matched rep preferred) ──
  if (step === 'connect-rep') {
    const elements: string[] = [];
    const category = url.searchParams.get('category') || '';

    // Try specialty-matched rep first, then fall back to any available rep
    let repsToCall: Array<{ id: string; full_name: string; email: string; status: string }> = [];
    if (category) {
      const { data: specialists } = await supabase
        .from('reps')
        .select('id, full_name, email, status')
        .eq('status', 'available')
        .contains('specialties', [category]);
      if (specialists && specialists.length > 0) repsToCall = specialists;
    }
    if (repsToCall.length === 0) {
      const { data: allReps } = await supabase
        .from('reps')
        .select('id, full_name, email, status')
        .eq('status', 'available');
      repsToCall = allReps || [];
    }

    console.log(`[sw-inbound] connect-rep: category=${category} found ${repsToCall.length} reps`);
    if (repsToCall.length > 0) {
      elements.push(laml.say('Connecting you to the next available representative. Please hold.'));
    } else {
      elements.push(laml.say('All representatives are currently busy. Please hold.'));
    }
    // Either way the caller parks in the general queue; any rep whose browser
    // is connected can claim them. Reps see the row via Supabase Realtime.
    elements.push(await enqueueCaller({ callSid, from, customerId, baseUrl }));
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Menu response ──
  if (step === 'menu' && customerId && digits) {
    const elements: string[] = [];

    switch (digits) {
      case '1': { // Route through AI intake before connecting to rep
        elements.push(laml.redirect(`${baseUrl}/sw-ai-intake?customerId=${customerId}`));
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

      case '6': // Low-balance choice: 1=buy, 2=continue
        elements.push(laml.redirect(`${baseUrl}/sw-package-select?customerId=${customerId}`));
        break;

      default:
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
        break;
    }

    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Low-balance proactive choice (before main menu) ──
  if (step === 'low-balance-choice' && customerId && digits) {
    const choiceElements: string[] = [];
    if (digits === '1') {
      choiceElements.push(laml.redirect(`${baseUrl}/sw-package-select?customerId=${customerId}`));
    } else {
      choiceElements.push(laml.redirect(`${baseUrl}/sw-inbound?step=menu&customerId=${customerId}`));
    }
    return new Response(laml.buildLamlResponse(choiceElements), { headers: { 'Content-Type': 'application/xml' } });
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

    // ── Proactive low-balance top-up offer ──
    const lowBalanceThreshold = Number(settingsMap.low_balance_threshold) || 10;
    const isReturningCaller = !customer.full_name.startsWith('Caller ');
    if (customer.current_balance_minutes > 0 && customer.current_balance_minutes <= lowBalanceThreshold) {
      elements.push(
        laml.gather(
          { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=low-balance-choice&customerId=${customer.id}`, timeout: 8 },
          [laml.say('Your balance is getting low. Press 1 to add minutes now, or press 2 to continue.')]
        )
      );
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=menu&customerId=${customer.id}`));
    } else if (isReturningCaller) {
      // Returning caller fast-path: single press to skip to AI intake
      elements.push(
        laml.gather(
          { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=menu&customerId=${customer.id}`, timeout: 6 },
          [laml.say('Press 1 to speak with a representative, or stay on the line for more options.')]
        )
      );
      // Timeout fallback — show full menu
      elements.push(buildMenuGather(baseUrl, customer));
      elements.push(laml.say('No input received. Connecting you to a representative.'));
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep&customerId=${customer.id}`));
    } else {
      // New caller — full IVR menu
      elements.push(buildMenuGather(baseUrl, customer));
      elements.push(laml.say('No input received. Connecting you to a representative.'));
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep&customerId=${customer.id}`));
    }
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
  // Note: can't await here (sync helper); route through redirect to connect-rep
  // which performs the queue insert/enqueue with proper call context.
  elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep&customerId=${customerId}`));
  return laml.buildLamlResponse(elements);
}

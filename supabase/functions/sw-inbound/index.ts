// Edge Function: sw-inbound (SignalWire inbound call webhook)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import * as laml from '../_shared/laml.ts';
import { formatMinuteAnnouncement } from '../_shared/utils.ts';
import { enqueueCaller } from '../_shared/callQueue.ts';
import { getSubscriberAddressPath } from '../_shared/signalwire.ts';

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

  // ── Connect claimed rep: invoked by REST Update-Call from call-claim.
  //    Strategy: put the caller into a Conference room (LaML), and in
  //    parallel originate a REST call to the rep's Call Fabric subscriber
  //    whose answer URL returns LaML that joins the same conference. Both
  //    legs meet in the room. This works from a LaML Compatibility handler
  //    because we never rely on SWML verbs. ──
  if (step === 'connect-claimed-rep') {
    const identity = url.searchParams.get('identity');
    const queueId = url.searchParams.get('queueId');
    if (!identity) {
      console.error('[sw-inbound] connect-claimed-rep missing identity');
      const elements = [laml.say('We are unable to connect you right now. Please try again.'), laml.hangup()];
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }

    // Mark the queue row completed right away.
    if (queueId) {
      await supabase
        .from('call_queue')
        .update({ status: 'completed', ended_at: new Date().toISOString() })
        .eq('id', queueId)
        .in('status', ['waiting', 'claimed'])
        .then(() => {})
        .catch(() => {});
    }

    // Unique room name. queueId is already unique per call.
    const roomName = `conf-${queueId || callSid}`;
    const fromNumber = Deno.env.get('SIGNALWIRE_FROM_NUMBER') || '+18459357587';

    // Kick off the rep-leg origination in the background so we return the
    // caller's LaML immediately. We originate TO the Fabric address so the
    // browser SDK receives the invite via its existing online() handler.
    const repJoinUrl = `${baseUrl}/sw-inbound?step=rep-conference-join&room=${encodeURIComponent(roomName)}&callerFrom=${encodeURIComponent(from || '')}`;
    (async () => {
      try {
        // Lazy-import to avoid circular / header issues
        const { createCall } = await import('../_shared/signalwire.ts');
        // Try the Call Fabric address path first (no + prefix, starts with /).
        const fabricAddress = `/private/${identity}`;
        const result = await createCall({
          to: fabricAddress,
          from: fromNumber,
          url: repJoinUrl,
          statusCallback: `${baseUrl}/sw-inbound?step=rep-leg-status&room=${encodeURIComponent(roomName)}`,
        });
        console.log('[sw-inbound] rep-leg createCall result:', JSON.stringify(result));
        await supabase.from('call_traces').insert({
          call_sid: callSid,
          step: 'rep-leg-originate',
          from_number: from,
          details: { room: roomName, identity, result },
        }).catch(() => {});
      } catch (err) {
        console.error('[sw-inbound] rep-leg createCall failed:', err);
      }
    })();

    // Caller LaML: join the conference with hold music while the rep
    // leg is being originated. endConferenceOnExit=true on the caller so
    // when the caller hangs up, the room tears down.
    const elements = [
      laml.say('Connecting you to your representative now. Please hold.'),
      laml.dialConference(roomName, {
        startConferenceOnEnter: false,
        endConferenceOnExit: true,
        waitUrl: '',
        beep: false,
        timeLimit: 14400,
        statusCallback: `${baseUrl}/sw-inbound?step=queue-exit&queueId=${queueId ?? ''}`,
      }),
      laml.hangup(),
    ];
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Rep conference join: URL the rep's subscriber hits when their
  //    browser auto-answers the originated call. Returns LaML joining the
  //    conference room. startConferenceOnEnter=true so the room "opens"
  //    as soon as the rep is in. ──
  if (step === 'rep-conference-join') {
    const room = url.searchParams.get('room');
    const callerFrom = url.searchParams.get('callerFrom') || '';
    if (!room) {
      return new Response(laml.buildLamlResponse([laml.say('Room parameter missing. Goodbye.'), laml.hangup()]), { headers: { 'Content-Type': 'application/xml' } });
    }
    const elements = [
      laml.say(callerFrom ? `Incoming call from ${callerFrom.replace(/\+?1?/, '').split('').join(' ')}. Connecting now.` : 'Incoming call. Connecting now.'),
      laml.dialConference(room, {
        startConferenceOnEnter: true,
        endConferenceOnExit: true,
        beep: false,
        timeLimit: 14400,
      }),
      laml.hangup(),
    ];
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Rep leg status (diagnostic): fires throughout the rep leg lifecycle. ──
  if (step === 'rep-leg-status') {
    return new Response(laml.buildLamlResponse([laml.hangup()]), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Outbound bridge: invoked when a customer answers a rep-initiated
  //    outbound call. Connects the rep's Call Fabric subscriber via SWML. ──
  if (step === 'outbound-bridge') {
    const identity = url.searchParams.get('identity');
    const callId = url.searchParams.get('callId');
    if (!identity) {
      const elements = [laml.say('This call was initiated in error. Goodbye.'), laml.hangup()];
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }
    const addressPath = await getSubscriberAddressPath(identity);
    console.log(`[sw-inbound] outbound-bridge identity=${identity} callId=${callId} address=${addressPath}`);
    if (!addressPath) {
      const elements = [laml.say('Your representative is unavailable. Goodbye.'), laml.hangup()];
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }
    const swml = {
      version: '1.0.0',
      sections: {
        main: [
          {
            connect: {
              to: addressPath,
              timeout: 30,
              max_duration: 14400,
              answer_on_bridge: true,
              status_url: `${baseUrl}/sw-inbound?step=outbound-end&callId=${callId ?? ''}`,
            },
          },
          { hangup: {} },
        ],
      },
    };
    return new Response(JSON.stringify(swml), { headers: { 'Content-Type': 'application/json' } });
  }

  // ── Outbound end: after <Dial> completes on an outbound-bridge call. ──
  if (step === 'outbound-end') {
    return new Response(laml.buildLamlResponse([laml.hangup()]), { headers: { 'Content-Type': 'application/xml' } });
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
      case '0': // Live Agent submenu
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=agent-menu&customerId=${customerId}`));
        break;

      case '1': // Company information
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=company-info&customerId=${customerId}`));
        break;

      case '2': // Balance & minutes submenu
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=balance-menu&customerId=${customerId}`));
        break;

      case '3': // Account update submenu
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=account-menu&customerId=${customerId}`));
        break;

      case '4': // Yiddish admin office voicemail
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=voicemail-yiddish&customerId=${customerId}`));
        break;

      case '7': // Terms & security submenu
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=terms-menu&customerId=${customerId}`));
        break;

      case '9': // Replay main menu
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
        break;

      default:
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
        break;
    }

    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── 0) Live Agent submenu ──
  if (step === 'agent-menu' && customerId) {
    const elements: string[] = [];
    if (!digits) {
      elements.push(laml.gather(
        { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=agent-menu&customerId=${customerId}`, timeout: 10 },
        laml.sayLines([
          'To speak with the next available agent, press 1.',
          'To connect with a specific extension, press 2.',
          'To reconnect with the agent from your most recent call, press 3.',
          'To return to the main menu, press star.',
        ])
      ));
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }
    switch (digits) {
      case '1': // next available agent via AI intake
        elements.push(laml.redirect(`${baseUrl}/sw-ai-intake?customerId=${customerId}`));
        break;
      case '2': // specific extension
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=extension&customerId=${customerId}`));
        break;
      case '3': // last agent reconnect
        elements.push(laml.redirect(`${baseUrl}/sw-preferred-rep?customerId=${customerId}`));
        break;
      case '*':
      default:
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
        break;
    }
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── 1) Company Information ──
  if (step === 'company-info' && customerId) {
    const elements = [
      ...laml.sayLines([
        'You have reached Offline, a live phone support service that helps customers with online tasks — including shopping, bill payments, account assistance, and form support.',
      ]),
      laml.gather(
        { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=return-main&customerId=${customerId}`, timeout: 6 },
        [laml.say('To return to the main menu, press star.')]
      ),
      laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`),
    ];
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── 2) Balance & Minutes submenu ──
  if (step === 'balance-menu' && customerId) {
    const elements: string[] = [];
    if (!digits) {
      elements.push(laml.gather(
        { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=balance-menu&customerId=${customerId}`, timeout: 10 },
        laml.sayLines([
          'To hear your current minute balance, press 1.',
          'To add more minutes to your account, press 2.',
          'To return to the main menu, press star.',
        ])
      ));
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }
    if (digits === '1') {
      const { data: customer } = await supabase.from('customers').select('current_balance_minutes').eq('id', customerId).single();
      const mins = customer?.current_balance_minutes ?? 0;
      elements.push(laml.say(formatMinuteAnnouncement(mins, 'You currently have {minutes} minutes remaining.')));
      elements.push(laml.pause(1));
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
    } else if (digits === '2') {
      elements.push(laml.redirect(`${baseUrl}/sw-package-select?customerId=${customerId}`));
    } else {
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
    }
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── 3) Account Update submenu ──
  if (step === 'account-menu' && customerId) {
    const elements: string[] = [];
    if (!digits) {
      elements.push(laml.gather(
        { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=account-menu&customerId=${customerId}`, timeout: 10 },
        laml.sayLines([
          'To update your account information, press 1.',
          'To securely save your credit card details for future use, press 2.',
          'To return to the main menu, press star.',
        ])
      ));
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }
    if (digits === '1') {
      elements.push(laml.redirect(`${baseUrl}/sw-account-lookup?customerId=${customerId}`));
    } else if (digits === '2') {
      elements.push(laml.redirect(`${baseUrl}/sw-payment-gather?customerId=${customerId}&mode=save`));
    } else {
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
    }
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── 4) Yiddish admin office voicemail ──
  if (step === 'voicemail-yiddish' && customerId) {
    const elements = [
      ...laml.sayLines([
        'Please leave your message for the Yiddish admin office after the tone.',
        'Be sure to include your name, phone number, and the reason for your call.',
      ]),
      laml.record({
        action: `${baseUrl}/sw-inbound?step=voicemail-complete&customerId=${customerId}&mailbox=yiddish`,
        maxLength: 180,
        transcribe: true,
        transcribeCallback: `${baseUrl}/sw-transcription?mailbox=yiddish&customerId=${customerId}`,
      }),
      ...laml.sayLines([
        'Thank you for calling Offline.',
        'We appreciate your call and look forward to assisting you.',
      ]),
      laml.hangup(),
    ];
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  if (step === 'voicemail-complete' && customerId) {
    const elements = [
      ...laml.sayLines([
        'Your message has been received.',
        'Thank you for calling Offline. Goodbye.',
      ]),
      laml.hangup(),
    ];
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── 7) Terms & Security submenu ──
  if (step === 'terms-menu' && customerId) {
    const elements: string[] = [];
    if (!digits) {
      elements.push(laml.gather(
        { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=terms-menu&customerId=${customerId}`, timeout: 10 },
        laml.sayLines([
          'To hear our terms and conditions, press 1.',
          'To hear our security measures, press 2.',
          'To return to the main menu, press star.',
        ])
      ));
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }
    if (digits === '1') {
      elements.push(laml.redirect(`${baseUrl}/sw-terms?customerId=${customerId}`));
    } else if (digits === '2') {
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=security-measures&customerId=${customerId}`));
    } else {
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
    }
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  if (step === 'security-measures' && customerId) {
    const elements = [
      ...laml.sayLines([
        'At Offline, your security is our priority.',
        'All calls are recorded on encrypted servers for quality and training.',
        'Credit card details are captured through a secure PCI-compliant system and never shared with our agents.',
        'Account credentials are stored in a zero-knowledge vault and are only unlocked for the duration of your active call.',
      ]),
      laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`),
    ];
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  if (step === 'return-main' && customerId) {
    return new Response(
      laml.buildLamlResponse([laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`)]),
      { headers: { 'Content-Type': 'application/xml' } }
    );
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
      // Main Greeting — natural cadence via short lines with brief pauses
      elements.push(...laml.sayLines([
        'Thank you for calling Offline.',
        "Stay offline — we'll handle the online.",
        'Please listen carefully and select from the following options.',
      ]));
    } else {
      elements.push(...laml.sayLines([
        `Welcome back, ${customer.full_name}.`,
        "Stay offline — we'll handle the online.",
      ]));
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
    elements.push(laml.say('Welcome to Offline. Connecting you to a representative.'));
    elements.push(laml.pause(1));
    elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep&customerId=`));
  }

  const xml = laml.buildLamlResponse(elements);
  return new Response(xml, { headers: { 'Content-Type': 'application/xml' } });
});

// ── Helper: build the <Gather> for the main menu (Offline IVR spec) ──
function buildMenuGather(baseUrl: string, customer: { id: string; preferred_rep_id?: string | null; current_balance_minutes: number }): string {
  const lines: string[] = [
    'To connect with a live agent, press 0.',
    'For company information, press 1.',
    'To hear your balance or add more minutes, press 2.',
    'To update your information or securely save your credit card details, press 3.',
    'To leave a message for the Yiddish admin office, press 4.',
    'To hear our terms, conditions, and security measures, press 7.',
  ];
  return laml.gather(
    { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=menu&customerId=${customer.id}`, timeout: 10 },
    laml.sayLines(lines)
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

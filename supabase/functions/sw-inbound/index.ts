// Edge Function: sw-inbound (SignalWire inbound call webhook)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import * as laml from '../_shared/laml.ts';
import { formatMinuteAnnouncement } from '../_shared/utils.ts';
import { enqueueCaller } from '../_shared/callQueue.ts';
import { getSubscriberAddressPath, toSwIdentity } from '../_shared/signalwire.ts';
import { promptLines } from '../_shared/promptStore.ts';

/**
 * Insert a `pending` callback_requests row for a caller who hung up before a
 * rep ever bridged. Idempotent — relies on the partial UNIQUE index on
 * `call_sid` (uniq_callback_requests_call_sid) so re-firing webhooks for the
 * same SignalWire CallSid don't create duplicates.
 *
 * Resolves the customer (if any) by phone-number variants — the same logic
 * the inbound matcher uses, so a known caller's row is linked to the existing
 * customer instead of an unrelated stub.
 */
async function createAbandonedCallback(
  supabase: ReturnType<typeof createServiceClient>,
  args: { callSid: string; from: string | null; queueId?: string | null },
): Promise<void> {
  const { callSid, from, queueId } = args;
  if (!callSid) return;
  try {
    // Build the same E.164 / digit variants used in the inbound lookup so we
    // attach to the original customer row rather than the bogus auto-stub.
    const fromStr = from || '';
    const fromDigits = fromStr.replace(/[^0-9]/g, '');
    const variants = new Set<string>([fromStr]);
    if (fromDigits.length === 11 && fromDigits.startsWith('1')) {
      variants.add(`+${fromDigits}`);
      variants.add(fromDigits);
      variants.add(fromDigits.slice(1));
      variants.add(`+1${fromDigits.slice(1)}`);
    } else if (fromDigits.length === 10) {
      variants.add(fromDigits);
      variants.add(`+1${fromDigits}`);
      variants.add(`1${fromDigits}`);
      variants.add(`+${fromDigits}`);
    }
    const variantsList = Array.from(variants).filter((v) => v.length > 0);

    let customerId: string | null = null;
    let callerName: string | null = null;
    if (variantsList.length > 0) {
      const { data: cust } = await supabase
        .from('customers')
        .select('id, full_name')
        .in('primary_phone', variantsList)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (cust) {
        customerId = cust.id;
        callerName = cust.full_name;
      }
    }

    // Prefer caller_name from call_queue if available (it captured a friendlier
    // name when the queue was entered).
    if (!callerName && queueId) {
      const { data: q } = await supabase
        .from('call_queue')
        .select('caller_name')
        .eq('id', queueId)
        .maybeSingle();
      if (q?.caller_name) callerName = q.caller_name;
    }

    const e164 = fromDigits.length === 10
      ? `+1${fromDigits}`
      : fromDigits.length === 11 && fromDigits.startsWith('1')
        ? `+${fromDigits}`
        : (fromStr || null);
    if (!e164) return;

    await supabase
      .from('callback_requests')
      .upsert(
        {
          phone_number: e164,
          customer_id: customerId,
          caller_name: callerName,
          call_sid: callSid,
          is_general: true,
          status: 'pending',
        },
        { onConflict: 'call_sid', ignoreDuplicates: true },
      );
  } catch (err) {
    console.error('[sw-inbound] createAbandonedCallback failed:', err);
  }
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
    const isAbandoned = queueResult !== 'redirected' && queueResult !== 'bridged';
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
    // Auto-create a callback for callers who hung up before a rep picked up.
    // Idempotent via uniq_callback_requests_call_sid (PG unique partial index).
    if (isAbandoned && callSid) {
      await createAbandonedCallback(supabase, { callSid, from, queueId });
    }
    return new Response(laml.buildLamlResponse([laml.hangup()]), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Claimed-rep dial fallback: rep was claimed and we Update-Call'd them
  //    into a <Dial><Sip|Number>, but the rep didn't answer (call hit timeout
  //    or busy). Without this step the caller would just hangup and vanish;
  //    instead we record an abandoned-call callback and end the call. ──
  if (step === 'claimed-rep-fallback') {
    const dialCallStatus = formData.get('DialCallStatus') as string | null;
    if (dialCallStatus !== 'completed' && callSid) {
      await createAbandonedCallback(supabase, { callSid, from });
    }
    return new Response(laml.buildLamlResponse([laml.hangup()]), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Connect claimed rep: invoked by REST Update-Call from call-claim.
  //    Strategy: return LaML <Dial><Sip>sip:<identity>@<sipDomain></Sip></Dial>
  //    directly to the caller. SignalWire routes the SIP INVITE to the
  //    rep's Call Fabric subscriber registration (the SDK's online()
  //    handler receives it and auto-answers). This is the simplest working
  //    bridge from a LaML Compatibility handler. ──
  if (step === 'connect-claimed-rep') {
    const repIdParam = url.searchParams.get('repId');
    const queueId = url.searchParams.get('queueId');
    if (!repIdParam) {
      console.error('[sw-inbound] connect-claimed-rep missing repId');
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

    // Look up how to reach the rep: prefer SIP URI (free), fall back to
    // PSTN number, then to browser SDK via <Dial><Client>identity</Client></Dial>.
    const { data: rep } = await supabase
      .from('reps')
      .select('id, full_name, email, phone_e164, sip_uri')
      .eq('id', repIdParam)
      .maybeSingle();

    let dialXml = rep ? laml.dialRep(rep, {
      callerId: Deno.env.get('SIGNALWIRE_FROM_NUMBER') || undefined,
      timeout: 30,
      timeLimit: 14400,
      record: true,
      recordingStatusCallback: `${baseUrl}/sw-recording-complete`,
      // If the claimed rep doesn't answer, return through claimed-rep-fallback
      // so we record an abandoned-call callback before hanging up.
      action: `${baseUrl}/sw-inbound?step=claimed-rep-fallback`,
    }) : null;

    // Browser-only rep (no phone_e164, no sip_uri): bridge via the rep's
    // SignalWire Call Fabric subscriber identity. The rep's softphone is
    // already connected via client.online(), so SignalWire delivers the
    // INVITE over that websocket. (See softphone.tsx header comment.)
    let bridgeKind: 'sip' | 'pstn' | 'browser' | 'none' = 'none';
    if (rep?.sip_uri) bridgeKind = 'sip';
    else if (rep?.phone_e164) bridgeKind = 'pstn';
    if (!dialXml && rep?.email) {
      const identity = toSwIdentity(rep.email);
      dialXml = laml.dialClient(identity, {
        callerId: Deno.env.get('SIGNALWIRE_FROM_NUMBER') || undefined,
        timeout: 30,
        timeLimit: 14400,
        record: true,
        recordingStatusCallback: `${baseUrl}/sw-recording-complete`,
        action: `${baseUrl}/sw-inbound?step=claimed-rep-fallback`,
      });
      bridgeKind = 'browser';
    }

    if (!dialXml) {
      console.error(`[sw-inbound] connect-claimed-rep rep ${repIdParam} has no phone_e164, sip_uri, or email`);
      const elements = [
        laml.say('Your representative does not have a phone number on file. Please contact support.'),
        laml.hangup(),
      ];
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }

    console.log(`[sw-inbound] connect-claimed-rep rep=${repIdParam} bridge=${bridgeKind}`);
    const elements = [
      laml.say('Connecting you to your representative now. Please hold.'),
      dialXml,
      laml.hangup(),
    ];
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Rep conference join (unused — kept for reference) ──
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
  //    outbound call. Dials the rep on their PSTN number or SIP URI. ──
  if (step === 'outbound-bridge') {
    const repIdParam = url.searchParams.get('repId');
    const callId = url.searchParams.get('callId');
    if (!repIdParam) {
      const elements = [laml.say('This call was initiated in error. Goodbye.'), laml.hangup()];
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }

    const { data: rep } = await supabase
      .from('reps')
      .select('id, full_name, phone_e164, sip_uri')
      .eq('id', repIdParam)
      .maybeSingle();

    const dialXml = rep ? laml.dialRep(rep, {
      callerId: Deno.env.get('SIGNALWIRE_FROM_NUMBER') || undefined,
      timeout: 30,
      timeLimit: 14400,
      action: `${baseUrl}/sw-inbound?step=outbound-end&callId=${callId ?? ''}`,
      record: true,
      recordingStatusCallback: `${baseUrl}/sw-recording-complete`,
    }) : null;

    console.log(`[sw-inbound] outbound-bridge rep=${repIdParam} callId=${callId} target=${rep?.sip_uri ? 'sip' : rep?.phone_e164 ? 'pstn' : 'none'}`);

    if (!dialXml) {
      const elements = [laml.say('Your representative is unavailable. Goodbye.'), laml.hangup()];
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }

    const elements = [dialXml, laml.hangup()];
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
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

    // ── Balance gate: a caller with no package / 0 balance should NOT be
    //    routed to a rep. They get offered a package or sent to voicemail. ──
    if (customerId) {
      const { data: cust } = await supabase
        .from('customers')
        .select('id, current_balance_minutes, total_minutes_purchased')
        .eq('id', customerId)
        .maybeSingle();
      const { data: gateSetting } = await supabase
        .from('admin_settings')
        .select('value')
        .eq('key', 'first_time_zero_balance')
        .maybeSingle();
      const gateMode = String(gateSetting?.value ?? 'warn'); // allow | warn | block
      const minutes = cust?.current_balance_minutes ?? 0;
      const hasEverPurchased = (cust?.total_minutes_purchased ?? 0) > 0;

      if (minutes <= 0 && gateMode === 'block') {
        // No balance, no package yet → offer to buy a package now.
        elements.push(laml.say(hasEverPurchased
          ? 'Your account has no minutes remaining. Please add minutes to continue.'
          : 'To speak with a representative you will need an active minutes package. Let\'s get you set up.'));
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=balance-menu&customerId=${customerId}`));
        return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
      }
      // 'warn' and 'allow' modes: silently route the caller to a rep. The
      // rep's active-call UI shows a "NO MINUTES" banner so the rep — not
      // the caller — is the one prompted to collect payment.
    }

    // ── Recording disclosure (moved here so first-time IVR greeting is faster)
    elements.push(laml.say('This call may be recorded for quality assurance and training purposes.'));
    elements.push(laml.pause(1));

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

  // ── Fast-path response (returning caller pressed a digit after greeting) ──
  //   0 → live agent (via AI intake when enabled).
  //   1 → tracking submenu.
  //   2 → buy minutes (package list).
  //   3 → extension dial.
  //   * → full main menu.
  //   anything else → replay menu.
  if (step === 'fast-rep' && customerId && digits) {
    const elements: string[] = [];
    switch (digits) {
      case '0':
        // Live agent — go through agent-menu's "1" path so the AI-intake
        // admin toggle is honored. We re-check the toggle here to avoid a
        // separate redirect hop: AI intake when on, plain connect-rep when off.
        {
          let aiEnabled = true;
          try {
            const { data: setting } = await supabase
              .from('admin_settings')
              .select('value')
              .eq('key', 'ai_intake_enabled')
              .maybeSingle();
            if (setting && typeof setting.value === 'boolean') aiEnabled = setting.value;
            else if (setting && setting.value !== null && setting.value !== undefined) aiEnabled = String(setting.value).toLowerCase() !== 'false';
            else aiEnabled = (Deno.env.get('AI_INTAKE_ENABLED') ?? 'true').toLowerCase() !== 'false';
          } catch {
            aiEnabled = (Deno.env.get('AI_INTAKE_ENABLED') ?? 'true').toLowerCase() !== 'false';
          }
          if (aiEnabled) {
            elements.push(laml.redirect(`${baseUrl}/sw-ai-intake?customerId=${customerId}`));
          } else {
            elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep&customerId=${customerId}`));
          }
        }
        break;
      case '1': // tracking submenu
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=tracking-menu&customerId=${customerId}`));
        break;
      case '2': // buy minutes
        elements.push(laml.redirect(`${baseUrl}/sw-package-select?customerId=${customerId}`));
        break;
      case '3': // extension dial
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=extension&customerId=${customerId}`));
        break;
      case '*':
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
        break;
      default:
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
        break;
    }
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── New-caller intake choice ──
  //   1 = open account / talk to a rep (with note)
  //   2 = caller has account on a different phone number → gather 10 digits
  //   anything else → fall through to the full main menu
  if (step === 'new-caller-choice' && customerId) {
    const elements: string[] = [];
    if (digits === '1') {
      try {
        await supabase
          .from('calls')
          .update({ ai_intake_brief: 'New caller requested to open an account or speak with a representative.' })
          .eq('call_sid', callSid);
      } catch (err) {
        console.error('[sw-inbound] new-caller note write failed:', err);
      }
      elements.push(laml.say("Great — I'll connect you with a representative who can help you set up your account. Please hold."));
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep&customerId=${customerId}&category=new_account`));
    } else if (digits === '2') {
      elements.push(laml.gather(
        { input: 'dtmf', numDigits: 10, action: `${baseUrl}/sw-inbound?step=alt-phone-confirm&customerId=${customerId}`, timeout: 20, finishOnKey: '#' },
        [laml.say('Please enter the 10 digit phone number that your account is on, then press pound.')]
      ));
      elements.push(laml.say("I didn't catch that. Let me take you to the main menu."));
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
    } else if (digits === '*') {
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
    } else {
      // Any other digit → main menu
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
    }
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Alt-phone lookup: caller said their account is on a different number ──
  //   Repeats the digits back, asks for confirmation. On confirm we attach
  //   the original (auto-stub) call to the real customer and add a phone
  //   alias so future calls from this number find the right account.
  if (step === 'alt-phone-confirm' && customerId) {
    const elements: string[] = [];
    const altDigits = (digits || '').replace(/[^0-9]/g, '');
    if (altDigits.length !== 10) {
      elements.push(laml.say("That phone number didn't have 10 digits. Let's try again."));
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=new-caller-choice&customerId=${customerId}`));
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }
    const e164 = `+1${altDigits}`;
    const spoken = altDigits.split('').join(' ');
    elements.push(laml.gather(
      { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=alt-phone-link&customerId=${customerId}&alt=${e164}`, timeout: 8 },
      [laml.say(`I heard ${spoken}. If that's correct, press 1. To try again, press 2.`)]
    ));
    elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  if (step === 'alt-phone-link' && customerId) {
    const elements: string[] = [];
    const altE164 = url.searchParams.get('alt') || '';
    if (digits === '2') {
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=new-caller-choice&customerId=${customerId}`));
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }
    if (digits !== '1' || !altE164) {
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }
    // Look up the customer on the supplied alt number.
    const altDigits10 = altE164.replace(/[^0-9]/g, '').slice(-10);
    const altVariants = [altE164, `1${altDigits10}`, altDigits10, `+${altDigits10}`];
    const { data: altCust } = await supabase
      .from('customers')
      .select('id, full_name')
      .in('primary_phone', altVariants)
      .eq('status', 'active')
      .maybeSingle();
    let realCustomerId: string | null = altCust?.id ?? null;
    if (!realCustomerId) {
      const { data: aliasMatch } = await supabase
        .from('customer_phone_aliases')
        .select('customer_id, customers!inner(id, full_name)')
        .in('phone', altVariants)
        .maybeSingle();
      // deno-lint-ignore no-explicit-any
      realCustomerId = (aliasMatch as any)?.customer_id ?? null;
    }

    if (!realCustomerId) {
      elements.push(laml.say("I couldn't find an account with that number. Let me connect you with a representative who can help you out."));
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep&customerId=${customerId}&category=phone_lookup_failed`));
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }

    // Attach the in-flight calls row to the real customer and add the
    // current phone as an alias on the real customer so future inbound
    // calls from this number land on the same account.
    try {
      await supabase.from('calls').update({ customer_id: realCustomerId }).eq('call_sid', callSid);
      const fromDigits2 = (from || '').replace(/[^0-9]/g, '');
      const fromE164 = fromDigits2.length === 10
        ? `+1${fromDigits2}`
        : fromDigits2.length === 11 && fromDigits2.startsWith('1')
          ? `+${fromDigits2}`
          : (from || '');
      if (fromE164) {
        await supabase
          .from('customer_phone_aliases')
          .upsert({ customer_id: realCustomerId, phone: fromE164 }, { onConflict: 'phone', ignoreDuplicates: true });
      }
      // Optionally clean up the auto-created stub if it's still a "Caller +1..." row.
      if (customerId !== realCustomerId) {
        const { data: stub } = await supabase
          .from('customers')
          .select('full_name')
          .eq('id', customerId)
          .maybeSingle();
        if (stub?.full_name?.startsWith('Caller ')) {
          await supabase.from('customers').delete().eq('id', customerId);
        }
      }
    } catch (err) {
      console.error('[sw-inbound] alt-phone link error:', err);
    }

    elements.push(laml.say(`Got it — welcome back, ${altCust?.full_name ?? 'thanks for calling'}.`));
    elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${realCustomerId}`));
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

      case '4': // Tracking & recent orders submenu
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=tracking-menu&customerId=${customerId}`));
        break;

      case '5': // (legacy) Order status — kept as alias for callers used to old menu
        elements.push(laml.redirect(`${baseUrl}/sw-order-status?step=intro&customerId=${customerId}`));
        break;

      case '7': // Terms & security submenu
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=terms-menu&customerId=${customerId}`));
        break;

      case '9': // Yiddish admin office voicemail (moved here from 4 per 2026 spec)
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=voicemail-yiddish&customerId=${customerId}`));
        break;

      case '*': // Replay main menu
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
      // Fetch current balance so we can announce it before the agent options.
      const { data: cust } = await supabase
        .from('customers')
        .select('current_balance_minutes, full_name')
        .eq('id', customerId)
        .single();
      const mins = cust?.current_balance_minutes ?? 0;

      const menuLines = await promptLines('agent_menu', [
        'To speak with the next available agent, press 1.',
        'To buy more minutes, press star then 2.',
        'To connect with a specific extension, press 2.',
        'To reconnect with the agent from your most recent call, press 3.',
        'To return to the main menu, press star.',
      ]);

      const lines: string[] = [];
      lines.push(formatMinuteAnnouncement(mins, 'You currently have {minutes} minutes on your account.'));
      lines.push(...menuLines);

      elements.push(laml.gather(
        { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=agent-menu&customerId=${customerId}`, timeout: 10 },
        laml.sayLines(lines)
      ));
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }
    switch (digits) {
      case '1': { // next available agent — optionally via AI intake
        // Toggle is now stored in admin_settings.ai_intake_enabled (boolean).
        // Falls back to env var, then defaults to true if neither is set.
        let aiEnabled = true;
        try {
          const { data: setting } = await supabase
            .from('admin_settings')
            .select('value')
            .eq('key', 'ai_intake_enabled')
            .maybeSingle();
          if (setting && typeof setting.value === 'boolean') {
            aiEnabled = setting.value;
          } else if (setting && setting.value !== null && setting.value !== undefined) {
            // Tolerate stringly-stored values like "true"/"false".
            aiEnabled = String(setting.value).toLowerCase() !== 'false';
          } else {
            aiEnabled = (Deno.env.get('AI_INTAKE_ENABLED') ?? 'true').toLowerCase() !== 'false';
          }
        } catch {
          aiEnabled = (Deno.env.get('AI_INTAKE_ENABLED') ?? 'true').toLowerCase() !== 'false';
        }
        if (aiEnabled) {
          elements.push(laml.redirect(`${baseUrl}/sw-ai-intake?customerId=${customerId}`));
        } else {
          elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep&customerId=${customerId}`));
        }
        break;
      }
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
  //    1: hear balance   2: list packages   3: one-tap refill (last package)
  if (step === 'balance-menu' && customerId) {
    const elements: string[] = [];
    if (!digits) {
      const menuLines = await promptLines('balance_menu', [
        'To hear your current minute balance, press 1.',
        'To hear our minute packages, press 2.',
        'To refill using the last package you bought, press 3.',
        'To return to the main menu, press star.',
      ]);
      elements.push(laml.gather(
        { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=balance-menu&customerId=${customerId}`, timeout: 10 },
        laml.sayLines(menuLines)
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
      // "Hear our price packages" — read prices only, then return to main menu.
      const { data: packages } = await supabase
        .from('payment_packages')
        .select('name, minutes, price')
        .eq('is_active', true)
        .order('sort_order');
      if (!packages || packages.length === 0) {
        elements.push(laml.say('No packages are currently available.'));
      } else {
        const lines: string[] = ['Here are our current minute packages:'];
        for (const pkg of packages) {
          lines.push(`The ${pkg.name} package: ${pkg.minutes} minutes for ${pkg.price} dollars.`);
        }
        lines.push('To buy a package, press 3 from the previous menu, or press star to return now.');
        elements.push(laml.sayLines(lines).join('\n'));
      }
      elements.push(laml.pause(1));
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
    } else if (digits === '3') {
      // "Buy a minutes package" — open the buy flow (lists packages, accepts a pick, takes a card).
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
      const menuLines = await promptLines('account_menu', [
        'To update your name, phone, email, and mailing address with our automated system, press 1.',
        'To securely save your credit card on file, press 2.',
        'To return to the main menu, press star.',
      ]);
      elements.push(laml.gather(
        { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=account-menu&customerId=${customerId}`, timeout: 10 },
        laml.sayLines(menuLines)
      ));
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
      return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
    }
    if (digits === '1') {
      // Per spec: "open an account or update info" should NOT be a robot
      // capture flow — route the caller to a live rep with a note so the
      // rep knows the intent the second they pick up.
      try {
        await supabase
          .from('calls')
          .update({ ai_intake_brief: 'Caller wants to open an account or update their account information (name, phone, email, mailing address).' })
          .eq('call_sid', callSid);
      } catch (err) {
        console.error('[sw-inbound] account-menu note write failed:', err);
      }
      elements.push(laml.say("I'll connect you with one of our team members who can update your account info. Please hold."));
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep&customerId=${customerId}&category=account`));
    } else if (digits === '2') {
      elements.push(laml.redirect(`${baseUrl}/sw-payment-gather?customerId=${customerId}&mode=save`));
    } else {
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
    }
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── 3>1) Automated account update (speech-driven) ──
  // Walks the caller through name → email → mailing address. Phone is
  // implicit from CallerID. Speech results are saved to the customers row.
  if (step === 'account-update' && customerId) {
    const field = url.searchParams.get('field') || 'name';
    const speechRaw = (formData.get('SpeechResult') as string | null) || '';
    const speech = speechRaw.trim();
    const elements: string[] = [];

    // Persist whatever was just captured before moving to the next field.
    if (speech) {
      const updates: Record<string, string> = {};
      if (field === 'name') updates.full_name = speech;
      else if (field === 'email') updates.email = speech.replace(/\s+/g, '').toLowerCase();
      else if (field === 'address') updates.address = speech;
      if (Object.keys(updates).length) {
        await supabase.from('customers').update(updates).eq('id', customerId);
      }
    }

    // Decide what to ask next.
    let prompt = '';
    let nextField = '';
    if (field === 'name') {
      prompt = speech
        ? `Thanks. I've saved your name as ${speech}. Now, please say your email address — letter by letter if it's tricky.`
        : "Let's update your account. Please say your full name.";
      nextField = speech ? 'email' : 'name';
    } else if (field === 'email') {
      prompt = speech
        ? `Got it. Now, please say your full mailing address, including city, state, and zip code.`
        : "Please say your email address.";
      nextField = speech ? 'address' : 'email';
    } else if (field === 'address') {
      if (speech) {
        elements.push(...laml.sayLines([
          "All set — your account has been updated. Thank you!",
        ]));
        elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
        return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
      }
      prompt = "Please say your full mailing address, including city, state, and zip code.";
      nextField = 'address';
    }

    elements.push(laml.gatherSpeech(
      {
        action: `${baseUrl}/sw-inbound?step=account-update&field=${nextField}&customerId=${customerId}`,
        timeout: 8,
        speechTimeout: 'auto',
      },
      laml.sayLines([prompt])
    ));
    // If they say nothing, retry once then bail to main menu.
    elements.push(laml.say("I didn't catch that — let me take you back to the main menu."));
    elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
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
    // SignalWire posts RecordingUrl / RecordingSid / RecordingDuration here.
    // Strategy: ALWAYS create the `voicemails` row first (so the admin UI
    // shows the message even if the storage upload temporarily fails), then
    // attempt to download & store the audio in a separate try block.
    const mailbox = url.searchParams.get('mailbox') || 'yiddish';
    const recordingUrl = (formData.get('RecordingUrl') as string) || '';
    const recordingSid = (formData.get('RecordingSid') as string) || '';
    const recordingDuration = parseInt((formData.get('RecordingDuration') as string) || '0', 10) || null;

    if (recordingSid) {
      // Step 1: insert the voicemails row immediately so it shows up in
      // the admin dashboard even before the audio finishes uploading.
      let vmId: string | null = null;
      try {
        const { data: vm, error: vmErr } = await supabase.from('voicemails').insert({
          customer_id: customerId,
          caller_phone: from,
          mailbox,
          recording_sid: recordingSid,
          recording_url: recordingUrl || null,
          recording_storage_path: null,
          duration_seconds: recordingDuration,
        }).select('id').single();
        if (vmErr) console.error('[voicemail] row insert error:', vmErr);
        vmId = vm?.id ?? null;
      } catch (err) {
        console.error('[voicemail] row insert exception:', err);
      }

      // Step 2: try to download & upload audio. On failure we just log —
      // the row already exists and admins can use the SignalWire URL.
      if (recordingUrl) {
        try {
          const { downloadRecording } = await import('../_shared/signalwire.ts');
          const audioBuffer = await downloadRecording(recordingUrl + '.wav');
          const storagePath = `voicemails/${mailbox}/${recordingSid}.wav`;
          const { error: upErr } = await supabase.storage
            .from('call-recordings')
            .upload(storagePath, audioBuffer, { contentType: 'audio/wav', upsert: true });
          if (upErr) {
            console.error('[voicemail] storage upload error:', upErr);
          } else if (vmId) {
            await supabase.from('voicemails').update({ recording_storage_path: storagePath }).eq('id', vmId);
            // Fire-and-forget transcription (Whisper).
            const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
            const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
            fetch(`${supabaseUrl}/functions/v1/sw-transcription`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
              body: JSON.stringify({ voicemailId: vmId, storagePath }),
            }).catch(() => {});
          }
        } catch (err) {
          console.error('[voicemail] download/upload error:', err);
        }
      }
    } else {
      console.warn('[voicemail] missing RecordingSid in voicemail-complete payload');
    }

    const elements = [
      ...laml.sayLines([
        'Your message has been received.',
        'Thank you for calling Offline. Goodbye.',
      ]),
      laml.hangup(),
    ];
    return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── 4) Tracking & recent orders submenu ──
  //    1: tracking info (auto) — defers to sw-order-status which already
  //       reads tracking number / ETA / can SMS the tracking number.
  //    2: hear recent orders & forms — same intro page (lists orders).
  //    *: back to main menu.
  if (step === 'tracking-menu' && customerId) {
    const trackElements: string[] = [];
    if (!digits) {
      const menuLines = await promptLines('tracking_menu', [
        'To hear tracking information of your recent order with our automatic system, press 1.',
        'To hear your recent orders and forms, press 2.',
        'To return to the main menu, press star.',
      ]);
      trackElements.push(laml.gather(
        { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=tracking-menu&customerId=${customerId}`, timeout: 10 },
        laml.sayLines(menuLines),
      ));
      trackElements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
      return new Response(laml.buildLamlResponse(trackElements), { headers: { 'Content-Type': 'application/xml' } });
    }
    if (digits === '1' || digits === '2') {
      // Both options drop into sw-order-status?step=intro which lists open
      // orders, then per-order plays status + tracking + ETA + SMS option.
      trackElements.push(laml.redirect(`${baseUrl}/sw-order-status?step=intro&customerId=${customerId}`));
    } else {
      trackElements.push(laml.redirect(`${baseUrl}/sw-inbound?step=replay&customerId=${customerId}`));
    }
    return new Response(laml.buildLamlResponse(trackElements), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── 7) Terms & Security submenu ──
  if (step === 'terms-menu' && customerId) {
    const elements: string[] = [];
    if (!digits) {
      const menuLines = await promptLines('terms_menu', [
        'To hear our terms and conditions, press 1.',
        'To hear our security measures, press 2.',
        'To return to the main menu, press star.',
      ]);
      elements.push(laml.gather(
        { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=terms-menu&customerId=${customerId}`, timeout: 10 },
        laml.sayLines(menuLines)
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
    return new Response(await buildMainMenu(baseUrl, customer, customerId), { headers: { 'Content-Type': 'application/xml' } });
  }

  // ── Initial inbound call ──
  // Normalise the inbound number so a customer saved as `8453762437` matches
  // a SignalWire-supplied `+18453762437`, etc.
  const fromDigits = from.replace(/[^0-9]/g, '');
  const phoneVariants = new Set<string>([from]);
  if (fromDigits.length === 11 && fromDigits.startsWith('1')) {
    phoneVariants.add(`+${fromDigits}`);
    phoneVariants.add(fromDigits);
    phoneVariants.add(fromDigits.slice(1));            // 10-digit
    phoneVariants.add(`+1${fromDigits.slice(1)}`);
  } else if (fromDigits.length === 10) {
    phoneVariants.add(fromDigits);
    phoneVariants.add(`+1${fromDigits}`);
    phoneVariants.add(`1${fromDigits}`);
    phoneVariants.add(`+${fromDigits}`);
  }
  const variantsList = Array.from(phoneVariants);
  // NOTE: do NOT use `.or('primary_phone.eq.+1...')` here — PostgREST does not
  // URL-encode values inside an .or() expression, so the literal `+` in an
  // E.164 number gets decoded as a space and the row is never matched. That
  // bug caused a brand-new "Caller +1…" customer to be created on every call.
  // `.in()` properly encodes its values, so we run two safe lookups instead.
  let { data: customer } = await supabase
    .from('customers')
    .select('*')
    .in('primary_phone', variantsList)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!customer) {
    const { data: secMatch } = await supabase
      .from('customers')
      .select('*')
      .in('secondary_phone', variantsList)
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    customer = secMatch ?? null;
  }

  // Check phone aliases table (covers any extra numbers admin has linked to a customer)
  if (!customer) {
    const { data: aliasMatch } = await supabase
      .from('customer_phone_aliases')
      .select('customer_id')
      .in('phone', variantsList)
      .limit(1)
      .maybeSingle();
    if (aliasMatch?.customer_id) {
      const { data: aliasCustomer } = await supabase
        .from('customers')
        .select('*')
        .eq('id', aliasMatch.customer_id)
        .eq('status', 'active')
        .maybeSingle();
      customer = aliasCustomer ?? null;
    }
  }

  if (!customer) {
    // Always store new customers in E.164 so future lookups are deterministic.
    const e164 = fromDigits.length === 10
      ? `+1${fromDigits}`
      : fromDigits.length === 11 && fromDigits.startsWith('1')
        ? `+${fromDigits}`
        : from;
    const { data: newCustomer } = await supabase.from('customers').insert({
      full_name: `Caller ${e164}`,
      primary_phone: e164,
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
    const isReturningCaller = !isNewCaller;

    // Build greeting lines (played inside a <Gather> so caller can barge-in
    // with a digit instead of listening to the whole thing).
    // Slogan & vibe per Apr-2026 brand refresh: warm, confident, alive.
    // Pulled from `ivr_prompts` so admins can edit without redeploying.
    const greetingLines = isNewCaller
      ? await promptLines('greeting_new', [
          'Hi there, and thanks for calling Offline!',
          "We're your real human team for everything online — shopping, bills, forms, accounts, you name it.",
          "Stay offline, and we'll handle the online for you.",
          'By continuing this call, you agree to our terms and conditions.',
        ])
      : await promptLines('greeting_returning', [
          `Hey ${customer.full_name}, welcome back to Offline!`,
          "Great to hear from you again — let's get you taken care of.",
        ], { full_name: customer.full_name });

    const announcementText0 = (settingsMap.minute_announcement_text as string) || 'You currently have {minutes} minutes remaining.';
    // NOTE: balance is NOT announced in the greeting any more — it now plays
    //       only after the caller selects "0" (live agent), per spec.
    const announcement = formatMinuteAnnouncement(customer.current_balance_minutes, announcementText0);
    void announcement; // kept for downstream reuse, see agent-menu

    const lowBalanceThreshold = Number(settingsMap.low_balance_threshold) || 10;

    if (customer.current_balance_minutes > 0 && customer.current_balance_minutes <= lowBalanceThreshold) {
      // Low-balance path: greet + low-balance choice, all inside
      // a single <Gather> so caller can press 1/2 at any point.
      const sayLines = [...greetingLines];
      sayLines.push(announcementEnabled ? announcement : '');
      sayLines.push("Heads up — you're running low on minutes. Press 1 to top up now, or press 2 to continue.");
      elements.push(
        laml.gather(
          { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=low-balance-choice&customerId=${customer.id}`, timeout: 8 },
          laml.sayLines(sayLines.filter(Boolean))
        )
      );
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=menu&customerId=${customer.id}`));
    } else if (isReturningCaller) {
      // Returning-caller fast-path: greet + "press 1 for rep" all
      // inside one <Gather> so any digit barge-in jumps straight to menu.
      const sayLines = [...greetingLines];

      // If the customer has any open orders, mention the tracking shortcut
      // so they can skip straight to it without listening to the full menu.
      const { count: openOrdersCount } = await supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('customer_id', customer.id)
        .in('status', ['placed', 'paid', 'shipped']);
      const hasOpenOrders = (openOrdersCount ?? 0) > 0;

      // Returning-caller shortcut menu (per 2026 spec):
      //   0 = live agent     1 = tracking & recent orders
      //   2 = buy minutes    3 = extension     * = full main menu
      const shortcutLines: string[] = [];
      shortcutLines.push('Press 0 to speak with a representative right away.');
      if (hasOpenOrders) {
        shortcutLines.push('Press 1 to track or hear about your recent orders.');
      } else {
        shortcutLines.push('Press 1 for tracking and recent orders.');
      }
      shortcutLines.push('Press 2 to buy more minutes.');
      shortcutLines.push('Press 3 to dial a specific extension.');
      shortcutLines.push('Or press star for the full menu.');
      sayLines.push(...shortcutLines);

      elements.push(
        laml.gather(
          { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=fast-rep&customerId=${customer.id}`, timeout: 7 },
          laml.sayLines(sayLines)
        )
      );
      // Timeout fallback — show full menu
      elements.push(await buildMenuGather(baseUrl, customer));
      elements.push(laml.say("No worries — let me connect you to a representative."));
      elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep&customerId=${customer.id}`));
    } else {
      // New caller (unknown phone) — short greeting + dedicated 2-option
      // intake gather: 1 = open account / talk to a rep, 2 = "I'm calling from
      // a different phone number, my account is on a different number". Any
      // other key (or timeout) drops to the full main menu so brand-new
      // callers can still hear all the options.
      const intakeLines = [
        ...greetingLines,
        'To open a new account or speak with a representative, press 1.',
        'If you already have an account but are calling from a different phone number, press 2.',
        'For all other options, press star to hear our main menu.',
      ];
      elements.push(laml.gather(
        { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=new-caller-choice&customerId=${customer.id}`, timeout: 8 },
        laml.sayLines(intakeLines)
      ));
      // Timeout fallback — full main menu
      elements.push(await buildMenuGather(baseUrl, customer));
      elements.push(laml.say("No worries — let me connect you to a representative."));
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
async function buildMenuGather(baseUrl: string, customer: { id: string; preferred_rep_id?: string | null; current_balance_minutes: number }): Promise<string> {
  const lines = await promptLines('main_menu', [
    'For a live agent, press 0.',
    'For company information, press 1.',
    'For minutes and packages, press 2.',
    'To update your account info or save a card on file, press 3.',
    'For tracking and recent orders, press 4.',
    'For terms, conditions, and our security policy, press 7.',
    'To leave a message for the Yiddish admin office, press 9.',
  ]);
  return laml.gather(
    { input: 'dtmf', numDigits: 1, action: `${baseUrl}/sw-inbound?step=menu&customerId=${customer.id}`, timeout: 10 },
    laml.sayLines(lines)
  );
}

// ── Helper: build full menu XML for replays ──
async function buildMainMenu(baseUrl: string, customer: { id: string; preferred_rep_id?: string | null; current_balance_minutes: number } | null, customerId: string): Promise<string> {
  const elements: string[] = [];
  if (customer) {
    elements.push(await buildMenuGather(baseUrl, customer));
  } else {
    elements.push(laml.say('Connecting you to a representative.'));
  }
  elements.push(laml.say('No input received. Connecting you to a representative.'));
  elements.push(laml.redirect(`${baseUrl}/sw-inbound?step=connect-rep&customerId=${customerId}`));
  return laml.buildLamlResponse(elements);
}

// SignalWire LaML XML builder for call flows (Deno-compatible)

export function buildLamlResponse(elements: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${elements.join('\n')}\n</Response>`;
}

// ── Voice configuration ───────────────────────────────────────────────────
// We default to `Polly.Stephen-Neural` — Amazon's most conversational and
// expressive American-male Neural voice. It sounds noticeably more "alive"
// than Matthew (which is neutral/news-anchor). Customers regularly described
// the previous voice as "robotic" / "too AI" — Stephen reads with natural
// intonation, slight enthusiasm, and conversational pacing.
//
// Voice can be overridden per-call by passing the `voice` arg, and globally
// at runtime by reading the `ivr_voice` row from `admin_settings` (see
// `_shared/voiceConfig.ts`).
//
// Other tested male alternatives if Stephen ever sounds off in production:
//   - Polly.Gregory-Neural (deeper, slower, more authoritative)
//   - Polly.Matthew-Neural (neutral, professional)
//   - Polly.Brian-Neural   (British)
const DEFAULT_VOICE = 'Polly.Stephen-Neural';

/** Wrap a plain string in SSML <speak><prosody> so the Neural voice reads
 *  with a touch more energy and a warmer, conversational pace. Polly Neural
 *  voices accept SSML when the <Say> body starts with `<speak>`. */
function ssmlWrap(text: string): string {
  // Safe defaults: keep rate at "medium", nudge pitch up ~2% for warmth,
  // medium emphasis. Tweaking too aggressively makes Stephen sound cartoony.
  return `<speak><prosody rate="medium" pitch="+2%">${text}</prosody></speak>`;
}

export function say(text: string, voice: string = DEFAULT_VOICE): string {
  // SSML body — escape the user-supplied text but leave our own <speak>
  // tags un-escaped (we control them).
  const inner = ssmlWrap(escapeXml(text));
  return `  <Say voice="${voice}">${inner}</Say>`;
}

/** Speak multiple lines as ONE continuous utterance so the Neural voice's
 *  prosody engine handles pacing naturally (no robotic pauses between
 *  sentences). Returns a single-element array so callers can spread into
 *  their elements list. */
export function sayLines(lines: string[], voice: string = DEFAULT_VOICE): string[] {
  const joined = lines
    .map(l => l.trim())
    .filter(Boolean)
    .join(' ');
  return [say(joined, voice)];
}

export function record(opts: {
  action?: string;
  maxLength?: number;
  finishOnKey?: string;
  playBeep?: boolean;
  transcribe?: boolean;
  transcribeCallback?: string;
} = {}): string {
  const attrs: string[] = [];
  if (opts.action) attrs.push(`action="${escapeXml(opts.action)}"`);
  attrs.push(`maxLength="${opts.maxLength ?? 120}"`);
  attrs.push(`finishOnKey="${opts.finishOnKey ?? '#'}"`);
  attrs.push(`playBeep="${opts.playBeep !== false}"`);
  if (opts.transcribe) {
    attrs.push('transcribe="true"');
    if (opts.transcribeCallback) attrs.push(`transcribeCallback="${escapeXml(opts.transcribeCallback)}"`);
  }
  return `  <Record ${attrs.join(' ')}/>`;
}

export function play(url: string): string {
  return `  <Play>${escapeXml(url)}</Play>`;
}

export function pause(length = 1): string {
  return `  <Pause length="${length}"/>`;
}

export function dial(
  number: string,
  opts: {
    record?: boolean;
    timeLimit?: number;
    action?: string;
    callerId?: string;
    statusCallback?: string;
    recordingStatusCallback?: string;
  } = {}
): string {
  const attrs: string[] = [];
  if (opts.record) {
    attrs.push('record="record-from-answer-dual"');
    if (opts.recordingStatusCallback) {
      attrs.push(`recordingStatusCallback="${escapeXml(opts.recordingStatusCallback)}"`);
      attrs.push('recordingStatusCallbackEvent="completed"');
    }
  }
  if (opts.timeLimit) attrs.push(`timeLimit="${opts.timeLimit}"`);
  if (opts.action) attrs.push(`action="${escapeXml(opts.action)}"`);
  if (opts.callerId) attrs.push(`callerId="${escapeXml(opts.callerId)}"`);
  if (opts.statusCallback) {
    attrs.push(`statusCallback="${escapeXml(opts.statusCallback)}"`);
    attrs.push('statusCallbackEvent="initiated ringing answered completed"');
  }
  return `  <Dial ${attrs.join(' ')}>\n    <Number>${escapeXml(number)}</Number>\n  </Dial>`;
}

/** Dial a rep using whichever target they have configured.
 *  Priority: sip_uri (free SIP audio) > phone_e164 (PSTN forwarding).
 *  Returns null if neither is set. */
export function dialRep(
  rep: { sip_uri?: string | null; phone_e164?: string | null },
  opts: {
    record?: boolean;
    timeLimit?: number;
    action?: string;
    callerId?: string;
    timeout?: number;
    statusCallback?: string;
    recordingStatusCallback?: string;
  } = {}
): string | null {
  const attrs: string[] = [];
  if (opts.record) {
    attrs.push('record="record-from-answer-dual"');
    if (opts.recordingStatusCallback) {
      attrs.push(`recordingStatusCallback="${escapeXml(opts.recordingStatusCallback)}"`);
      attrs.push('recordingStatusCallbackEvent="completed"');
    }
  }
  if (opts.timeLimit) attrs.push(`timeLimit="${opts.timeLimit}"`);
  if (opts.timeout) attrs.push(`timeout="${opts.timeout}"`);
  if (opts.action) attrs.push(`action="${escapeXml(opts.action)}"`);
  if (opts.callerId) attrs.push(`callerId="${escapeXml(opts.callerId)}"`);
  if (opts.statusCallback) {
    attrs.push(`statusCallback="${escapeXml(opts.statusCallback)}"`);
    attrs.push('statusCallbackEvent="initiated ringing answered completed"');
  }
  const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';

  if (rep.sip_uri && rep.sip_uri.trim()) {
    const uri = rep.sip_uri.trim();
    // Accept either "sip:user@host" or a bare user — if bare, wrap.
    const sipUri = uri.startsWith('sip:') ? uri : `sip:${uri}`;
    return `  <Dial${attrStr}>\n    <Sip>${escapeXml(sipUri)}</Sip>\n  </Dial>`;
  }
  if (rep.phone_e164 && rep.phone_e164.trim()) {
    return `  <Dial${attrStr}>\n    <Number>${escapeXml(rep.phone_e164.trim())}</Number>\n  </Dial>`;
  }
  return null;
}

export function dialClient(
  identity: string,
  opts: {
    record?: boolean;
    timeLimit?: number;
    action?: string;
    callerId?: string;
    timeout?: number;
    sipDomain?: string;
    repGreetingUrl?: string;
    recordingStatusCallback?: string;
  } = {}
): string {
  const attrs: string[] = [];
  if (opts.record) {
    attrs.push('record="record-from-answer-dual"');
    if (opts.recordingStatusCallback) {
      attrs.push(`recordingStatusCallback="${escapeXml(opts.recordingStatusCallback)}"`);
      attrs.push('recordingStatusCallbackEvent="completed"');
    }
  }
  if (opts.timeLimit) attrs.push(`timeLimit="${opts.timeLimit}"`);
  if (opts.action) attrs.push(`action="${escapeXml(opts.action)}"`);
  if (opts.callerId) attrs.push(`callerId="${escapeXml(opts.callerId)}"`);
  if (opts.timeout) attrs.push(`timeout="${opts.timeout}"`);
  if (opts.sipDomain) {
    const sipUri = `sip:${escapeXml(identity)}@${escapeXml(opts.sipDomain)}`;
    const urlAttr = opts.repGreetingUrl ? ` url="${escapeXml(opts.repGreetingUrl)}"` : '';
    return `  <Dial ${attrs.join(' ')}>\n    <Sip${urlAttr}>${sipUri}</Sip>\n  </Dial>`;
  }
  return `  <Dial ${attrs.join(' ')}>\n    <Client>${escapeXml(identity)}</Client>\n  </Dial>`;
}

/** SimRing: dial multiple identities simultaneously — first to answer wins.
 *  When sipDomain is omitted, uses <Client> (Call Fabric websocket notification).
 *  When sipDomain is provided, uses <Sip> routing instead. */
export function dialMultipleClients(
  identities: Array<{ identity: string; repGreetingUrl?: string }>,
  opts: {
    record?: boolean;
    timeLimit?: number;
    action?: string;
    callerId?: string;
    timeout?: number;
    sipDomain?: string;
    recordingStatusCallback?: string;
  }
): string {
  const attrs: string[] = [];
  if (opts.record) {
    attrs.push('record="record-from-answer-dual"');
    if (opts.recordingStatusCallback) {
      attrs.push(`recordingStatusCallback="${escapeXml(opts.recordingStatusCallback)}"`);
      attrs.push('recordingStatusCallbackEvent="completed"');
    }
  }
  if (opts.timeLimit) attrs.push(`timeLimit="${opts.timeLimit}"`);
  if (opts.action) attrs.push(`action="${escapeXml(opts.action)}"`);
  if (opts.callerId) attrs.push(`callerId="${escapeXml(opts.callerId)}"`);
  if (opts.timeout) attrs.push(`timeout="${opts.timeout}"`);
  const nouns = identities.map(({ identity, repGreetingUrl }) => {
    if (opts.sipDomain) {
      const sipUri = `sip:${escapeXml(identity)}@${escapeXml(opts.sipDomain)}`;
      const urlAttr = repGreetingUrl ? ` url="${escapeXml(repGreetingUrl)}"` : '';
      return `    <Sip${urlAttr}>${sipUri}</Sip>`;
    }
    return `    <Client>${escapeXml(identity)}</Client>`;
  }).join('\n');
  return `  <Dial ${attrs.join(' ')}>\n${nouns}\n  </Dial>`;
}

/** <Dial><Conference>roomName</Conference></Dial>. Used to bridge a caller
 *  and a rep into the same audio room. `startOnEnter`/`endOnExit` default to
 *  false so each party joins and only the combined hangup ends it. */
export function dialConference(
  roomName: string,
  opts: {
    startConferenceOnEnter?: boolean;
    endConferenceOnExit?: boolean;
    waitUrl?: string;
    beep?: boolean | 'onEnter' | 'onExit';
    record?: boolean;
    maxParticipants?: number;
    action?: string;
    timeLimit?: number;
    callerId?: string;
    statusCallback?: string;
    recordingStatusCallback?: string;
  } = {}
): string {
  const confAttrs: string[] = [];
  if (opts.startConferenceOnEnter !== undefined) confAttrs.push(`startConferenceOnEnter="${opts.startConferenceOnEnter}"`);
  if (opts.endConferenceOnExit !== undefined) confAttrs.push(`endConferenceOnExit="${opts.endConferenceOnExit}"`);
  if (opts.waitUrl !== undefined) confAttrs.push(`waitUrl="${escapeXml(opts.waitUrl)}"`);
  if (opts.beep !== undefined) confAttrs.push(`beep="${opts.beep}"`);
  if (opts.record) {
    confAttrs.push('record="record-from-start"');
    if (opts.recordingStatusCallback) {
      confAttrs.push(`recordingStatusCallback="${escapeXml(opts.recordingStatusCallback)}"`);
      confAttrs.push('recordingStatusCallbackEvent="completed"');
    }
  }
  if (opts.maxParticipants) confAttrs.push(`maxParticipants="${opts.maxParticipants}"`);

  const dialAttrs: string[] = [];
  if (opts.action) dialAttrs.push(`action="${escapeXml(opts.action)}"`);
  if (opts.timeLimit) dialAttrs.push(`timeLimit="${opts.timeLimit}"`);
  if (opts.callerId) dialAttrs.push(`callerId="${escapeXml(opts.callerId)}"`);
  if (opts.statusCallback) {
    dialAttrs.push(`statusCallback="${escapeXml(opts.statusCallback)}"`);
    dialAttrs.push('statusCallbackEvent="initiated ringing answered completed"');
  }

  return `  <Dial${dialAttrs.length ? ' ' + dialAttrs.join(' ') : ''}>\n    <Conference${confAttrs.length ? ' ' + confAttrs.join(' ') : ''}>${escapeXml(roomName)}</Conference>\n  </Dial>`;
}

export function enqueue(
  queueName: string,
  waitUrlOrOpts?: string | { waitUrl?: string; action?: string; method?: string }
): string {
  const opts = typeof waitUrlOrOpts === 'string'
    ? { waitUrl: waitUrlOrOpts }
    : (waitUrlOrOpts ?? {});
  const attrs: string[] = [];
  if (opts.waitUrl) attrs.push(`waitUrl="${escapeXml(opts.waitUrl)}"`);
  if (opts.action) attrs.push(`action="${escapeXml(opts.action)}"`);
  if (opts.method) attrs.push(`method="${opts.method}"`);
  return `  <Enqueue${attrs.length ? ' ' + attrs.join(' ') : ''}>${escapeXml(queueName)}</Enqueue>`;
}

export function gather(
  opts: {
    input?: string;
    numDigits?: number;
    action?: string;
    timeout?: number;
    finishOnKey?: string;
  },
  innerElements: string[] = []
): string {
  const attrs: string[] = [];
  if (opts.input) attrs.push(`input="${opts.input}"`);
  if (opts.numDigits) attrs.push(`numDigits="${opts.numDigits}"`);
  if (opts.action) attrs.push(`action="${escapeXml(opts.action)}"`);
  if (opts.timeout) attrs.push(`timeout="${opts.timeout}"`);
  if (opts.finishOnKey) attrs.push(`finishOnKey="${opts.finishOnKey}"`);

  if (innerElements.length > 0) {
    return `  <Gather ${attrs.join(' ')}>\n${innerElements.join('\n')}\n  </Gather>`;
  }
  return `  <Gather ${attrs.join(' ')}/>`;
}

export function gatherSpeech(
  opts: {
    action: string;
    timeout?: number;
    speechTimeout?: string;
    language?: string;
  },
  innerElements: string[] = []
): string {
  const attrs: string[] = [
    `input="speech"`,
    `action="${escapeXml(opts.action)}"`,
    `timeout="${opts.timeout ?? 8}"`,
    `speechTimeout="${opts.speechTimeout ?? 'auto'}"`,
    `language="${opts.language ?? 'en-US'}"`,
  ];
  if (innerElements.length > 0) {
    return `  <Gather ${attrs.join(' ')}>\n${innerElements.join('\n')}\n  </Gather>`;
  }
  return `  <Gather ${attrs.join(' ')}/>`;
}

export function hangup(): string {
  return `  <Hangup/>`;
}

export function redirect(url: string): string {
  return `  <Redirect>${escapeXml(url)}</Redirect>`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

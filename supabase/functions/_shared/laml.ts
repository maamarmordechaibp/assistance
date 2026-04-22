// SignalWire LaML XML builder for call flows (Deno-compatible)

export function buildLamlResponse(elements: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${elements.join('\n')}\n</Response>`;
}

// Default to an Amazon Polly Neural voice — much more natural / human-sounding
// than the legacy standard voices. SignalWire exposes these via the same
// `Polly.<Name>-Neural` naming convention Twilio uses.
export function say(text: string, voice = 'Polly.Matthew-Neural'): string {
  return `  <Say voice="${voice}">${escapeXml(text)}</Say>`;
}

/** Speak multiple lines as ONE continuous utterance so the Neural voice's
 *  prosody engine handles pacing naturally (no robotic pauses between
 *  sentences). Returns a single-element array so callers can spread into
 *  their elements list. */
export function sayLines(lines: string[], voice = 'Polly.Matthew-Neural'): string[] {
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
  } = {}
): string {
  const attrs: string[] = [];
  if (opts.record) attrs.push('record="record-from-answer-dual"');
  if (opts.timeLimit) attrs.push(`timeLimit="${opts.timeLimit}"`);
  if (opts.action) attrs.push(`action="${escapeXml(opts.action)}"`);
  if (opts.callerId) attrs.push(`callerId="${escapeXml(opts.callerId)}"`);
  if (opts.statusCallback) {
    attrs.push(`statusCallback="${escapeXml(opts.statusCallback)}"`);
    attrs.push('statusCallbackEvent="initiated ringing answered completed"');
  }
  return `  <Dial ${attrs.join(' ')}>\n    <Number>${escapeXml(number)}</Number>\n  </Dial>`;
}

export function dialClient(
  identity: string,
  opts: {
    record?: boolean;
    timeLimit?: number;
    action?: string;
    callerId?: string;
    timeout?: number;
    // When set, use <Sip> verb (sip:identity@sipDomain) instead of <Client>.
    // Required for Call Fabric SAT subscribers which are not in the legacy
    // LAML/Verto client registry that <Client> checks.
    sipDomain?: string;
    // URL played to the rep when they answer (before caller is connected)
    repGreetingUrl?: string;
  } = {}
): string {
  const attrs: string[] = [];
  if (opts.record) attrs.push('record="record-from-answer-dual"');
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
  }
): string {
  const attrs: string[] = [];
  if (opts.record) attrs.push('record="record-from-answer-dual"');
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

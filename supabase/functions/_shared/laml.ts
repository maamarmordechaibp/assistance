// SignalWire LaML XML builder for call flows (Deno-compatible)

export function buildLamlResponse(elements: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${elements.join('\n')}\n</Response>`;
}

export function say(text: string, voice = 'Polly.Matthew'): string {
  return `  <Say voice="${voice}">${escapeXml(text)}</Say>`;
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
  } = {}
): string {
  const attrs: string[] = [];
  if (opts.record) attrs.push('record="record-from-answer-dual"');
  if (opts.timeLimit) attrs.push(`timeLimit="${opts.timeLimit}"`);
  if (opts.action) attrs.push(`action="${escapeXml(opts.action)}"`);
  if (opts.callerId) attrs.push(`callerId="${escapeXml(opts.callerId)}"`);
  if (opts.timeout) attrs.push(`timeout="${opts.timeout}"`);
  return `  <Dial ${attrs.join(' ')}>\n    <Client>${escapeXml(identity)}</Client>\n  </Dial>`;
}

export function enqueue(queueName: string, waitUrl?: string): string {
  const attrs = waitUrl ? ` waitUrl="${escapeXml(waitUrl)}"` : '';
  return `  <Enqueue${attrs}>${escapeXml(queueName)}</Enqueue>`;
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

// SignalWire REST API helpers (Deno-compatible)

function getProjectId(): string {
  return Deno.env.get('SIGNALWIRE_PROJECT_ID')!;
}

function getApiToken(): string {
  return Deno.env.get('SIGNALWIRE_API_TOKEN')!;
}

function getSpaceUrl(): string {
  return Deno.env.get('SIGNALWIRE_SPACE_URL')!;
}

function getBaseUrl(): string {
  return `https://${getSpaceUrl()}/api/laml/2010-04-01/Accounts/${getProjectId()}`;
}

function getAuthHeader(): string {
  return 'Basic ' + btoa(`${getProjectId()}:${getApiToken()}`);
}

async function swFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const url = `${getBaseUrl()}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      Authorization: getAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(options.headers as Record<string, string> || {}),
    },
  });
}

export async function getCall(callSid: string) {
  const res = await swFetch(`/Calls/${callSid}.json`);
  return res.json();
}

export async function updateCall(
  callSid: string,
  params: { url?: string; method?: string; status?: 'completed' | 'canceled'; timeLimit?: number }
) {
  const body = new URLSearchParams();
  if (params.url) body.set('Url', params.url);
  if (params.method) body.set('Method', params.method);
  if (params.status) body.set('Status', params.status);
  if (params.timeLimit) body.set('TimeLimit', params.timeLimit.toString());
  const res = await swFetch(`/Calls/${callSid}.json`, { method: 'POST', body: body.toString() });
  return res.json();
}

export async function createCall(params: {
  to: string; from: string; url: string; statusCallback?: string; record?: boolean; timeLimit?: number;
}) {
  const body = new URLSearchParams();
  body.set('To', params.to);
  body.set('From', params.from);
  body.set('Url', params.url);
  if (params.statusCallback) body.set('StatusCallback', params.statusCallback);
  if (params.record) body.set('Record', 'true');
  if (params.timeLimit) body.set('TimeLimit', params.timeLimit.toString());
  const res = await swFetch('/Calls.json', { method: 'POST', body: body.toString() });
  return res.json();
}

export async function downloadRecording(recordingUrl: string): Promise<ArrayBuffer> {
  const res = await fetch(recordingUrl, { headers: { Authorization: getAuthHeader() } });
  return res.arrayBuffer();
}

/** Convert an email (or any string) to a valid SignalWire resource identity.
 *  The @ and . chars are invalid in SIP user parts, so replace them. */
export function toSwIdentity(email: string): string {
  return email.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export async function createWebRtcToken(identity: string) {
  const reference = toSwIdentity(identity);
  const spaceUrl = getSpaceUrl();
  const auth = getAuthHeader();

  // Issue a Call Fabric SAT (Subscriber Access Token) via the fabric API.
  // The SAT's 'ch' (channel) field encodes the WebSocket endpoint (puc.signalwire.com)
  // so the v3 SignalWire() client connects to the right host automatically.
  // reference = the Client name in LaML <Dial><Client>reference</Client>.
  const res = await fetch(`https://${spaceUrl}/api/fabric/subscribers/tokens`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference, ttl: 3600 }),
  });
  const data = await res.json();
  // Returns { subscriber_id, token } — we return token as jwt_token for compat
  return { jwt_token: data.token, subscriber_id: data.subscriber_id, ...data };
}

export async function listQueues() {
  const res = await swFetch('/Queues.json');
  return res.json();
}

export async function getQueueMembers(queueSid: string) {
  const res = await swFetch(`/Queues/${queueSid}/Members.json`);
  return res.json();
}

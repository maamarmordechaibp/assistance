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

/** Derive a stable synthetic email and password for a SignalWire Call Fabric
 *  subscriber from its identity. We never send auth emails to these addresses —
 *  they exist only so the Fabric API has the required credential fields. */
function subscriberCreds(identity: string): { reference: string; email: string; password: string } {
  const reference = toSwIdentity(identity);
  // `reference` is what we pass to the /subscribers/tokens endpoint; it "often is an email"
  // so we use the synthetic email directly as the reference to guarantee both
  // endpoints key off the SAME subscriber record.
  const email = `${reference}@webrtc.local`;
  // Deterministic password so repeated calls don't shuffle it. 32 chars of hex
  // derived from identity is within the 8–72 char limit SignalWire requires.
  // (The password lives only in SW; the browser never sees it — the SAT JWT is
  // how the SDK authenticates.)
  const password = `pw_${reference}_webrtc_register_ok`.slice(0, 72);
  return { reference: email, email, password };
}

/** Idempotently create the Call Fabric Subscriber resource.
 *  POST /api/fabric/resources/subscribers requires `email` (the primary id);
 *  it does NOT accept a `reference` field. Calling the tokens endpoint alone
 *  auto-provisions a subscriber keyed by `reference` but with no password set,
 *  which causes `.online()` in the browser SDK to fail with
 *  -32603 "WebRTC endpoint registration failed". */
export async function ensureSubscriber(email: string, password: string): Promise<{ id?: string; created: boolean; error?: string }> {
  const spaceUrl = getSpaceUrl();
  const auth = getAuthHeader();

  // Look up existing subscriber by email (the real primary key on this endpoint).
  try {
    const listRes = await fetch(`https://${spaceUrl}/api/fabric/resources/subscribers?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: auth },
    });
    if (listRes.ok) {
      const listData = await listRes.json();
      const existing = Array.isArray(listData?.data)
        ? listData.data.find((s: { email?: string }) => s.email === email)
        : null;
      if (existing) return { id: existing.id, created: false };
    }
  } catch { /* fall through to create */ }

  const createRes = await fetch(`https://${spaceUrl}/api/fabric/resources/subscribers`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!createRes.ok) {
    const text = await createRes.text().catch(() => '');
    // 422 is returned if the email already exists — treat as success.
    if (createRes.status === 422) return { created: false, error: undefined };
    return { created: false, error: `HTTP ${createRes.status}: ${text}` };
  }
  const created = await createRes.json();
  return { id: created.id, created: true };
}

export async function createWebRtcToken(identity: string) {
  const { reference, email, password } = subscriberCreds(identity);
  const spaceUrl = getSpaceUrl();
  const auth = getAuthHeader();

  // 1) Make sure the subscriber resource exists with a password set.
  const ensure = await ensureSubscriber(email, password);
  if (ensure.error) {
    console.error(`[signalwire] ensureSubscriber(${email}) failed:`, ensure.error);
  } else {
    console.log(`[signalwire] subscriber ${email} ${ensure.created ? 'created' : 'exists'} (id=${ensure.id ?? '?'})`);
  }

  // 2) Issue a Call Fabric SAT (Subscriber Access Token).
  //    We pass `password` again so the field is kept in sync even if the
  //    subscriber was auto-provisioned by an earlier version of this code
  //    without a password — which is what caused the -32603 storm.
  //    `reference` here == the subscriber's email so the tokens endpoint
  //    resolves to the SAME record we just created above.
  const res = await fetch(`https://${spaceUrl}/api/fabric/subscribers/tokens`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference, password }),
  });
  const data = await res.json();
  console.log(`[signalwire] token issued for subscriber_id=${data.subscriber_id}`);
  return { jwt_token: data.token, subscriber_id: data.subscriber_id, ...data };
}

export async function listQueues() {
  const res = await swFetch('/Queues.json');
  return res.json();
}

/** Look up the Call Fabric resource-address path (e.g. `/private/office_foo-xxxxx`)
 *  for a subscriber. SAT subscribers are NOT reachable via plain SIP URIs
 *  (`sip:identity@space` returns 408); they must be addressed through the
 *  Fabric `/private/<name>` path with the SWML `connect` verb.
 *
 *  IMPORTANT: the Fabric address `name` is NOT the subscriber's display_name —
 *  SignalWire auto-suffixes it (e.g. `office_foo-ubdtn`). We must hit
 *  `/api/fabric/resources/subscribers/{id}/addresses` to get the real name. */
export async function getSubscriberAddressPath(identity: string): Promise<string | null> {
  const { email } = subscriberCreds(identity);
  const spaceUrl = getSpaceUrl();
  const auth = getAuthHeader();

  try {
    // 1) Find the subscriber resource by email.
    const listRes = await fetch(`https://${spaceUrl}/api/fabric/resources/subscribers?page_size=200`, {
      headers: { Authorization: auth },
    });
    if (!listRes.ok) {
      console.error(`[signalwire] list subscribers HTTP ${listRes.status}`);
      return `/private/${identity}`;
    }
    const listData = await listRes.json();
    type SubResource = {
      id: string;
      display_name?: string;
      subscriber?: { email?: string };
    };
    const rows: SubResource[] = Array.isArray(listData?.data) ? listData.data : [];
    let match = rows.find((r) => r?.subscriber?.email === email);
    if (!match) match = rows.find((r) => r?.display_name === identity);
    if (!match?.id) {
      console.error(`[signalwire] no subscriber found for ${identity}`);
      return `/private/${identity}`;
    }

    // 2) Fetch that subscriber's address(es) to get the real auto-suffixed name.
    const addrRes = await fetch(
      `https://${spaceUrl}/api/fabric/resources/subscribers/${match.id}/addresses`,
      { headers: { Authorization: auth } },
    );
    if (!addrRes.ok) {
      console.error(`[signalwire] list addresses HTTP ${addrRes.status}`);
      return `/private/${match.display_name || identity}`;
    }
    const addrData = await addrRes.json();
    type Addr = { name?: string; type?: string };
    const addrs: Addr[] = Array.isArray(addrData?.data) ? addrData.data : [];
    const addrName = addrs.find((a) => a?.name)?.name;
    if (!addrName) {
      return `/private/${match.display_name || identity}`;
    }
    return `/private/${addrName}`;
  } catch (e) {
    console.error('[signalwire] getSubscriberAddressPath failed:', e);
    return `/private/${identity}`;
  }
}

export async function getQueueMembers(queueSid: string) {
  const res = await swFetch(`/Queues/${queueSid}/Members.json`);
  return res.json();
}

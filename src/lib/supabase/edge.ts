'use client';

import { createClient } from './client';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Singleton so session state is shared across all edgeFn calls and
// matches whatever the rest of the app already has loaded.
let _client: ReturnType<typeof createClient> | null = null;
function sharedClient() {
  if (!_client) _client = createClient();
  return _client;
}

async function getAccessToken(): Promise<string | null> {
  const supabase = sharedClient();

  // 1. Normal path: session from cookies
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) {
      // If close to expiry, proactively refresh
      const expMs = session.expires_at ? session.expires_at * 1000 : 0;
      if (expMs && expMs - Date.now() < 30_000) {
        const { data: { session: refreshed } } = await supabase.auth.refreshSession();
        if (refreshed?.access_token) return refreshed.access_token;
      }
      return session.access_token;
    }
  } catch (e) {
    console.warn('[edgeFn] getSession threw:', e);
  }

  // 2. Try refreshSession explicitly
  try {
    const { data: { session: refreshed } } = await supabase.auth.refreshSession();
    if (refreshed?.access_token) return refreshed.access_token;
  } catch (e) {
    console.warn('[edgeFn] refreshSession threw:', e);
  }

  // 3. Fallback: restore from sessionStorage (set during login)
  if (typeof sessionStorage !== 'undefined') {
    try {
      const stored = sessionStorage.getItem('sb-session');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.access_token && parsed.refresh_token) {
          const { data } = await supabase.auth.setSession({
            access_token: parsed.access_token,
            refresh_token: parsed.refresh_token,
          });
          if (data.session?.access_token) return data.session.access_token;
        }
      }
    } catch {}
  }

  // 4. Last-ditch: scan localStorage for the supabase-js auth token key
  if (typeof localStorage !== 'undefined') {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (k.startsWith('sb-') && k.endsWith('-auth-token')) {
          const raw = localStorage.getItem(k);
          if (!raw) continue;
          const parsed = JSON.parse(raw);
          const at = parsed?.access_token ?? parsed?.currentSession?.access_token;
          if (at) return at;
        }
      }
    } catch {}
  }

  // 5. Last-ditch: scan document.cookie for the supabase auth token
  if (typeof document !== 'undefined') {
    try {
      const cookies = document.cookie.split(';').map(c => c.trim());
      for (const c of cookies) {
        if (c.startsWith('sb-') && c.includes('-auth-token=')) {
          const eq = c.indexOf('=');
          const val = decodeURIComponent(c.slice(eq + 1));
          // Cookie value may be base64url-prefixed "base64-..."
          let jsonStr = val;
          if (jsonStr.startsWith('base64-')) {
            jsonStr = atob(jsonStr.slice('base64-'.length));
          }
          const parsed = JSON.parse(jsonStr);
          const at = parsed?.access_token ?? parsed?.[0];
          if (typeof at === 'string' && at.length > 20) return at;
        }
      }
    } catch {}
  }

  return null;
}

export async function edgeFn(
  functionName: string,
  options: RequestInit & { params?: Record<string, string> } = {}
): Promise<Response> {
  const { params, ...fetchOptions } = options;

  let url = `${SUPABASE_URL}/functions/v1/${functionName}`;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += `?${qs}`;
  }

  const token = await getAccessToken();
  if (!token) {
    console.warn(`[edgeFn] No access token available when calling ${functionName}`);
  }

  const headers = new Headers(fetchOptions.headers);
  headers.set('apikey', SUPABASE_ANON_KEY);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!headers.has('Content-Type') && fetchOptions.body && typeof fetchOptions.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(url, { ...fetchOptions, headers });
  return response;
}

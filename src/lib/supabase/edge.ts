'use client';

import { createClient } from './client';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Fallback: read access_token directly from auth cookies
function getTokenFromCookies(): string | null {
  if (typeof document === 'undefined') return null;
  const cookies = document.cookie.split(';').map(c => c.trim());
  const chunks: { name: string; value: string }[] = [];
  for (const cookie of cookies) {
    const eqIdx = cookie.indexOf('=');
    if (eqIdx === -1) continue;
    const name = cookie.substring(0, eqIdx);
    const value = cookie.substring(eqIdx + 1);
    if (name.startsWith('sb-') && name.includes('-auth-token')) {
      chunks.push({ name, value: decodeURIComponent(value) });
    }
  }
  if (chunks.length === 0) return null;
  chunks.sort((a, b) => a.name.localeCompare(b.name));
  const combined = chunks.map(c => c.value).join('');
  try {
    const session = JSON.parse(combined);
    return session?.access_token ?? null;
  } catch {
    return null;
  }
}

async function getAccessToken(): Promise<string | null> {
  const supabase = createClient();

  // Try Supabase client first
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) {
    const expiresAt = session.expires_at ?? 0;
    const nowSecs = Math.floor(Date.now() / 1000);
    if (expiresAt > nowSecs + 60) {
      return session.access_token;
    }
  }

  // Supabase client didn't return a session — try refreshing
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    const { data: { session: refreshed } } = await supabase.auth.getSession();
    if (refreshed?.access_token) return refreshed.access_token;
  }

  // Last resort: read directly from cookies
  const cookieToken = getTokenFromCookies();
  console.log('[edgeFn] token source:', session ? 'session' : user ? 'refresh' : cookieToken ? 'cookie-fallback' : 'NONE',
    '| cookies:', typeof document !== 'undefined' ? document.cookie.split(';').filter(c => c.includes('auth')).length : 0);
  return cookieToken;
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

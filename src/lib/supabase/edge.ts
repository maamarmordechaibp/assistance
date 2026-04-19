'use client';

import { createClient } from './client';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Module-level flag to prevent multiple simultaneous auth redirects
let redirecting = false;

async function getAccessToken(): Promise<string | null> {
  const supabase = createClient();

  // First try getSession — fast, from memory
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) {
    const expiresAt = session.expires_at ?? 0;
    const nowSecs = Math.floor(Date.now() / 1000);
    if (expiresAt > nowSecs + 60) {
      return session.access_token;
    }
  }

  // Token missing or about to expire — force a refresh via getUser()
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: { session: refreshed } } = await supabase.auth.getSession();
  return refreshed?.access_token ?? null;
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

  // If unauthorized and not already redirecting, sign out (clear stale cookies)
  // then redirect to login. Without signOut the middleware would see the old
  // cookie, think the user is logged in, and bounce right back → infinite loop.
  if (
    response.status === 401 &&
    typeof window !== 'undefined' &&
    !redirecting &&
    !window.location.pathname.startsWith('/login')
  ) {
    redirecting = true;
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  return response;
}

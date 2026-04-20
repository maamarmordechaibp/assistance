'use client';

import { createClient } from './client';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

async function getAccessToken(): Promise<string | null> {
  const supabase = createClient();

  // 1. Try Supabase client's getSession (reads from cookies)
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) return session.access_token;

  // 2. Try refreshing the session
  const { data: { session: refreshed } } = await supabase.auth.refreshSession();
  if (refreshed?.access_token) return refreshed.access_token;

  // 3. Fallback: restore from sessionStorage (set during login)
  if (typeof sessionStorage !== 'undefined') {
    try {
      const stored = sessionStorage.getItem('sb-session');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.access_token && parsed.refresh_token) {
          // Restore the session into the Supabase client
          const { data } = await supabase.auth.setSession({
            access_token: parsed.access_token,
            refresh_token: parsed.refresh_token,
          });
          if (data.session?.access_token) {
            return data.session.access_token;
          }
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

'use client';

import { createClient } from './client';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Get a valid access token from the Supabase client.
 * getSession() reads from memory/cookies and may return an expired token.
 * getUser() forces a round-trip to GoTrue which refreshes the token if needed.
 */
async function getAccessToken(): Promise<string | null> {
  const supabase = createClient();

  // First try getSession — fast, from memory
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) {
    // Check if token expires in the next 60 seconds
    const expiresAt = session.expires_at ?? 0;
    const nowSecs = Math.floor(Date.now() / 1000);
    if (expiresAt > nowSecs + 60) {
      return session.access_token;
    }
  }

  // Token missing or about to expire — force a refresh via getUser()
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  // After getUser refreshes the token, getSession should have the new one
  const { data: { session: refreshed } } = await supabase.auth.getSession();
  return refreshed?.access_token ?? null;
}

/**
 * Call a Supabase Edge Function with the current user's auth token.
 */
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

  // If unauthorized, the session has expired — redirect to login
  if (response.status === 401 && typeof window !== 'undefined') {
    window.location.href = '/login';
  }

  return response;
}

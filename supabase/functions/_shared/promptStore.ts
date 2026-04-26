// Read-through cache for editable IVR prompts. Fetches all rows from
// `ivr_prompts` once per process and resolves keys with a hardcoded
// fallback so the IVR keeps working before/while migrations are run and
// admin edits take effect within a few minutes (per-instance cache).

import { createServiceClient } from './supabase.ts';

let cache: Record<string, string> | null = null;
let cachedAt = 0;
const TTL_MS = 60_000; // 1 minute — admin edits propagate quickly.

async function load(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cache && now - cachedAt < TTL_MS) return cache;
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from('ivr_prompts')
      .select('key, text');
    if (error) {
      // Table missing? Stay on fallbacks until migration is run.
      cache = cache ?? {};
      cachedAt = now;
      return cache;
    }
    const map: Record<string, string> = {};
    for (const row of data ?? []) map[row.key as string] = (row.text as string) ?? '';
    cache = map;
    cachedAt = now;
    return cache;
  } catch {
    cache = cache ?? {};
    cachedAt = now;
    return cache;
  }
}

/** Get a prompt's lines (split on \n). Returns the fallback's lines if the
 *  prompt key is not in the database (or the table doesn't exist yet). */
export async function promptLines(
  key: string,
  fallback: string[],
  vars: Record<string, string> = {}
): Promise<string[]> {
  const map = await load();
  const raw = (map[key] ?? '').trim();
  const source = raw.length > 0 ? raw : fallback.join('\n');
  const filled = Object.entries(vars).reduce(
    (acc, [k, v]) => acc.split(`{${k}}`).join(v),
    source
  );
  return filled.split('\n').map(s => s.trim()).filter(Boolean);
}

/** Same as promptLines but returns one joined string. */
export async function promptText(
  key: string,
  fallback: string,
  vars: Record<string, string> = {}
): Promise<string> {
  const lines = await promptLines(key, [fallback], vars);
  return lines.join(' ');
}

export function invalidatePromptCache(): void {
  cache = null;
  cachedAt = 0;
}

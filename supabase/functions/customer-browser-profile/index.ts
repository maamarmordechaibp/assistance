// Edge Function: customer-browser-profile
//
// Coordinates the local-Chrome shared-profile flow run by the rep's PC
// (`tools/offline-browser-launcher/launcher.ps1`).
//
//   POST   { action:'acquire',   customerId, hostname }
//        → atomically locks the customer's profile to this rep, returns:
//          { ok, lock_token, ttl_seconds, download_url, has_blob }
//          409 if held by another rep (returns { holder })
//
//   POST   { action:'heartbeat', customerId, lock_token }
//        → extends the lock TTL by ttl_seconds. Called every 60s while
//          Chrome is running.
//
//   POST   { action:'release',   customerId, lock_token, upload? }
//        → releases the lock. If upload=true, also returns a signed PUT
//          URL the launcher can use to upload the new profile zip.
//
//   POST   { action:'commit',    customerId, lock_token, size_bytes,
//                                  chrome_version }
//        → tells us the upload finished; updates the blobs metadata row.
//
//   POST   { action:'capture-credentials',
//                                  customerId, lock_token,
//                                  credentials:[ {origin_url, signon_realm,
//                                                  username, password} ] }
//        → server-side encrypts & upserts into customer_credentials.
//          Called by the launcher after it decrypts Chrome's Login Data
//          on the rep's local PC (DPAPI).
//
//   POST   { action:'force-unlock', customerId } [admin only]
//        → clears the lock no matter who holds it. Logs an event.
//
//   GET    ?customerId=…
//        → { lock, last_blob }   (UI uses this to render "in use by Sarah").
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createUserClient, createServiceClient, getUser } from '../_shared/supabase.ts';
import { encrypt } from '../_shared/vault.ts';

const BUCKET = 'customer-browser-profiles';
const TTL_SECONDS = 600;          // 10 min default; heartbeat extends.
const SIGNED_URL_TTL = 600;
const PROFILE_PATH = (id: string) => `customer/${id}/profile.zip`;

function jres(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function audit(
  svc: ReturnType<typeof createServiceClient>,
  args: { customerId: string; repId?: string; pc?: string; action: string; detail?: unknown },
) {
  await svc.from('customer_browser_profile_events').insert({
    customer_id: args.customerId,
    rep_id: args.repId ?? null,
    pc_hostname: args.pc ?? null,
    action: args.action,
    detail: args.detail ?? null,
  }).then(() => {}).catch(() => {});
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  const user = await getUser(req);
  if (!user) return jres({ error: 'unauthorized' }, 401);

  const userClient = createUserClient(req);
  const { data: rep } = await userClient.from('reps').select('id, full_name').eq('id', user.id).maybeSingle();

  // Admin override is allowed to call force-unlock without being a rep.
  const role = (user.app_metadata as { role?: string } | undefined)?.role;
  const isAdmin = role === 'admin';
  if (!rep && !isAdmin) return jres({ error: 'rep only' }, 403);

  const svc = createServiceClient();

  // ─ GET: status ────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const customerId = url.searchParams.get('customerId') || '';
    if (!customerId) return jres({ error: 'customerId required' }, 400);
    const { data: lock } = await svc.from('customer_browser_profile_locks')
      .select('*, holder:reps!customer_browser_profile_locks_holder_rep_id_fkey(id, full_name)')
      .eq('customer_id', customerId).maybeSingle();
    const { data: blob } = await svc.from('customer_browser_profile_blobs')
      .select('*').eq('customer_id', customerId).maybeSingle();
    return jres({ lock, blob });
  }

  if (req.method !== 'POST') return jres({ error: 'method not allowed' }, 405);

  const body = await req.json().catch(() => ({}));
  const action: string = body.action || '';
  const customerId: string = body.customerId;
  if (!customerId) return jres({ error: 'customerId required' }, 400);

  // ─ acquire ────────────────────────────────────────────────────────
  if (action === 'acquire') {
    if (!rep) return jres({ error: 'rep only' }, 403);
    const hostname: string = (body.hostname || '').slice(0, 200);

    // Use the SQL helper which clears stale locks first and inserts atomically.
    const { data: lockRow, error: lockErr } = await svc.rpc('acquire_customer_browser_profile_lock', {
      p_customer_id: customerId,
      p_rep_id: rep.id,
      p_hostname: hostname,
      p_ttl_seconds: TTL_SECONDS,
    });
    if (lockErr) {
      console.error('[customer-browser-profile] acquire rpc:', lockErr);
      return jres({ error: 'acquire failed', detail: lockErr.message }, 500);
    }
    const lock = (Array.isArray(lockRow) ? lockRow[0] : lockRow) as
      | { customer_id: string; holder_rep_id: string; lock_token: string; expires_at: string; holder_pc_hostname: string }
      | null;
    if (!lock) return jres({ error: 'acquire failed (no row)' }, 500);

    // If someone else is already holding it, refuse.
    if (lock.holder_rep_id !== rep.id) {
      const { data: holder } = await svc.from('reps')
        .select('id, full_name').eq('id', lock.holder_rep_id).maybeSingle();
      await audit(svc, { customerId, repId: rep.id, pc: hostname, action: 'blocked',
                         detail: { holder_rep_id: lock.holder_rep_id } });
      return jres({
        error: 'locked',
        holder: holder ? { id: holder.id, full_name: holder.full_name } : null,
        holder_pc: lock.holder_pc_hostname,
        expires_at: lock.expires_at,
      }, 409);
    }

    // Got the lock. Generate a signed download URL if a blob exists.
    let download_url: string | null = null;
    let has_blob = false;
    const { data: blob } = await svc.from('customer_browser_profile_blobs')
      .select('storage_path').eq('customer_id', customerId).maybeSingle();
    if (blob?.storage_path) {
      const { data: signed } = await svc.storage.from(BUCKET)
        .createSignedUrl(blob.storage_path, SIGNED_URL_TTL);
      if (signed?.signedUrl) {
        download_url = signed.signedUrl;
        has_blob = true;
      }
    }

    await audit(svc, { customerId, repId: rep.id, pc: hostname, action: 'acquire',
                       detail: { has_blob } });

    return jres({
      ok: true,
      lock_token: lock.lock_token,
      ttl_seconds: TTL_SECONDS,
      heartbeat_seconds: 60,
      expires_at: lock.expires_at,
      has_blob,
      download_url,
      upload_path: PROFILE_PATH(customerId),
    });
  }

  // ─ heartbeat ──────────────────────────────────────────────────────
  if (action === 'heartbeat') {
    if (!rep) return jres({ error: 'rep only' }, 403);
    const lockToken: string = body.lock_token;
    if (!lockToken) return jres({ error: 'lock_token required' }, 400);
    const { data: updated, error } = await svc.from('customer_browser_profile_locks')
      .update({
        last_heartbeat_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + TTL_SECONDS * 1000).toISOString(),
      })
      .eq('customer_id', customerId)
      .eq('holder_rep_id', rep.id)
      .eq('lock_token', lockToken)
      .select('expires_at').maybeSingle();
    if (error) return jres({ error: 'heartbeat failed', detail: error.message }, 500);
    if (!updated) return jres({ error: 'lock lost' }, 410);
    return jres({ ok: true, expires_at: updated.expires_at });
  }

  // ─ release ────────────────────────────────────────────────────────
  if (action === 'release') {
    if (!rep) return jres({ error: 'rep only' }, 403);
    const lockToken: string = body.lock_token;
    if (!lockToken) return jres({ error: 'lock_token required' }, 400);

    let upload_url: string | null = null;
    if (body.upload) {
      // Signed URL for resumable PUT — launcher uploads the trimmed zip.
      const path = PROFILE_PATH(customerId);
      const { data: signed } = await svc.storage.from(BUCKET)
        .createSignedUploadUrl(path);
      upload_url = signed?.signedUrl || null;
    }

    const { data: deleted } = await svc.from('customer_browser_profile_locks')
      .delete()
      .eq('customer_id', customerId)
      .eq('holder_rep_id', rep.id)
      .eq('lock_token', lockToken)
      .select().maybeSingle();
    await audit(svc, { customerId, repId: rep.id, action: 'release',
                       detail: { had_lock: !!deleted, with_upload: !!body.upload } });
    return jres({ ok: true, upload_url, upload_path: PROFILE_PATH(customerId) });
  }

  // ─ commit (after upload finishes) ────────────────────────────────
  if (action === 'commit') {
    if (!rep) return jres({ error: 'rep only' }, 403);
    const path = PROFILE_PATH(customerId);
    await svc.from('customer_browser_profile_blobs').upsert({
      customer_id: customerId,
      last_uploaded_at: new Date().toISOString(),
      last_uploaded_by: rep.id,
      size_bytes: Number(body.size_bytes) || null,
      chrome_version: (body.chrome_version || '').slice(0, 64) || null,
      storage_path: path,
    }, { onConflict: 'customer_id' });
    await audit(svc, { customerId, repId: rep.id, action: 'upload',
                       detail: { size_bytes: body.size_bytes, chrome_version: body.chrome_version } });
    return jres({ ok: true });
  }

  // ─ capture-credentials ───────────────────────────────────────────
  if (action === 'capture-credentials') {
    if (!rep) return jres({ error: 'rep only' }, 403);
    const lockToken: string = body.lock_token;
    if (!lockToken) return jres({ error: 'lock_token required' }, 400);

    // Verify caller still holds the lock.
    const { data: lock } = await svc.from('customer_browser_profile_locks')
      .select('lock_token, holder_rep_id').eq('customer_id', customerId).maybeSingle();
    if (!lock || lock.lock_token !== lockToken || lock.holder_rep_id !== rep.id) {
      return jres({ error: 'lock invalid' }, 410);
    }

    const creds: Array<{ origin_url?: string; signon_realm?: string; username?: string; password?: string }> =
      Array.isArray(body.credentials) ? body.credentials : [];
    if (creds.length === 0) return jres({ ok: true, captured: 0 });

    // Encryption + upsert: use the same AES-GCM scheme as the existing
    // vault-credentials function (key = VAULT_ENCRYPTION_KEY) so that
    // captured passwords show up alongside manually-entered ones and can
    // be decrypted by vault-credentials-copy. The plaintext only crosses
    // launcher → edge fn (TLS) and never touches a log.
    const encB64 = async (s: string) => {
      const u8 = await encrypt(s);
      return btoa(String.fromCharCode(...u8));
    };
    let captured = 0;
    for (const c of creds) {
      const password = (c.password || '').trim();
      if (!password) continue;
      const username = c.username || null;
      const service = (c.origin_url || c.signon_realm || '').replace(/^https?:\/\//, '').split('/')[0] || 'unknown';
      let encrypted_password: string;
      try {
        encrypted_password = await encB64(password);
      } catch (e) {
        console.error('[customer-browser-profile] encrypt failed:', (e as Error).message);
        return jres({ error: 'encryption misconfigured (VAULT_ENCRYPTION_KEY)' }, 500);
      }
      const { error: upErr } = await svc.from('customer_credentials').upsert({
        customer_id: customerId,
        service_name: service,
        username,
        encrypted_password,
        origin_url: c.origin_url || null,
        signon_realm: c.signon_realm || null,
        source: 'browser_capture',
        captured_by_rep_id: rep.id,
        captured_at: new Date().toISOString(),
      }, { onConflict: 'customer_id,service_name,username' });
      if (upErr) {
        // Unique index uses COALESCE on nullable columns; fall back to
        // a manual select+update if the upsert can't match.
        if (upErr.message?.includes('no unique or exclusion constraint')) {
          const { data: existing } = await svc.from('customer_credentials')
            .select('id')
            .eq('customer_id', customerId)
            .eq('service_name', service)
            .eq('username', username || '')
            .maybeSingle();
          if (existing) {
            await svc.from('customer_credentials').update({
              encrypted_password,
              origin_url: c.origin_url || null,
              signon_realm: c.signon_realm || null,
              captured_by_rep_id: rep.id,
              captured_at: new Date().toISOString(),
            }).eq('id', existing.id);
          } else {
            await svc.from('customer_credentials').insert({
              customer_id: customerId,
              service_name: service,
              username,
              encrypted_password,
              origin_url: c.origin_url || null,
              signon_realm: c.signon_realm || null,
              source: 'browser_capture',
              captured_by_rep_id: rep.id,
              captured_at: new Date().toISOString(),
            });
          }
        } else {
          console.error('[customer-browser-profile] capture upsert failed:', upErr.message);
          continue;
        }
      }
      captured++;
    }

    await audit(svc, { customerId, repId: rep.id, action: 'upload',
                       detail: { captured_credentials: captured, total: creds.length } });

    return jres({ ok: true, captured, total: creds.length });
  }

  // ─ force-unlock (admin) ──────────────────────────────────────────
  if (action === 'force-unlock') {
    if (!isAdmin) return jres({ error: 'admin only' }, 403);
    const { data: prior } = await svc.from('customer_browser_profile_locks')
      .select('holder_rep_id, holder_pc_hostname').eq('customer_id', customerId).maybeSingle();
    await svc.from('customer_browser_profile_locks').delete().eq('customer_id', customerId);
    await audit(svc, { customerId, repId: user.id, action: 'force_unlock',
                       detail: { prior_holder: prior?.holder_rep_id, prior_pc: prior?.holder_pc_hostname } });
    return jres({ ok: true });
  }

  return jres({ error: 'unknown action' }, 400);
});

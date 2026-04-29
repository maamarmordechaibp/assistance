# Cloudflare Email Worker — `offlinesbrowse.com` inbound

Replaces the broken Resend Inbound webhook (which only delivers metadata for
emails containing inline images). Cloudflare Email Routing gives us the full
RFC822 source; we parse it with `postal-mime` and POST a normalized JSON
payload to the existing `email-inbound` Supabase Edge Function.

The Edge Function already has a `fromCloudflare` parser branch — no server
changes are required.

## One-time setup

### 1. Add `offlinesbrowse.com` to Cloudflare (if not already)

Cloudflare dashboard → **Add a site** → enter `offlinesbrowse.com` → Free plan.
Update the registrar's nameservers to the two Cloudflare nameservers shown.
Wait for "Active" status (usually 5–60 min).

### 2. Enable Email Routing

Dashboard → `offlinesbrowse.com` → **Email** → **Email Routing** → **Get
started**. Cloudflare will offer to add the required MX + TXT records
automatically — accept.

> Important: this **replaces** Resend's MX records. Disable the inbound rule
> in the Resend dashboard afterwards so you don't get duplicate processing.

### 3. Deploy the Worker

```powershell
cd E:\assistance\assistance\tools\cloudflare-email-worker
npm install
npx wrangler login          # opens browser, sign in to Cloudflare
npx wrangler deploy

# Set secrets
"https://rrwgjrixvlyuxjijnavx.supabase.co/functions/v1/email-inbound" | npx wrangler secret put INBOUND_URL
$env:EMAIL_INBOUND_SECRET | npx wrangler secret put EMAIL_INBOUND_SECRET
```

`EMAIL_INBOUND_SECRET` must match the value already set on the Supabase
function (currently `76bd7…`). Retrieve from Supabase dashboard → Project
Settings → Edge Functions → Secrets if needed.

### 4. Route mail to the Worker

Dashboard → Email → Email Routing → **Routes**:

- **Custom addresses**: add the platform mailboxes (or one catch-all):
  - `office@offlinesbrowse.com` → Action: **Send to a Worker** → `offlinesbrowse-email`
  - `complaints@offlinesbrowse.com` → same Worker
  - `admin@offlinesbrowse.com` → same Worker
  - `support@offlinesbrowse.com` (if used) → same Worker
- Or add a **Catch-all** rule → Send to Worker → `offlinesbrowse-email`.

### 5. Test

Send a test email from any external account to `office@offlinesbrowse.com`.

- Tail logs: `npx wrangler tail`
- Check `/admin/platform-inbox` — body should now appear.
- Check raw payload viewer: `data.text` and `data.html` will be populated.

## Updates

```powershell
cd E:\assistance\assistance\tools\cloudflare-email-worker
npx wrangler deploy
```

## Troubleshooting

- **403 from Supabase**: `EMAIL_INBOUND_SECRET` mismatch. Re-set with
  `wrangler secret put EMAIL_INBOUND_SECRET`.
- **Worker not invoked**: confirm the address has a "Send to Worker" route
  (not "Forward to address"). Catch-all takes precedence only if no specific
  match exists.
- **Resend still receiving**: MX records still point to Resend. Recheck the
  domain's DNS in the Cloudflare dashboard — the MX entries should read
  `route1.mx.cloudflare.net`, `route2.mx.cloudflare.net`,
  `route3.mx.cloudflare.net`.

## Cost

Cloudflare Email Routing + Workers free tier: 100,000 Worker invocations/day,
unlimited inbound emails. Sufficient indefinitely for this workload.

# Supabase Edge Functions - Secrets Configuration

The following secrets must be set in Supabase for Edge Functions to work.
Supabase automatically provides `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`.

## Required Secrets

Set these via Supabase Dashboard > Project Settings > Edge Functions > Secrets,
or via the Supabase CLI:

```bash
# SignalWire VOIP
supabase secrets set SIGNALWIRE_PROJECT_ID="your-project-id"
supabase secrets set SIGNALWIRE_API_TOKEN="your-api-token"
supabase secrets set SIGNALWIRE_SPACE_URL="yourspace.signalwire.com"

# OpenAI (for call transcription & analysis)
supabase secrets set OPENAI_API_KEY="sk-..."

# Sola/Cardknox Payment Gateway
supabase secrets set SOLA_XKEY="your-cardknox-key"
# Optional sandbox key for testing:
supabase secrets set SOLA_SANDBOX_XKEY="your-sandbox-key"

# Vault Encryption (AES-256-GCM, 64-char hex string)
supabase secrets set VAULT_ENCRYPTION_KEY="your-64-char-hex-key"
```

## Edge Functions Mapping

| Edge Function | Replaces Next.js Route | Methods |
|---|---|---|
| `auth-login` | `/api/auth/login` | POST |
| `setup` | `/api/setup` | POST |
| `calls` | `/api/calls` | GET, PATCH |
| `customers` | `/api/customers` | GET, POST, PATCH |
| `reps-me` | `/api/reps/me` | GET, PATCH |
| `ledger` | `/api/ledger` | GET, POST |
| `callbacks` | `/api/callbacks` | GET, PATCH |
| `payments-process` | `/api/payments/process` | POST |
| `settings` | `/api/settings` | GET, PATCH |
| `ai-analyze` | `/api/ai/analyze` | POST |
| `vault-credentials` | `/api/vault/credentials` | GET, POST |
| `vault-credentials-copy` | `/api/vault/credentials/copy` | POST |
| `admin-users` | `/api/admin/users` | GET, POST, PATCH, DELETE |
| `sw-inbound` | `/api/signalwire/inbound` | POST (webhook) |
| `sw-status` | `/api/signalwire/status` | POST (webhook) |
| `sw-queue-wait` | `/api/signalwire/queue-wait` | POST (webhook) |
| `sw-callback-choice` | `/api/signalwire/callback-choice` | POST (webhook) |
| `sw-recording-complete` | `/api/signalwire/recording-complete` | POST (webhook) |
| `sw-payment-gather` | `/api/signalwire/payment-gather` | POST (webhook) |
| `sw-transcription` | `/api/signalwire/transcription` | POST (internal) |

## Deploying Edge Functions

```bash
# Deploy all functions
supabase functions deploy

# Deploy a single function
supabase functions deploy calls
supabase functions deploy sw-inbound

# Deploy with --no-verify-jwt for webhook functions (SignalWire calls these directly)
supabase functions deploy sw-inbound --no-verify-jwt
supabase functions deploy sw-status --no-verify-jwt
supabase functions deploy sw-queue-wait --no-verify-jwt
supabase functions deploy sw-callback-choice --no-verify-jwt
supabase functions deploy sw-recording-complete --no-verify-jwt
supabase functions deploy sw-payment-gather --no-verify-jwt
supabase functions deploy sw-transcription --no-verify-jwt
```

## SignalWire Webhook URLs

After deploying, update your SignalWire phone number webhooks to:

- **Voice URL**: `https://rrwgjrixvlyuxjijnavx.supabase.co/functions/v1/sw-inbound`
- **Status Callback**: `https://rrwgjrixvlyuxjijnavx.supabase.co/functions/v1/sw-status`
- **Recording Status Callback**: `https://rrwgjrixvlyuxjijnavx.supabase.co/functions/v1/sw-recording-complete`

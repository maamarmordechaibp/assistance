// One-shot SQL runner with verbose error output.
// Usage: SUPABASE_DB_PASSWORD=... node scripts/run-sql-verbose.mjs <path>
import pg from 'pg';
import { readFileSync } from 'fs';
import dns from 'dns';
// Prefer IPv6 — Supabase direct host has only AAAA records.
dns.setDefaultResultOrder('ipv6first');

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/run-sql-verbose.mjs <path>'); process.exit(1); }
if (!process.env.SUPABASE_DB_PASSWORD) { console.error('SUPABASE_DB_PASSWORD required'); process.exit(1); }

const sql = readFileSync(file, 'utf-8');
const pwd = encodeURIComponent(process.env.SUPABASE_DB_PASSWORD);
// Resolve direct host via AAAA, embed IPv6 literal so pg skips lookup.
let directHost = 'db.rrwgjrixvlyuxjijnavx.supabase.co';
try {
  const aaaa = await dns.promises.resolve6(directHost);
  if (aaaa[0]) directHost = `[${aaaa[0]}]`;
  console.log(`Resolved direct host -> ${directHost}`);
} catch (e) { console.log('AAAA lookup failed:', e.message); }

const regions = ['us-east-1','us-east-2','us-west-1','us-west-2','eu-central-1','eu-west-1','eu-west-2','eu-west-3','ap-southeast-1','ap-southeast-2','ap-northeast-1','ap-northeast-2','ap-south-1','sa-east-1','ca-central-1'];
const candidates = [
  `postgresql://postgres:${pwd}@${directHost}:5432/postgres`,
];
for (const r of regions) {
  for (const idx of ['0','1']) {
    candidates.push(`postgresql://postgres.rrwgjrixvlyuxjijnavx:${pwd}@aws-${idx}-${r}.pooler.supabase.com:6543/postgres`);
  }
}

let client;
let lastErr;
for (const cs of candidates) {
  try {
    console.log(`cting: ${cs.replace(/:[^:@]+@/, ':***@')}`);
    client = new pg.Client({ connectionString: cs, ssl: { rejectUnauthorized: false }, lookup: (host, opts, cb) => dns.lookup(host, { family: 0, all: false, hints: 0 }, cb) });
    await client.connect();
    console.log('Connected.');
    break;
  } catch (e) {
    console.log(`  -> ${e.message}`);
    lastErr = e;
    client = null;
    // Stop scanning if it's clearly a network error rather than tenant mismatch
    if (e.message.includes('ENETUNREACH')) continue;
  }
}
if (!client) { console.error('All connection attempts failed:', lastErr?.message); process.exit(2); }

try {
  console.log(`Running ${file}...`);
  await client.query(sql);
  console.log(`✓ Applied ${file}`);
} catch (err) {
  console.error(`✗ Failed: ${err.message}`);
  if (err.position) console.error('  position:', err.position);
  if (err.detail) console.error('  detail:', err.detail);
  if (err.hint) console.error('  hint:', err.hint);
  process.exitCode = 1;
} finally {
  await client.end();
}

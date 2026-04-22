// One-shot: apply a single migration file against the Supabase DB.
// Usage: SUPABASE_DB_PASSWORD=... node scripts/run-single-migration.mjs supabase/migrations/20260422_call_queue.sql
import pg from 'pg';
import { readFileSync } from 'fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/run-single-migration.mjs <path-to-sql>');
  process.exit(1);
}
if (!process.env.SUPABASE_DB_PASSWORD) {
  console.error('SUPABASE_DB_PASSWORD env var is required');
  process.exit(1);
}

const sql = readFileSync(file, 'utf-8');

async function tryConnect(connStr) {
  const c = new pg.Client({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

const pooler = `postgresql://postgres.rrwgjrixvlyuxjijnavx:${process.env.SUPABASE_DB_PASSWORD}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
const direct = `postgresql://postgres:${process.env.SUPABASE_DB_PASSWORD}@db.rrwgjrixvlyuxjijnavx.supabase.co:5432/postgres`;

let client;
try {
  client = await tryConnect(pooler);
  console.log('Connected (pooler)');
} catch (e) {
  console.log('Pooler failed, trying direct...');
  client = await tryConnect(direct);
  console.log('Connected (direct)');
}

try {
  await client.query(sql);
  console.log(`✓ Applied ${file}`);
} catch (err) {
  console.error(`✗ Failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}

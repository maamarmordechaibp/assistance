// Apply a migration via the Supabase Management API.
//   Usage: SUPABASE_ACCESS_TOKEN=... node scripts/apply-migration-mgmt.mjs <project-ref> <path-to-sql>
import { readFileSync } from 'fs';

const [, , ref, file] = process.argv;
if (!ref || !file) { console.error('Usage: node apply-migration-mgmt.mjs <project-ref> <sql>'); process.exit(1); }
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) { console.error('SUPABASE_ACCESS_TOKEN env var required'); process.exit(1); }

const sql = readFileSync(file, 'utf-8');
const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`✗ ${file}\n  HTTP ${res.status}\n  ${text}`);
  process.exit(1);
}
console.log(`✓ Applied ${file}`);
console.log('  ', text.slice(0, 500));

// Run SQL on a Supabase project via the Management API.
// Usage: SUPABASE_PAT=sbp_... node scripts/run-sql-mgmt-api.mjs <project-ref> <file.sql>
import { readFileSync } from 'fs';

const [, , projectRef, file] = process.argv;
if (!projectRef || !file) { console.error('Usage: node scripts/run-sql-mgmt-api.mjs <project-ref> <file.sql>'); process.exit(1); }
const pat = process.env.SUPABASE_PAT;
if (!pat) { console.error('SUPABASE_PAT required'); process.exit(1); }

const sql = readFileSync(file, 'utf-8');
const url = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;

console.log(`POST ${url}`);
console.log(`Bytes: ${sql.length}`);

const res = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});

const text = await res.text();
if (!res.ok) {
  console.error(`HTTP ${res.status} ${res.statusText}`);
  console.error(text);
  process.exit(2);
}
console.log(`HTTP ${res.status}`);
let parsed;
try { parsed = JSON.parse(text); } catch { parsed = text; }
console.log(typeof parsed === 'string' ? parsed.slice(0, 4000) : JSON.stringify(parsed, null, 2).slice(0, 4000));
console.log(`✓ Applied ${file}`);

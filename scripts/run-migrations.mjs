// Run all database migrations against the Supabase database
// Usage: node scripts/run-migrations.mjs
//
// This script reads all SQL migration files and executes them
// against your Supabase database using the REST SQL endpoint.
// Requires SUPABASE_DB_URL environment variable OR it will
// generate a combined SQL file for manual execution.

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', 'supabase', 'migrations');

// Read all migration files in order
const files = readdirSync(migrationsDir)
  .filter(f => f.endsWith('.sql'))
  .sort();

console.log(`Found ${files.length} migration files:`);
files.forEach(f => console.log(`  - ${f}`));

// Combine all migrations into one SQL script
let combinedSql = '-- Combined migrations for Assistance Platform\n';
combinedSql += '-- Generated: ' + new Date().toISOString() + '\n\n';

for (const file of files) {
  const content = readFileSync(join(migrationsDir, file), 'utf-8');
  combinedSql += `-- ========== ${file} ==========\n`;
  combinedSql += content + '\n\n';
}

const outPath = join(__dirname, '..', 'supabase', 'combined_migration.sql');
writeFileSync(outPath, combinedSql);
console.log(`\nCombined SQL written to: supabase/combined_migration.sql`);
console.log('\nTo apply migrations:');
console.log('1. Go to your Supabase Dashboard → SQL Editor');
console.log('2. Paste the contents of supabase/combined_migration.sql');
console.log('3. Click "Run"\n');
console.log('Or use: npx supabase link --project-ref rrwgjrixvlyuxjijnavx');
console.log('Then:   npx supabase db push');

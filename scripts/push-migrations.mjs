// Execute combined migrations against Supabase Postgres
// Usage: node scripts/push-migrations.mjs

import pg from 'pg';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(__dirname, '..', 'supabase', 'combined_migration.sql');

const DB_URL = `postgresql://postgres.rrwgjrixvlyuxjijnavx:${process.env.SUPABASE_DB_PASSWORD}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;

async function run() {
  console.log('Connecting to Supabase PostgreSQL...');
  const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  
  try {
    await client.connect();
    console.log('Connected! Running migrations...\n');
    
    const sql = readFileSync(sqlPath, 'utf-8');
    
    // Split statements by the migration file markers and execute each section
    const sections = sql.split(/-- ========== \d{3}_/);
    
    for (let i = 1; i < sections.length; i++) {
      const section = sections[i];
      const fileName = section.split(' ==========')[0];
      console.log(`Running: ${fileName}...`);
      
      try {
        await client.query(section.substring(section.indexOf('\n')));
        console.log(`  ✓ ${fileName} completed`);
      } catch (err) {
        console.error(`  ✗ ${fileName} failed: ${err.message}`);
        // Continue with remaining migrations
      }
    }
    
    console.log('\nMigrations complete!');
  } catch (err) {
    console.error('Connection failed:', err.message);
    
    // Try alternate connection string format
    console.log('\nTrying alternate connection format...');
    const altUrl = `postgresql://postgres:${process.env.SUPABASE_DB_PASSWORD}@db.rrwgjrixvlyuxjijnavx.supabase.co:5432/postgres`;
    const client2 = new pg.Client({ connectionString: altUrl, ssl: { rejectUnauthorized: false } });
    
    try {
      await client2.connect();
      console.log('Connected via direct connection! Running migrations...\n');
      
      const sql = readFileSync(sqlPath, 'utf-8');
      const sections = sql.split(/-- ========== \d{3}_/);
      
      for (let i = 1; i < sections.length; i++) {
        const section = sections[i];
        const fileName = section.split(' ==========')[0];
        console.log(`Running: ${fileName}...`);
        
        try {
          await client2.query(section.substring(section.indexOf('\n')));
          console.log(`  ✓ ${fileName} completed`);
        } catch (err) {
          console.error(`  ✗ ${fileName} failed: ${err.message}`);
        }
      }
      
      console.log('\nMigrations complete!');
      await client2.end();
    } catch (err2) {
      console.error('Altection also failed:', err2.message);
      console.log('\nPlease run the SQL manually:');
      console.log('1. Go to https://supabase.com/dashboard/project/rrwgjrixvlyuxjijnavx/sql/new');
      console.log('2. Paste contents of supabase/combined_migration.sql');
      console.log('3. Click Run');
    }
  } finally {
    try { await client.end(); } catch {}
  }
}

run();

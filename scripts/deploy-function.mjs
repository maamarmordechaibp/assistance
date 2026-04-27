// Deploy a Supabase Edge Function via the Management API.
// Usage: SUPABASE_PAT=sbp_... node scripts/deploy-function.mjs <project-ref> <slug>
// Bundles supabase/functions/<slug>/** plus supabase/functions/_shared/**.
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep, posix } from 'path';

const [, , projectRef, slug] = process.argv;
if (!projectRef || !slug) { console.error('Usage: node scripts/deploy-function.mjs <project-ref> <slug>'); process.exit(1); }
const pat = process.env.SUPABASE_PAT;
if (!pat) { console.error('SUPABASE_PAT required'); process.exit(1); }

const fnRoot = join(process.cwd(), 'supabase', 'functions');
const slugDir = join(fnRoot, slug);
const sharedDir = join(fnRoot, '_shared');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = [...walk(slugDir), ...walk(sharedDir)].filter(f => /\.(ts|tsx|js|mjs|json|map)$/.test(f));
console.log(`Bundling ${files.length} files for slug=${slug}`);

const form = new FormData();
const entrypoint = `source/${slug}/index.ts`;
const metadata = {
  name: slug,
  entrypoint_path: entrypoint,
  verify_jwt: false,
};
form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));

for (const abs of files) {
  const rel = relative(fnRoot, abs).split(sep).join(posix.sep); // e.g. sw-inbound/index.ts or _shared/laml.ts
  const filename = `source/${rel}`;
  const buf = readFileSync(abs);
  form.append('file', new Blob([buf], { type: 'application/typescript' }), filename);
  console.log(`  + ${filename} (${buf.length}b)`);
}

const url = `https://api.supabase.com/v1/projects/${projectRef}/functions/deploy?slug=${encodeURIComponent(slug)}`;
console.log(`POST ${url}`);
const res = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${pat}` },
  body: form,
});
const text = await res.text();
console.log(`HTTP ${res.status} ${res.statusText}`);
console.log(text.slice(0, 4000));
if (!res.ok) process.exit(2);
console.log(`✓ Deployed ${slug}`);

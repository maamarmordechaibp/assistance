#!/usr/bin/env node
// Mirrors tools/offline-browser-launcher/launcher.ps1 → public/launcher/launcher.ps1
// so the file Vercel serves to reps stays in sync with the source-of-truth.
// Run automatically by the "Push & deploy" VS Code task before commit.

import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const src = resolve(repoRoot, 'tools/offline-browser-launcher/launcher.ps1');
const dst = resolve(repoRoot, 'public/launcher/launcher.ps1');

if (!existsSync(src)) {
  console.error(`[sync-launcher] source missing: ${src}`);
  process.exit(1);
}

mkdirSync(dirname(dst), { recursive: true });

const srcBuf = readFileSync(src);
const dstBuf = existsSync(dst) ? readFileSync(dst) : null;
if (dstBuf && srcBuf.equals(dstBuf)) {
  console.log('[sync-launcher] already in sync');
  process.exit(0);
}

copyFileSync(src, dst);
console.log(`[sync-launcher] copied ${srcBuf.length} bytes → public/launcher/launcher.ps1`);

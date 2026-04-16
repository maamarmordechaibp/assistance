#!/bin/sh
set -e

# Install deps and run OpenNext build
npm install --legacy-peer-deps
npx @opennextjs/cloudflare build

# Bundle worker.js + all its dependencies into a single self-contained _worker.js
# This resolves the 8 relative imports, tree-shakes unused code, and minifies
npx esbuild .open-next/worker.js \
  --bundle \
  --outfile=.open-next/assets/_worker.js \
  --format=esm \
  --target=es2022 \
  --minify \
  --platform=neutral \
  --conditions=workerd,worker,browser \
  --external:node:* \
  --external:cloudflare:* \
  --external:async_hooks \
  --external:buffer \
  --external:child_process \
  --external:crypto \
  --external:diagnostics_channel \
  --external:dns \
  --external:events \
  --external:fs \
  --external:http \
  --external:http2 \
  --external:https \
  --external:net \
  --external:os \
  --external:path \
  --external:perf_hooks \
  --external:process \
  --external:querystring \
  --external:stream \
  --external:string_decoder \
  --external:tls \
  --external:tty \
  --external:url \
  --external:util \
  --external:vm \
  --external:worker_threads \
  --external:zlib \
  --log-level=info

echo "=== Bundled _worker.js size ==="
wc -c < .open-next/assets/_worker.js

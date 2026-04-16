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
  --log-level=info

echo "=== Bundled _worker.js size ==="
wc -c < .open-next/assets/_worker.js

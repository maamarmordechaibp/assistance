#!/bin/sh
set -e

# Install deps and run OpenNext build
npm install --legacy-peer-deps
npx @opennextjs/cloudflare build

# Bundle worker.js + all its dependencies into a single self-contained file
# --platform=node: creates proper createRequire shim for CJS require() calls in ESM output
#   (--platform=neutral left bare require() calls which crash in ESM Workers runtime)
# --platform=node also auto-externalizes all node builtins
# --banner injects process/Buffer polyfills with used bindings (non-strippable)
mkdir -p .open-next/assets/_worker.js
npx esbuild .open-next/worker.js \
  --bundle \
  --outfile=.open-next/assets/_worker.js/index.js \
  --format=esm \
  --target=es2022 \
  --minify \
  --platform=node \
  --conditions=workerd,worker,browser \
  --banner:js='import __nP from "node:process";import{Buffer as __nB}from "node:buffer";globalThis.process=globalThis.process||__nP;globalThis.Buffer=globalThis.Buffer||__nB;' \
  --external:cloudflare:* \
  --log-level=info

# Also remove the bare import"node:process" that CF's esbuild would strip
# (our banner above already handles the polyfill)
sed -i 's/import"node:process";//g' .open-next/assets/_worker.js/index.js

# CF Pages directory mode needs package.json with type:module for ESM workers
echo '{"type":"module","main":"index.js"}' > .open-next/assets/_worker.js/package.json

echo "=== Bundled _worker.js/index.js size ==="
wc -c < .open-next/assets/_worker.js/index.js

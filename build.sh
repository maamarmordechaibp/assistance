#!/bin/sh
set -e

# Install deps and run OpenNext build
npm install --legacy-peer-deps
npx @opennextjs/cloudflare build

# Bundle worker.js + all its dependencies into a single self-contained file
# This resolves the 8 relative imports, tree-shakes unused code, and minifies
# --banner injects a named process import (with used binding) so CF Pages' esbuild
# cannot strip it via sideEffects:false (the bare import "node:process" gets stripped)
mkdir -p .open-next/assets/_worker.js
npx esbuild .open-next/worker.js \
  --bundle \
  --outfile=.open-next/assets/_worker.js/index.js \
  --format=esm \
  --target=es2022 \
  --minify \
  --platform=neutral \
  --conditions=workerd,worker,browser \
  --banner:js='import __nP from "node:process";import{Buffer as __nB}from "node:buffer";globalThis.process=globalThis.process||__nP;globalThis.Buffer=globalThis.Buffer||__nB;' \
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

# Also remove the bare import"node:process" that CF's esbuild would strip
# (our banner above already handles the polyfill)
sed -i 's/import"node:process";//g' .open-next/assets/_worker.js/index.js

echo "=== Bundled _worker.js/index.js size ==="
wc -c < .open-next/assets/_worker.js/index.js

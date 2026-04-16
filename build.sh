#!/bin/sh
set -e

# Install deps and run OpenNext build
npm install --legacy-peer-deps
npx @opennextjs/cloudflare build

# Bundle worker.js + all its dependencies into a single self-contained file
mkdir -p .open-next/assets/_worker.js
npx esbuild .open-next/worker.js \
  --bundle \
  --outfile=.open-next/assets/_worker.js/original.js \
  --format=esm \
  --target=es2022 \
  --minify \
  --platform=node \
  --conditions=workerd,worker,browser \
  --banner:js='import __nP from "node:process";import{Buffer as __nB}from "node:buffer";globalThis.process=globalThis.process||__nP;globalThis.Buffer=globalThis.Buffer||__nB;' \
  --external:cloudflare:* \
  --log-level=info

# Remove bare import"node:process" that CF esbuild strips
sed -i 's/import"node:process";//g' .open-next/assets/_worker.js/original.js

# Create debug wrapper that catches and displays the actual error
cat > .open-next/assets/_worker.js/index.js << 'DEBUGWRAP'
let mod, initError;
try {
  mod = await import("./original.js");
} catch (e) {
  initError = e;
}
export default {
  async fetch(req, env, ctx) {
    if (initError) {
      return new Response(
        "WORKER INIT ERROR:\n" + initError.stack + "\n\nmessage: " + initError.message,
        { status: 500, headers: { "content-type": "text/plain" } }
      );
    }
    try {
      const handler = mod.default || mod;
      return await handler.fetch(req, env, ctx);
    } catch (e) {
      return new Response(
        "WORKER RUNTIME ERROR:\n" + e.stack + "\n\nmessage: " + e.message,
        { status: 500, headers: { "content-type": "text/plain" } }
      );
    }
  }
};
DEBUGWRAP

# CF Pages directory mode needs package.json with type:module for ESM workers
echo '{"type":"module","main":"index.js"}' > .open-next/assets/_worker.js/package.json

echo "=== Bundled _worker.js/index.js size ==="
wc -c < .open-next/assets/_worker.js/index.js

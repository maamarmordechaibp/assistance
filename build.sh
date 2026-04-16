#!/bin/sh
set -e

# Install deps and run OpenNext build
npm install --legacy-peer-deps
npx @opennextjs/cloudflare build

# Bundle worker.js + all its dependencies into a single self-contained file
# --platform=neutral: avoids createRequire shim (CF Workers doesn't support it)
# --format=esm: converts external require() calls to ESM imports (CF Workers supports)
# Externalize both node:* prefixed AND bare builtin names
mkdir -p .open-next/assets/_worker.js
npx esbuild .open-next/worker.js \
  --bundle \
  --outfile=.open-next/assets/_worker.js/original.js \
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
  --external:module \
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

# Ensure bare builtin imports use node: prefix for CF Workers compatibility
sed -i 's/from"async_hooks"/from"node:async_hooks"/g; s/from"buffer"/from"node:buffer"/g; s/from"child_process"/from"node:child_process"/g; s/from"crypto"/from"node:crypto"/g; s/from"diagnostics_channel"/from"node:diagnostics_channel"/g; s/from"dns"/from"node:dns"/g; s/from"events"/from"node:events"/g; s/from"fs"/from"node:fs"/g; s/from"http"/from"node:http"/g; s/from"http2"/from"node:http2"/g; s/from"https"/from"node:https"/g; s/from"module"/from"node:module"/g; s/from"net"/from"node:net"/g; s/from"os"/from"node:os"/g; s/from"path"/from"node:path"/g; s/from"perf_hooks"/from"node:perf_hooks"/g; s/from"process"/from"node:process"/g; s/from"querystring"/from"node:querystring"/g; s/from"stream"/from"node:stream"/g; s/from"string_decoder"/from"node:string_decoder"/g; s/from"tls"/from"node:tls"/g; s/from"tty"/from"node:tty"/g; s/from"url"/from"node:url"/g; s/from"util"/from"node:util"/g; s/from"vm"/from"node:vm"/g; s/from"worker_threads"/from"node:worker_threads"/g; s/from"zlib"/from"node:zlib"/g' .open-next/assets/_worker.js/original.js

# Fix dynamic require(): esbuild's --platform=neutral creates a throwing __require
# shim for require() calls it can't statically convert to imports. Replace it with
# a working shim that returns pre-imported Node.js builtins.
node << 'FIXREQUIRE'
const fs = require("fs");
const f = ".open-next/assets/_worker.js/original.js";
let c = fs.readFileSync(f, "utf8");

const builtins = [
  "async_hooks","assert","buffer","child_process","crypto",
  "diagnostics_channel","dns","events","fs","http","http2",
  "https","module","net","os","path","perf_hooks","process",
  "querystring","stream","string_decoder","tls","tty","url",
  "util","vm","worker_threads","zlib"
];

// Static ESM imports for every builtin (will be prepended to file)
const imports = builtins.map((b, i) =>
  "import * as _RQ" + i + ' from "node:' + b + '";'
).join("\n");

// Map entries: both "node:X" and bare "X" point to the import
const entries = builtins.map((b, i) =>
  '"node:' + b + '":_RQ' + i + ',"' + b + '":_RQ' + i
).join(",");

// Replace the throw inside esbuild's __require shim with a map lookup.
// Minified pattern: throw new Error('Dynamic require of "'+VARNAME+'" is not supported')
const re = /throw new Error\('Dynamic require of "'\+(\w+)\+'" is not supported'\)/g;
const count = (c.match(re) || []).length;
c = c.replace(re, (_, v) =>
  "{var _rm={" + entries + "};if(_rm[" + v + "])return _rm[" + v + "];" +
  "throw new Error('Dynamic require of \"'+" + v + "+'\" is not supported')}"
);

// Prepend the builtin imports at the very top
c = imports + "\n" + c;
fs.writeFileSync(f, c);
console.log("Patched " + count + " dynamic require shim(s) with " + builtins.length + " builtin mappings");
FIXREQUIRE

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

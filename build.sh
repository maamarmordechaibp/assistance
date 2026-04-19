#!/bin/sh
set -e

# Install deps and run OpenNext build
npm install --legacy-peer-deps
npx @opennextjs/cloudflare build

# --- Require polyfill for CF Workers ---
# esbuild --platform=neutral wraps unconvertible require() calls in an IIFE that
# checks `typeof require`. By defining globalThis.require BEFORE the IIFE runs,
# it returns our function instead of the throwing stub.
cat > /tmp/cf-require-polyfill.js << 'POLYFILL'
import * as __n0 from "node:async_hooks";
import * as __n1 from "node:assert";
import * as __n2 from "node:buffer";
import * as __n3 from "node:child_process";
import * as __n4 from "node:crypto";
import * as __n5 from "node:diagnostics_channel";
import * as __n6 from "node:dns";
import * as __n7 from "node:events";
import * as __n8 from "node:fs";
import * as __n9 from "node:http";
import * as __n10 from "node:http2";
import * as __n11 from "node:https";
import * as __n12 from "node:module";
import * as __n13 from "node:net";
import * as __n14 from "node:os";
import * as __n15 from "node:path";
import * as __n16 from "node:perf_hooks";
import * as __n17 from "node:process";
import * as __n18 from "node:querystring";
import * as __n19 from "node:stream";
import * as __n20 from "node:string_decoder";
import * as __n21 from "node:tls";
import * as __n22 from "node:tty";
import * as __n23 from "node:url";
import * as __n24 from "node:util";
import * as __n25 from "node:vm";
import * as __n26 from "node:worker_threads";
import * as __n27 from "node:zlib";
globalThis.process = globalThis.process || __n17;
globalThis.Buffer = globalThis.Buffer || __n2.Buffer;
globalThis.require = function(id) { var m = {"node:async_hooks":__n0,"async_hooks":__n0,"node:assert":__n1,"assert":__n1,"node:buffer":__n2,"buffer":__n2,"node:child_process":__n3,"child_process":__n3,"node:crypto":__n4,"crypto":__n4,"node:diagnostics_channel":__n5,"diagnostics_channel":__n5,"node:dns":__n6,"dns":__n6,"node:events":__n7,"events":__n7,"node:fs":__n8,"fs":__n8,"node:http":__n9,"http":__n9,"node:http2":__n10,"http2":__n10,"node:https":__n11,"https":__n11,"node:module":__n12,"module":__n12,"node:net":__n13,"net":__n13,"node:os":__n14,"os":__n14,"node:path":__n15,"path":__n15,"node:perf_hooks":__n16,"perf_hooks":__n16,"node:process":__n17,"process":__n17,"node:querystring":__n18,"querystring":__n18,"node:stream":__n19,"stream":__n19,"node:string_decoder":__n20,"string_decoder":__n20,"node:tls":__n21,"tls":__n21,"node:tty":__n22,"tty":__n22,"node:url":__n23,"url":__n23,"node:util":__n24,"util":__n24,"node:vm":__n25,"vm":__n25,"node:worker_threads":__n26,"worker_threads":__n26,"node:zlib":__n27,"zlib":__n27}; if(m[id])return m[id]; throw new Error("Cannot find module: "+id); };
POLYFILL

mkdir -p .open-next/assets/_worker.js

# Bundle worker.js with esbuild
# --alias rewrites bare builtin imports to node: prefix before bundling
# --external:node:* externalizes all node:-prefixed imports
npx esbuild .open-next/worker.js \
  --bundle \
  --outfile=/tmp/worker-bundled.js \
  --format=esm \
  --target=es2022 \
  --minify \
  --platform=neutral \
  --conditions=workerd,worker,browser \
  --external:node:* \
  --external:cloudflare:* \
  --alias:async_hooks=node:async_hooks \
  --alias:assert=node:assert \
  --alias:buffer=node:buffer \
  --alias:child_process=node:child_process \
  --alias:crypto=node:crypto \
  --alias:diagnostics_channel=node:diagnostics_channel \
  --alias:dns=node:dns \
  --alias:events=node:events \
  --alias:fs=node:fs \
  --alias:http=node:http \
  --alias:http2=node:http2 \
  --alias:https=node:https \
  --alias:module=node:module \
  --alias:net=node:net \
  --alias:os=node:os \
  --alias:path=node:path \
  --alias:perf_hooks=node:perf_hooks \
  --alias:process=node:process \
  --alias:querystring=node:querystring \
  --alias:stream=node:stream \
  --alias:string_decoder=node:string_decoder \
  --alias:tls=node:tls \
  --alias:tty=node:tty \
  --alias:url=node:url \
  --alias:util=node:util \
  --alias:vm=node:vm \
  --alias:worker_threads=node:worker_threads \
  --alias:zlib=node:zlib \
  --log-level=info

# Prepend polyfill (provides globalThis.require backed by ESM imports)
cat /tmp/cf-require-polyfill.js /tmp/worker-bundled.js > .open-next/assets/_worker.js/original.js

# Debug wrapper that catches errors + captures console.error for OpenNext's internal error logging
cat > .open-next/assets/_worker.js/index.js << 'DEBUGWRAP'
let mod, initError;
const _errors = [];
const _origErr = console.error;
console.error = function(...args) { _errors.push(args.map(a => a?.stack||String(a)).join(" ")); _origErr.apply(console, args); };
try { mod = await import("./original.js"); } catch(e) { initError = e; }
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/__debug") {
      const info = {
        initError: initError ? initError.stack : null,
        envKeys: Object.keys(env || {}),
        processEnvKeys: Object.keys(globalThis.process?.env || {}),
        hasRequire: typeof globalThis.require,
        modKeys: mod ? Object.keys(mod.default || mod) : null,
        modType: mod ? typeof (mod.default || mod).fetch : null,
        capturedErrors: _errors.slice(-20),
      };
      return new Response(JSON.stringify(info, null, 2), {status:200,headers:{"content-type":"application/json"}});
    }
    if (initError) return new Response("WORKER INIT ERROR:\n"+initError.stack+"\n\nmessage: "+initError.message, {status:500,headers:{"content-type":"text/plain"}});
    _errors.length = 0;
    try {
      const resp = await (mod.default||mod).fetch(req, env, ctx);
      if (resp.status >= 500) {
        const body = await resp.text();
        return new Response("WORKER 5xx (status="+resp.status+"):\nURL: "+req.url+"\nBody: "+body+"\n\nCaptured console.error:\n"+_errors.join("\n---\n")+"\n\nHeaders: "+JSON.stringify(Object.fromEntries(resp.headers)), {status:resp.status,headers:{"content-type":"text/plain"}});
      }
      return resp;
    }
    catch(e) { return new Response("WORKER RUNTIME ERROR:\n"+e.stack+"\n\nmessage: "+e.message, {status:500,headers:{"content-type":"text/plain"}}); }
  }
};
DEBUGWRAP

echo '{"type":"module","main":"index.js"}' > .open-next/assets/_worker.js/package.json

echo "=== Bundled original.js size ==="
wc -c < .open-next/assets/_worker.js/original.js

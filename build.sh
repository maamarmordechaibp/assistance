#!/bin/sh
set -e

# Install deps and run OpenNext build
npm install --legacy-peer-deps
npx @opennextjs/cloudflare build

# Copy worker dependencies to assets/ so CF Pages esbuild can resolve imports
for dir in cloudflare middleware .build server-functions cache cloudflare-templates dynamodb-provider; do
  if [ -d ".open-next/$dir" ]; then
    cp -r ".open-next/$dir" ".open-next/assets/"
  fi
done

# Copy worker as single file (CF Pages will esbuild-bundle it, tree-shaking + gzip)
cp .open-next/worker.js .open-next/assets/_worker.js

echo "=== assets directory ==="
ls -la .open-next/assets/

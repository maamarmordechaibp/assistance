#!/bin/sh
set -e

# Install deps and run OpenNext build
npm install --legacy-peer-deps
npx @opennextjs/cloudflare build

# Create _worker.js directory (CF Pages advanced mode)
mkdir -p .open-next/assets/_worker.js

# Copy worker entry point as index.js
cp .open-next/worker.js .open-next/assets/_worker.js/index.js

# Copy all worker dependencies into the _worker.js directory
for dir in cloudflare middleware .build server-functions cache cloudflare-templates dynamodb-provider; do
  if [ -d ".open-next/$dir" ]; then
    cp -r ".open-next/$dir" ".open-next/assets/_worker.js/"
  fi
done

echo "=== _worker.js directory ==="
ls -la .open-next/assets/_worker.js/

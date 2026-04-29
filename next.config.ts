import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Pin the workspace root so Next stops guessing based on a stray
  // E:\assistance\package-lock.json sitting one folder up.
  outputFileTracingRoot: path.join(__dirname),
  // Prevent Next.js from bundling WebRTC/SignalWire on the server
  serverExternalPackages: ['@signalwire/js', '@signalwire/core', '@signalwire/webrtc'],
  webpack(config, { isServer }) {
    // Workaround for spurious EISDIR readlink errors on Windows during
    // production builds (regular files reported as readlink targets).
    if (config.resolve) {
      config.resolve.symlinks = false;
    }
    if (config.cache && typeof config.cache === 'object') {
      // The persistent pack cache also tries to readlink dependencies and
      // chokes on the same Windows quirk; in-memory cache works fine.
      (config as { cache: unknown }).cache = false;
    }
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        dgram: false,
      };
    }
    return config;
  },
};

export default nextConfig;

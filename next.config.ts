import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prevent Next.js from bundling WebRTC/SignalWire on the server
  serverExternalPackages: ['@signalwire/js', '@signalwire/core', '@signalwire/webrtc'],
  webpack(config, { isServer }) {
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

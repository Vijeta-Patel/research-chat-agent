import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // The Agent SDK launches a bundled Claude Code binary from node_modules; keep
  // it out of the bundler so that path resolves at runtime.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

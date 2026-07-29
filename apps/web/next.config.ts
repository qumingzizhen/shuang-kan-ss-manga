import type { NextConfig } from "next";

import { apiRewrite, backendProxyTimeoutMs } from "./proxy-config";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  env: {
    // Keep browser API requests on the frontend origin. Only the server-side
    // rewrite knows the address of the selected Python or Rust backend.
    NEXT_PUBLIC_API_BASE: "",
  },
  experimental: {
    // Next.js defaults external rewrites to 30 seconds. A longer bounded value
    // keeps SSE progress and slow image streams alive without hanging forever.
    proxyTimeout: backendProxyTimeoutMs,
  },
  async rewrites() {
    return [apiRewrite];
  },
};

export default nextConfig;

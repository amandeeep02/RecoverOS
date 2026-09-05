import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `/frontier` reads this file at request time; serverless bundlers only ship what
  // static analysis can see, and a path built with `resolve(process.cwd(), …)` is not it.
  outputFileTracingIncludes: { "/frontier": ["./data/generated/frontier.json"] },
};

export default nextConfig;

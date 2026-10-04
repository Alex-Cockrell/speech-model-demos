import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import pkg from './package.json';

/**
 * Static export only: no SSR, no API routes. Production COOP/COEP headers come from
 * public/_headers (Cloudflare); next.config headers() only applies to `next dev`.
 */
const crossOriginIsolationHeaders = [
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
];

export default function config(phase: string): NextConfig {
  return {
    output: 'export',
    // A stray lockfile in a parent directory otherwise makes Turbopack guess the wrong root.
    turbopack: { root: __dirname },
    reactStrictMode: false,
    images: { unoptimized: true },
    // Always defined so the values are inlined at build time everywhere, including Web Worker
    // bundles, where there is no `process` object to read an undefined variable from.
    env: {
      NEXT_PUBLIC_MODEL_BASE_URL: process.env.NEXT_PUBLIC_MODEL_BASE_URL ?? '',
      NEXT_PUBLIC_APP_VERSION: pkg.version,
      // Cloudflare Pages / Workers Builds expose the commit at build time.
      NEXT_PUBLIC_COMMIT_SHA: process.env.CF_PAGES_COMMIT_SHA || process.env.WORKERS_CI_COMMIT_SHA || '',
      NEXT_PUBLIC_BUILT_AT: new Date().toISOString(),
    },
    ...(phase === PHASE_DEVELOPMENT_SERVER
      ? {
          async headers() {
            return [{ source: '/:path*', headers: crossOriginIsolationHeaders }];
          },
        }
      : {}),
  };
}

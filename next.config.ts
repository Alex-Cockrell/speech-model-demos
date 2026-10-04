import { execSync } from 'node:child_process';
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

/** The built commit for benchmark records; CI variables can hold a branch name instead of a SHA. */
function commitSha(): string {
  const candidates = [process.env.CF_PAGES_COMMIT_SHA, process.env.WORKERS_CI_COMMIT_SHA];
  try {
    candidates.unshift(execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim());
  } catch {
    // Not a git checkout.
  }
  return candidates.find((c) => c && /^[0-9a-f]{7,40}$/i.test(c)) ?? '';
}

export default function config(phase: string): NextConfig {
  return {
    output: 'export',
    // A stray lockfile in a parent directory otherwise makes Turbopack guess the wrong root.
    turbopack: { root: __dirname },
    reactStrictMode: false,
    // next dev would otherwise write AGENTS.md / CLAUDE.md into the repo root on every run.
    agentRules: false,
    images: { unoptimized: true },
    // Always defined so the values are inlined at build time everywhere, including Web Worker
    // bundles, where there is no `process` object to read an undefined variable from.
    env: {
      NEXT_PUBLIC_MODEL_BASE_URL: process.env.NEXT_PUBLIC_MODEL_BASE_URL ?? '',
      // Same rule as scripts/network-lock.mjs, which writes the policy after the build. `next dev` is never locked.
      NEXT_PUBLIC_NETWORK_LOCK:
        phase !== PHASE_DEVELOPMENT_SERVER && (process.env.NETWORK_LOCK ?? '').toLowerCase() !== 'off' ? 'on' : 'off',
      NEXT_PUBLIC_APP_VERSION: pkg.version,
      NEXT_PUBLIC_COMMIT_SHA: commitSha(),
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

#!/usr/bin/env node
// Network lock (runs as `postbuild`): appends a Content-Security-Policy to out/_headers so the browser itself
// refuses every connection except to this app and the build's model host. Audio, transcripts and text can then
// not leave the device even through a bug, and the model source is fixed by the build.
//
//   NETWORK_LOCK=off              build without the lock (e.g. to try models from another URL locally)
//   NEXT_PUBLIC_MODEL_BASE_URL    model mirror the build downloads from (default: the public model host)
//
// `next dev` is never locked. Keep the on/off rule in sync with NEXT_PUBLIC_NETWORK_LOCK in next.config.ts.
import { appendFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEADERS = join(ROOT, 'out', '_headers');

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/network-lock.mjs   (runs after `next build`; NETWORK_LOCK=off disables it)');
  process.exit(0);
}

if ((process.env.NETWORK_LOCK ?? '').toLowerCase() === 'off') {
  console.warn('network-lock: NETWORK_LOCK=off — this build allows connections to any host (no Content-Security-Policy).');
  process.exit(0);
}

if (!existsSync(HEADERS)) {
  console.error(`network-lock: ${HEADERS} not found; run it after \`next build\` (public/_headers is copied there).`);
  process.exit(1);
}

const mirror = (process.env.NEXT_PUBLIC_MODEL_BASE_URL ?? '').trim();
let modelHosts;
if (mirror) {
  try {
    modelHosts = [new URL(mirror).origin];
  } catch {
    console.error(`network-lock: NEXT_PUBLIC_MODEL_BASE_URL is not a valid URL: ${mirror}`);
    process.exit(1);
  }
} else {
  // Files resolve on huggingface.co and redirect to its CDN hosts (*.hf.co, e.g. cas-bridge.xethub.hf.co).
  modelHosts = ['https://huggingface.co', 'https://*.huggingface.co', 'https://*.hf.co'];
}

const policy = [
  "default-src 'self'",
  // Next's inline bootstrap scripts; same-origin chunks and ONNX Runtime glue; WebAssembly compilation;
  // the microphone AudioWorklet module is a blob: URL.
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  // The only way data could leave the page: fetch/XHR/WebSocket/beacons. Model loaders hand ONNX Runtime
  // blob: URLs of cached files.
  `connect-src 'self' blob: data: ${modelHosts.join(' ')}`,
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "base-uri 'self'",
].join('; ');

appendFileSync(
  HEADERS,
  `\n# Network lock, added by scripts/network-lock.mjs (NETWORK_LOCK=off to build without it).\n/*\n  Content-Security-Policy: ${policy}\n`,
);
console.log(`network-lock: connections limited to this app and ${modelHosts.join(', ')}`);

#!/usr/bin/env node
// Copies the ONNX Runtime Web files the inference workers load (.mjs glue + .wasm) into public/ort/,
// so they are served from our own origin (required by COEP) under versioned, immutably cached paths.
// Destinations come from PARAKEET_RUNTIME / KOKORO_RUNTIME in packages/*/src/models.ts. Runs as the npm "predev" and "prebuild" hooks.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HELP = `Usage: node scripts/copy-ort-assets.mjs

Copies ort-wasm-simd-threaded.jsep.{mjs,wasm} from
  node_modules/onnxruntime-web/dist                 (used by parakeet.js)
  node_modules/@huggingface/transformers/dist       (used by kokoro-js)
into public/<wasmPaths> as defined by PARAKEET_RUNTIME and KOKORO_RUNTIME in packages/*/src/models.ts.
Fails if the installed package versions no longer match them, or if a file exceeds Cloudflare's 25 MiB per-asset limit.`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_ORT = join(ROOT, 'public', 'ort');
/** Cloudflare Pages and Workers static assets reject any single file above 25 MiB. */
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const FILES = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

try {
  await main();
} catch (err) {
  console.error(`copy-ort-assets: ${err.message}`);
  process.exit(1);
}

async function main() {
  const assets = await readOrtAssets();
  const ortVersion = packageVersion('node_modules/onnxruntime-web');
  const transformersPkg = readJson('node_modules/@huggingface/transformers/package.json');
  // The .wasm files shipped in transformers' dist/ are built from the onnxruntime-web it depends on.
  const transformersOrt = transformersPkg.dependencies?.['onnxruntime-web'];

  expectEqual('onnxruntime-web', ortVersion, 'PARAKEET_RUNTIME.version', assets.parakeet.version);
  expectEqual('@huggingface/transformers', transformersPkg.version, 'KOKORO_RUNTIME.transformers', assets.kokoro.transformers);
  expectEqual('onnxruntime-web required by @huggingface/transformers', transformersOrt, 'KOKORO_RUNTIME.version', assets.kokoro.version);
  // Both libraries must share one onnxruntime-web / transformers instance with the workers, or the
  // wasmPaths the workers set would not reach the copy the library actually uses.
  for (const nested of [
    'node_modules/parakeet.js/node_modules/onnxruntime-web',
    'node_modules/kokoro-js/node_modules/@huggingface/transformers',
    'packages/speech-to-text/node_modules/onnxruntime-web',
    'packages/text-to-speech/node_modules/@huggingface/transformers',
  ]) {
    if (existsSync(join(ROOT, nested))) {
      throw new Error(`${nested} exists: a second copy is installed. Align the versions in package.json so npm dedupes it.`);
    }
  }

  const jobs = [
    { from: 'node_modules/onnxruntime-web/dist', to: assets.parakeet.wasmPaths },
    { from: 'node_modules/@huggingface/transformers/dist', to: assets.kokoro.wasmPaths },
  ];
  for (const job of jobs) {
    if (!job.to.startsWith('/ort/')) {
      throw new Error(`wasmPaths "${job.to}" must live under /ort/ (public/ort/ is the generated, gitignored folder).`);
    }
    for (const file of FILES) {
      const src = join(ROOT, job.from, file);
      if (!existsSync(src)) throw new Error(`${job.from}/${file} not found. Run npm install.`);
      const size = statSync(src).size;
      if (size > MAX_ASSET_BYTES) {
        throw new Error(
          `${job.from}/${file} is ${size} bytes; Cloudflare static assets are limited to 25 MiB (${MAX_ASSET_BYTES} bytes) per file.`,
        );
      }
    }
  }

  // Start clean so directories for previous versions are not deployed.
  rmSync(PUBLIC_ORT, { recursive: true, force: true });
  for (const job of jobs) {
    const destDir = join(ROOT, 'public', ...job.to.split('/').filter(Boolean));
    mkdirSync(destDir, { recursive: true });
    for (const file of FILES) {
      copyFileSync(join(ROOT, job.from, file), join(destDir, file));
      console.log(`copy-ort-assets: ${job.to}${file} (${mib(statSync(join(destDir, file)).size)} MiB)`);
    }
  }
}

/**
 * The runtime constants of the packages (PARAKEET_RUNTIME, KOKORO_RUNTIME), read from their compiled models.js
 * (`npm run build:packages` runs first in predev/prebuild) so this script cannot drift from them.
 */
async function readOrtAssets() {
  const load = async (pkg) => {
    const path = join(ROOT, 'packages', pkg, 'dist', 'models.js');
    if (!existsSync(path)) throw new Error(`packages/${pkg}/dist/models.js not found. Run npm run build:packages.`);
    return import(pathToFileURL(path).href);
  };
  const [stt, tts] = await Promise.all([load('speech-to-text'), load('text-to-speech')]);
  return { parakeet: stt.PARAKEET_RUNTIME, kokoro: tts.KOKORO_RUNTIME };
}

function expectEqual(installedLabel, installed, configLabel, configured) {
  if (installed !== configured) {
    throw new Error(
      `installed ${installedLabel} is ${installed ?? '(missing)'} but ${configLabel} in packages/*/src/models.ts is ${configured}. ` +
        'Update the runtime and library version constants there after checking the new runtime, or reinstall the pinned version.',
    );
  }
}

function packageVersion(dir) {
  return readJson(`${dir}/package.json`).version;
}

function readJson(relativePath) {
  const path = join(ROOT, relativePath);
  if (!existsSync(path)) throw new Error(`${relativePath} not found. Run npm install.`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function mib(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

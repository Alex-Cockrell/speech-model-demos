#!/usr/bin/env node
// Copies the ONNX Runtime Web files the inference workers load (.mjs glue + .wasm) into public/ort/,
// so they are served from our own origin (required by COEP) under versioned, immutably cached paths.
// Destinations come from ORT_ASSETS in src/lib/config.ts. Runs as the npm "predev" and "prebuild" hooks.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `Usage: node scripts/copy-ort-assets.mjs

Copies ort-wasm-simd-threaded.jsep.{mjs,wasm} from
  node_modules/onnxruntime-web/dist                 (used by parakeet.js)
  node_modules/@huggingface/transformers/dist       (used by kokoro-js)
into public/<ORT_ASSETS.*.wasmPaths> as defined in src/lib/config.ts. Fails if the installed package
versions no longer match ORT_ASSETS, or if a file exceeds Cloudflare's 25 MiB per-asset limit.`;

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
  main();
} catch (err) {
  console.error(`copy-ort-assets: ${err.message}`);
  process.exit(1);
}

function main() {
  const assets = readOrtAssets();
  const ortVersion = packageVersion('node_modules/onnxruntime-web');
  const transformersPkg = readJson('node_modules/@huggingface/transformers/package.json');
  // The .wasm files shipped in transformers' dist/ are built from the onnxruntime-web it depends on.
  const transformersOrt = transformersPkg.dependencies?.['onnxruntime-web'];

  expectEqual('onnxruntime-web', ortVersion, 'ORT_ASSETS.parakeet.version', assets.parakeet.version);
  expectEqual('@huggingface/transformers', transformersPkg.version, 'ORT_ASSETS.kokoro.transformers', assets.kokoro.transformers);
  expectEqual('onnxruntime-web required by @huggingface/transformers', transformersOrt, 'ORT_ASSETS.kokoro.version', assets.kokoro.version);
  // Both libraries must share one onnxruntime-web / transformers instance with the workers, or the
  // wasmPaths the workers set would not reach the copy the library actually uses.
  for (const nested of ['node_modules/parakeet.js/node_modules/onnxruntime-web', 'node_modules/kokoro-js/node_modules/@huggingface/transformers']) {
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

/** Extracts ORT_ASSETS from src/lib/config.ts so the script cannot drift from the app's config. */
function readOrtAssets() {
  const source = readFileSync(join(ROOT, 'src/lib/config.ts'), 'utf8');
  const block = /export const ORT_ASSETS = \{([\s\S]*?)\n\}/.exec(source)?.[1];
  if (!block) throw new Error('could not find "export const ORT_ASSETS = {" in src/lib/config.ts');
  const entry = (name) => {
    const body = new RegExp(`\\b${name}:\\s*\\{([^}]*)\\}`).exec(block)?.[1];
    if (!body) throw new Error(`could not find ORT_ASSETS.${name} in src/lib/config.ts`);
    const field = (key) => new RegExp(`\\b${key}:\\s*'([^']*)'`).exec(body)?.[1];
    return { version: field('version'), transformers: field('transformers'), wasmPaths: field('wasmPaths') };
  };
  const assets = { parakeet: entry('parakeet'), kokoro: entry('kokoro') };
  for (const [name, value] of Object.entries({
    'parakeet.version': assets.parakeet.version,
    'parakeet.wasmPaths': assets.parakeet.wasmPaths,
    'kokoro.version': assets.kokoro.version,
    'kokoro.transformers': assets.kokoro.transformers,
    'kokoro.wasmPaths': assets.kokoro.wasmPaths,
  })) {
    if (!value) throw new Error(`could not read ORT_ASSETS.${name} from src/lib/config.ts`);
  }
  return assets;
}

function expectEqual(installedLabel, installed, configLabel, configured) {
  if (installed !== configured) {
    throw new Error(
      `installed ${installedLabel} is ${installed ?? '(missing)'} but ${configLabel} in src/lib/config.ts is ${configured}. ` +
        'Update ORT_ASSETS (and LIBRARY_VERSIONS) in src/lib/config.ts after checking the new runtime, or reinstall the pinned version.',
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

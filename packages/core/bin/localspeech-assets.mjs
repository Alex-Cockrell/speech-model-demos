#!/usr/bin/env node
// Copies the ONNX Runtime Web files the @localspeech workers load (ort-wasm-simd-threaded.jsep.{mjs,wasm}) into a folder
// your site serves, as <dir>/onnxruntime-web-<version>/. With the default <dir> of public/localspeech, that is the
// packages' default runtimeUrl (/localspeech/onnxruntime-web-<version>/). Run it in your build, e.g. "prebuild".
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const HELP = `Usage: localspeech-assets [dir]   (default: public/localspeech)

Copies ONNX Runtime Web's ort-wasm-simd-threaded.jsep.{mjs,wasm}, in the version the installed @localspeech packages
use, to <dir>/onnxruntime-web-<version>/. Serve them from your own origin (with the page's COOP/COEP headers) and,
if you use another folder, pass its URL as runtimeUrl.`;

const FILES = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];
const PACKAGES = ['@localspeech/text-to-speech', '@localspeech/speech-to-text'];

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}
const target = resolve(args[0] ?? 'public/localspeech');
const fromCwd = createRequire(join(process.cwd(), 'package.json'));

const runtimes = new Map(); // version → dist folder
for (const name of PACKAGES) {
  let pkgJson;
  try {
    pkgJson = fromCwd.resolve(`${name}/package.json`);
  } catch {
    continue; // not installed
  }
  // The onnxruntime-web this package resolves (a nested copy if npm could not dedupe it). Its exports hide
  // package.json, so resolve the entry point and walk up to the package root.
  const root = packageRoot(createRequire(pkgJson).resolve('onnxruntime-web'), 'onnxruntime-web');
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  runtimes.set(version, join(root, 'dist'));
}
if (runtimes.size === 0) {
  console.error(`localspeech-assets: none of ${PACKAGES.join(', ')} is installed here.`);
  process.exit(1);
}

for (const [version, dist] of runtimes) {
  const dest = join(target, `onnxruntime-web-${version}`);
  mkdirSync(dest, { recursive: true });
  for (const file of FILES) {
    const src = join(dist, file);
    if (!existsSync(src)) {
      console.error(`localspeech-assets: ${src} not found. Reinstall onnxruntime-web ${version}.`);
      process.exit(1);
    }
    copyFileSync(src, join(dest, file));
    console.log(`localspeech-assets: ${join(dest, file)} (${(statSync(src).size / 1024 / 1024).toFixed(1)} MiB)`);
  }
}

function packageRoot(file, name) {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) return dir;
  }
  throw new Error(`localspeech-assets: could not find the ${name} package root above ${file}.`);
}

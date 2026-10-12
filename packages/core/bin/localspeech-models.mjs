#!/usr/bin/env node
// Downloads the model files the installed @localspeech packages load, pinned to their exact revisions, into the layout
// they request ({dir}/{repo}/resolve/{revision}/{file}). Serve that folder from your own origin (or any static host)
// and set modelBaseUrl to its URL: then nothing is fetched from huggingface.co (locked-down networks, offline kiosks).
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const HELP = `Usage: localspeech-models [dir] [options]   (default dir: public/models)

Options:
  --tts / --stt              only that package's model (default: every installed @localspeech package)
  --tts-precision <list>     voice model precisions (default fp16,fp32: what 'auto' picks on WASM / WebGPU)
                             choices: fp32, fp16, q8, q4, q4f16
  --stt-precision <list>     transcription encoder precisions (default int8,fp16: 'auto' on WASM / WebGPU)
                             choices: int8, fp16, fp32 (fp32 is 2.4 GB)
  --voices <list>            voice ids (default af_heart)
  --source <url>             where to download from (default https://huggingface.co)
  --force                    download files that already exist
  --dry-run                  list the files without downloading

Then serve <dir> and pass its URL as modelBaseUrl (e.g. '/models' when <dir> is public/models).`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const list = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);
const valued = new Set(['--tts-precision', '--stt-precision', '--voices', '--source']);
const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
const target = resolve(positional[0] ?? 'public/models');
const source = option('--source', 'https://huggingface.co').replace(/\/+$/, '');
const onlyTts = args.includes('--tts');
const onlyStt = args.includes('--stt');
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const fromCwd = createRequire(join(process.cwd(), 'package.json'));

/** A package's compiled models.js (plain constants), or null when the package is not installed. */
async function models(name) {
  let manifest;
  try {
    manifest = fromCwd.resolve(`${name}/package.json`);
  } catch {
    return null;
  }
  return import(pathToFileURL(join(dirname(manifest), 'dist', 'models.js')).href);
}

const jobs = []; // { repo, revision, file }
if (!onlyStt) {
  const tts = await models('@localspeech/text-to-speech');
  if (tts) {
    const m = tts.KOKORO_MODEL;
    const precisions = list(option('--tts-precision', 'fp16,fp32'));
    for (const p of precisions) {
      if (!m.dtypeFiles[p]) fail(`unknown --tts-precision "${p}" (choices: ${Object.keys(m.dtypeFiles).join(', ')})`);
    }
    const files = [m.tokenizerFile, ...precisions.map((p) => m.dtypeFiles[p]), ...list(option('--voices', 'af_heart')).map((v) => m.voiceFile(v))];
    for (const file of files) jobs.push({ repo: m.repo, revision: m.revision, file });
  } else if (onlyTts) fail('@localspeech/text-to-speech is not installed here.');
}
if (!onlyTts) {
  const stt = await models('@localspeech/speech-to-text');
  if (stt) {
    const m = stt.PARAKEET_MODEL;
    const precisions = list(option('--stt-precision', 'int8,fp16'));
    for (const p of precisions) {
      if (!m.files.encoder[p]) fail(`unknown --stt-precision "${p}" (choices: ${Object.keys(m.files.encoder).join(', ')})`);
    }
    const files = [m.files.tokenizer, m.files.decoder, ...precisions.flatMap((p) => m.files.encoder[p])];
    for (const file of files) jobs.push({ repo: m.repo, revision: m.revision, file });
  } else if (onlyStt) fail('@localspeech/speech-to-text is not installed here.');
}
if (jobs.length === 0) fail('none of @localspeech/text-to-speech, @localspeech/speech-to-text is installed here.');

let downloaded = 0;
for (const { repo, revision, file } of jobs) {
  const dest = join(target, ...repo.split('/'), 'resolve', revision, ...file.split('/'));
  if (!dest.startsWith(target + sep)) fail(`refusing to write outside ${target}: ${file}`);
  const shown = relative(process.cwd(), dest);
  if (!force && existsSync(dest) && statSync(dest).size > 0) {
    console.log(`localspeech-models: have ${shown}`);
    continue;
  }
  const url = `${source}/${repo}/resolve/${revision}/${file}`;
  if (dryRun) {
    console.log(`localspeech-models: would download ${url}\n                    → ${shown}`);
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) fail(`${url}: HTTP ${res.status}`);
  const part = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
  renameSync(part, dest);
  const size = statSync(dest).size;
  downloaded += size;
  console.log(`localspeech-models: ${shown} (${(size / 1e6).toFixed(1)} MB)`);
}
if (!dryRun) {
  const publicDir = resolve('public');
  const hint = target.startsWith(publicDir + sep) ? `/${relative(publicDir, target).split(sep).join('/')}` : '<the URL you serve it at>';
  console.log(`localspeech-models: done (${(downloaded / 1e6).toFixed(0)} MB downloaded). Use modelBaseUrl: '${hint}'.`);
}

function fail(message) {
  console.error(`localspeech-models: ${message}`);
  process.exit(1);
}


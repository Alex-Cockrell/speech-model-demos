#!/usr/bin/env node
// Mirrors the pinned Parakeet, Kokoro and speaker-embedding model files from Hugging Face into a Cloudflare R2 bucket
// (spec §15, option B). Each file streams from its pinned Hugging Face URL straight into an R2
// multipart upload; nothing is staged on disk. Object keys use the Hugging Face layout
// {repo}/resolve/{revision}/{file}, so the app only swaps the base URL (modelFileUrl in @localspeech/core).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

// What the app can load, at the revisions pinned in packages/*/src/models.ts (PARAKEET_MODEL, KOKORO_MODEL) and src/lib/config.ts (SPEAKER_MODEL).
// Keep them in sync: a revision change there means updating MANIFEST and re-running this script.
// VOICES must cover the voice picker (VOICES in src/lib/benchmark/settings.ts); 0.5 MB each.
const VOICES = ['af_heart', 'am_michael'];
const MANIFEST = [
  {
    configName: 'PARAKEET_MODEL',
    configFile: 'packages/speech-to-text/src/models.ts',
    repo: 'ysdede/parakeet-tdt-0.6b-v3-onnx',
    revision: 'f88260fa0777fe0868dda6df85d1a98f012a4a7a',
    files: ['encoder-model.int8.onnx', 'encoder-model.fp16.onnx', 'decoder_joint-model.int8.onnx', 'vocab.txt'],
    // fp32 encoder: a 40 MB graph plus 2.3 GB of external weights. Only with --include-fp32.
    fp32Files: ['encoder-model.onnx', 'encoder-model.onnx.data'],
  },
  {
    configName: 'KOKORO_MODEL',
    configFile: 'packages/text-to-speech/src/models.ts',
    repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
    files: [
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/model_quantized.onnx',
      'onnx/model.onnx',
      'onnx/model_fp16.onnx',
      ...VOICES.map((voice) => `voices/${voice}.bin`),
    ],
    fp32Files: [],
  },
  {
    // Meeting mode speaker labels (CAM++); one 29.6 MB file of a repo that holds many other models.
    configName: 'SPEAKER_MODEL',
    configFile: 'src/lib/config.ts',
    repo: 'csukuangfj/speaker-embedding-models',
    revision: '0743f301363dec56491a490f6d6cbc9d67f9a3bf',
    files: ['3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx'],
    fp32Files: [],
  },
];

const HUGGING_FACE = 'https://huggingface.co';
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** Upload buffers at most QUEUE_SIZE × PART_SIZE (128 MiB). R2 needs ≥ 5 MiB parts, at most 10,000. */
const PART_SIZE = 32 * 1024 * 1024;
const QUEUE_SIZE = 4;

const HELP = `Usage:
  node scripts/mirror-models-to-r2.mjs [--include-fp32] [--force] [--dry-run]
  node scripts/mirror-models-to-r2.mjs --verify <publicBaseUrl> --origin <appOrigin> [--include-fp32]

Upload mode copies the pinned model files from Hugging Face to R2 under
  {repo}/resolve/{revision}/{file}
with Content-Type and "Cache-Control: ${CACHE_CONTROL}". Objects that already exist
with the expected size are skipped, so an interrupted run can simply be restarted.

Options:
  --include-fp32   Also mirror the fp32 Parakeet encoder (encoder-model.onnx + 2.3 GB .data).
  --force          Re-upload objects even if they already exist with the expected size.
  --dry-run        Print the files, sizes and object keys; upload nothing. Needs no R2 credentials.
  --verify <url>   Check every file through the bucket's public URL (custom domain or r2.dev):
                   HTTP status, size, and Access-Control-Allow-Origin for --origin. Needs no credentials.
  --origin <url>   The app origin to send as Origin with --verify, e.g. https://speech-test.example.com
  -h, --help       Show this help.

Environment (upload mode):
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET   required
  R2_ENDPOINT    optional; default https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
                 (EU jurisdiction buckets: https://<R2_ACCOUNT_ID>.eu.r2.cloudflarestorage.com)
  HF_TOKEN       optional Hugging Face token (higher download rate limits)`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let currentUpload = null;
process.once('SIGINT', () => {
  console.error('\nInterrupted; aborting the multipart upload in progress…');
  Promise.resolve(currentUpload?.abort())
    .catch(() => {})
    .finally(() => process.exit(130));
});

main().catch((err) => {
  console.error(`\nmirror-models-to-r2: ${err.message}`);
  process.exit(1);
});

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }
  checkManifestAgainstConfig();
  const plan = await buildPlan(opts.includeFp32);

  if (opts.verify) {
    process.exitCode = (await verify(plan, opts.verify, opts.origin)) ? 0 : 1;
  } else if (opts.dryRun) {
    printPlan(plan);
  } else {
    process.exitCode = (await upload(plan, opts.force)) ? 0 : 1;
  }
}

function parseArgs(args) {
  const opts = { includeFp32: false, force: false, dryRun: false, verify: null, origin: null, help: false };
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s, 2);
    const value = () => {
      const v = inline ?? args[++i];
      if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value. See --help.`);
      return v;
    };
    switch (flag) {
      case '--include-fp32':
        opts.includeFp32 = true;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--verify':
        opts.verify = value().replace(/\/+$/, '');
        break;
      case '--origin':
        opts.origin = value().replace(/\/+$/, '');
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        throw new Error(`unknown option ${args[i]}. See --help.`);
    }
  }
  if (opts.verify && !opts.origin) throw new Error('--verify needs --origin <appOrigin> (the origin the app is served from).');
  if (opts.origin && !opts.verify) throw new Error('--origin is only used with --verify.');
  for (const [name, url] of [['--verify', opts.verify], ['--origin', opts.origin]]) {
    if (url && !/^https?:\/\/[^/]+/.test(url)) throw new Error(`${name} must be an http(s) URL, got "${url}".`);
  }
  return opts;
}

/** Fails when the code pins a different repo/revision than this manifest (the mirror would 404). */
function checkManifestAgainstConfig() {
  for (const model of MANIFEST) {
    const configPath = join(ROOT, model.configFile);
    if (!existsSync(configPath)) continue;
    const source = readFileSync(configPath, 'utf8');
    const block = new RegExp(`export const ${model.configName} = \\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? '';
    const repo = /\brepo:\s*'([^']+)'/.exec(block)?.[1];
    const revision = /\brevision:\s*'([^']+)'/.exec(block)?.[1];
    if (repo !== model.repo || revision !== model.revision) {
      throw new Error(
        `${model.configFile} ${model.configName} pins ${repo}@${revision} but this script mirrors ${model.repo}@${model.revision}. ` +
          'Update MANIFEST in scripts/mirror-models-to-r2.mjs.',
      );
    }
  }
}

async function buildPlan(includeFp32) {
  const plan = [];
  for (const model of MANIFEST) {
    const sizes = await repoFileSizes(model.repo, model.revision);
    for (const file of [...model.files, ...(includeFp32 ? model.fp32Files : [])]) {
      const size = sizes.get(file);
      if (size === undefined) throw new Error(`${file} does not exist in ${model.repo} at ${model.revision}.`);
      const key = `${model.repo}/resolve/${model.revision}/${file}`;
      plan.push({ repo: model.repo, file, key, size, sourceUrl: `${HUGGING_FACE}/${key}` });
    }
  }
  return plan;
}

/** File sizes from the Hugging Face tree API (follows its Link-header pagination). */
async function repoFileSizes(repo, revision) {
  const sizes = new Map();
  let url = `${HUGGING_FACE}/api/models/${repo}/tree/${revision}?recursive=true`;
  while (url) {
    const res = await fetch(url, { headers: hfHeaders({ accept: 'application/json' }) });
    if (!res.ok) throw new Error(`Hugging Face API returned HTTP ${res.status} for ${url}`);
    for (const entry of await res.json()) if (entry.type === 'file') sizes.set(entry.path, entry.size);
    url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
  }
  return sizes;
}

function hfHeaders(extra = {}) {
  return process.env.HF_TOKEN ? { ...extra, authorization: `Bearer ${process.env.HF_TOKEN}` } : extra;
}

function printPlan(plan) {
  console.log('Dry run: these objects would be uploaded (existing objects of the same size are skipped).\n');
  for (const item of plan) console.log(`  ${formatMB(item.size).padStart(10)}  ${item.key}`);
  console.log(`\n  ${formatMB(sum(plan)).padStart(10)}  total, ${plan.length} files`);
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

async function upload(plan, force) {
  const env = requireEnv(['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']);
  const endpoint = process.env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const { S3Client, HeadObjectCommand } = await import('@aws-sdk/client-s3');
  const { Upload } = await import('@aws-sdk/lib-storage');
  const client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
    // Since v3.729 the SDK adds CRC32 checksums (and trailing-checksum streaming) by default; R2 does not
    // accept every variant, and it is not needed here because sizes are verified after each upload.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const bucket = env.R2_BUCKET;
  const headObject = async (Key) => {
    try {
      const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key }));
      return { size: out.ContentLength ?? null };
    } catch (err) {
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return null;
      throw new Error(`HeadObject ${Key} failed: ${err.message ?? err} (check the R2 credentials, bucket and endpoint)`);
    }
  };

  console.log(`Mirroring ${plan.length} files (${formatMB(sum(plan))}) to r2://${bucket} via ${endpoint}\n`);
  const started = performance.now();
  const results = { uploaded: [], skipped: [], failed: [] };
  for (const [index, item] of plan.entries()) {
    const label = `[${index + 1}/${plan.length}] ${item.repo.split('/')[1]}/${item.file}`;
    try {
      const existing = await headObject(item.key);
      if (existing && existing.size === item.size && !force) {
        console.log(`${label}  already uploaded (${formatMB(item.size)}), skipped`);
        results.skipped.push(item);
        continue;
      }
      if (existing && existing.size !== item.size) {
        console.log(`${label}  exists with ${existing.size} bytes instead of ${item.size}, replacing`);
      }
      const fileStarted = performance.now();
      const progress = progressPrinter(label, item.size);
      const res = await fetch(item.sourceUrl, { headers: hfHeaders({ 'accept-encoding': 'identity' }) });
      if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} from ${item.sourceUrl}`);
      const declared = Number(res.headers.get('content-length'));
      if (declared && declared !== item.size) {
        await res.body.cancel();
        throw new Error(`Hugging Face sent Content-Length ${declared}, expected ${item.size}`);
      }
      currentUpload = new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: item.key,
          Body: Readable.fromWeb(res.body),
          ContentLength: item.size,
          ContentType: contentType(item.file),
          CacheControl: CACHE_CONTROL,
        },
        partSize: PART_SIZE,
        queueSize: QUEUE_SIZE,
        leavePartsOnError: false,
      });
      currentUpload.on('httpUploadProgress', (p) => progress(p.loaded ?? 0));
      await currentUpload.done();
      currentUpload = null;

      const stored = await headObject(item.key);
      if (stored?.size !== item.size) throw new Error(`stored object is ${stored?.size ?? 'missing'} bytes, expected ${item.size}`);
      progress.done(performance.now() - fileStarted);
      results.uploaded.push(item);
    } catch (err) {
      currentUpload = null;
      console.error(`\n${label}  FAILED: ${err.message ?? err}`);
      results.failed.push(item);
    }
  }

  const seconds = (performance.now() - started) / 1000;
  console.log(
    `\nUploaded ${results.uploaded.length} (${formatMB(sum(results.uploaded))}), skipped ${results.skipped.length}, ` +
      `failed ${results.failed.length} in ${seconds.toFixed(0)} s.`,
  );
  if (results.failed.length) console.log('Re-run the script to retry; finished files are skipped.');
  return results.failed.length === 0;
}

function requireEnv(names) {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`missing environment variable(s): ${missing.join(', ')}. See --help (or use --dry-run).`);
  }
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function contentType(file) {
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/** Rewrites one line on a terminal; prints at most every 10% otherwise (CI logs). */
function progressPrinter(label, total) {
  const started = performance.now();
  let lastDecile = -1;
  const line = (loaded) => {
    const seconds = (performance.now() - started) / 1000;
    const rate = seconds > 0 ? loaded / 1e6 / seconds : 0;
    return `${label}  ${formatMB(loaded)} / ${formatMB(total)}  ${percent(loaded, total)}  ${rate.toFixed(1)} MB/s`;
  };
  const update = (loaded) => {
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${line(loaded)}\x1b[K`);
      return;
    }
    const decile = Math.floor((loaded / total) * 10);
    if (decile > lastDecile) {
      lastDecile = decile;
      console.log(line(loaded));
    }
  };
  update.done = (ms) => {
    const message = `${label}  ${formatMB(total)} uploaded in ${(ms / 1000).toFixed(1)} s (${(total / 1e3 / ms).toFixed(1)} MB/s)`;
    if (process.stdout.isTTY) process.stdout.write(`\r${message}\x1b[K\n`);
    else console.log(message);
  };
  update(0);
  return update;
}

// ---------------------------------------------------------------------------
// Verify (no credentials): what the browser will see through the public URL
// ---------------------------------------------------------------------------

async function verify(plan, baseUrl, origin) {
  console.log(`Checking ${plan.length} files at ${baseUrl} with Origin: ${origin}\n`);
  let failures = 0;
  for (const item of plan) {
    const url = `${baseUrl}/${item.key}`;
    const problems = [];
    let details = '';
    try {
      // HEAD avoids downloading the weights; r2/cors.json allows HEAD as well as GET. identity keeps
      // Cloudflare from compressing .json/.txt on the fly, which would drop Content-Length.
      const res = await fetch(url, { method: 'HEAD', headers: { origin, 'accept-encoding': 'identity' } });
      const allowOrigin = res.headers.get('access-control-allow-origin');
      const length = Number(res.headers.get('content-length'));
      if (res.status !== 200) problems.push(`HTTP ${res.status}`);
      else if (length !== item.size) problems.push(`Content-Length ${length || 'missing'}, expected ${item.size}`);
      if (allowOrigin !== '*' && allowOrigin !== origin) {
        problems.push(allowOrigin ? `Access-Control-Allow-Origin is "${allowOrigin}"` : 'no Access-Control-Allow-Origin header');
      }
      details = [
        `cf-cache-status: ${res.headers.get('cf-cache-status') ?? '-'}`,
        `cache-control: ${res.headers.get('cache-control') ?? '-'}`,
      ].join(', ');
    } catch (err) {
      problems.push(`request failed: ${err.cause?.message ?? err.message}`);
    }
    if (problems.length) failures++;
    console.log(`${problems.length ? 'FAIL' : 'OK  '}  ${formatMB(item.size).padStart(10)}  ${item.key}`);
    console.log(`        ${problems.length ? problems.join('; ') : details}`);
  }
  console.log(`\n${plan.length - failures} OK, ${failures} failed.`);
  if (failures) {
    console.log(
      'A missing or wrong Access-Control-Allow-Origin on a cached file can be a stale edge copy: Cloudflare caches the ' +
        'CORS headers of whichever request filled the cache (see README, "R2 mirror").',
    );
  }
  return failures === 0;
}

// ---------------------------------------------------------------------------

function sum(items) {
  return items.reduce((total, item) => total + item.size, 0);
}

function formatMB(bytes) {
  return bytes < 1e5 ? `${(bytes / 1e3).toFixed(1)} kB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

function percent(loaded, total) {
  return `${total ? Math.floor((loaded / total) * 100) : 0}%`;
}

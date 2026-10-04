/**
 * Kokoro TTS worker: kokoro-js (transformers.js + ONNX Runtime Web) load, warm-up and streaming synthesis.
 * Message protocol: ./protocol.ts. TtsEngine spawns a fresh worker for every load configuration, so a worker
 * loads exactly one model.
 */
import { env, type ProgressInfo } from '@huggingface/transformers';
import { KokoroTTS, type GenerateOptions } from 'kokoro-js';
import { now, setMainTimeOrigin } from '../clock';
import { KOKORO_MODEL, ORT_ASSETS } from '../config';
import { installFetchInstrumentation, summarizeDownloads, type FetchInstrumentation } from '../net/instrument';
import type { DownloadMetrics, FileFetchRecord, LoadProgress, WasmRuntimeInfo } from '../types';
import {
  errorMessage,
  type LoadRequest,
  type SpeakRequest,
  type TtsWorkerEvent,
  type TtsWorkerRequest,
  type WorkerLoadResult,
} from './protocol';
import { splitterFor } from './split';
import { prefetchVoice } from './voice-cache';

type KokoroVoice = NonNullable<GenerateOptions['voice']>;
type OrtWasmFlags = NonNullable<typeof env.backends.onnx.wasm>;

const WARMUP_TEXT = 'Hello.';
/** transformers.js reports every network read; forward byte progress at most this often per file. */
const PROGRESS_INTERVAL_MS = 100;
const WASM_INIT_TIMEOUT_MS = 120_000;

let instrumentation: FetchInstrumentation | null = null;
let tts: KokoroTTS | null = null;
let loadedVoice: string | null = null;
/** Speak runs execute one after another; a new run waits for the previous one's in-flight inference. */
let speakQueue: Promise<void> = Promise.resolve();
const queuedRuns = new Set<number>();
const cancelledRuns = new Set<number>();

function post(msg: TtsWorkerEvent, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

function progress(p: Omit<LoadProgress, 'model'>): void {
  post({ type: 'progress', progress: { model: 'kokoro', ...p } });
}

async function load(req: LoadRequest): Promise<WorkerLoadResult> {
  setMainTimeOrigin(req.timeOrigin);
  if (instrumentation) throw new Error('This TTS worker has already loaded a model.');
  instrumentation = installFetchInstrumentation({ source: req.source, pinnedRevisions: req.pinnedRevisions });
  instrumentation.beginCapture();
  const started = now();

  const wasm = env.backends.onnx.wasm;
  if (!wasm) throw new Error('ONNX Runtime Web did not expose its WASM backend settings.');
  // A string prefix makes ORT import its standalone .mjs glue from our origin, so its pthread workers are
  // created from that real file instead of the bundled worker chunk. ORT expects an absolute URL here.
  wasm.wasmPaths = new URL(ORT_ASSETS.kokoro.wasmPaths, self.location.href).href;
  wasm.numThreads = req.wasmThreads > 0 ? req.wasmThreads : defaultThreads();
  // If pthread workers cannot start (e.g. /ort/ served without COOP/COEP/CORP), Emscripten waits forever;
  // this turns that into a load error. Generous, because it also covers fetching the 21 MB .wasm.
  wasm.initTimeout = WASM_INIT_TIMEOUT_MS;
  env.allowLocalModels = false;

  const weights = KOKORO_MODEL.dtypeFiles[req.dtype];
  const modelFiles: string[] = [...KOKORO_MODEL.supportFiles, weights];
  const voiceFile = KOKORO_MODEL.voiceFile(req.voice);
  const doneAt = new Map<string, number>();

  if (req.device === 'webgpu') await assertWebGpuAdapter();
  progress({ phase: 'download', message: `Loading ${weights} (${req.dtype}) for ${req.device}` });
  const [model] = await Promise.all([
    KokoroTTS.from_pretrained(KOKORO_MODEL.repo, {
      dtype: req.dtype,
      device: req.device,
      progress_callback: progressForwarder(modelFiles, doneAt, req.device),
    }),
    prefetchVoice(req.voice).then((bytes) =>
      progress(
        bytes > 0
          ? { phase: 'download', file: voiceFile, loadedBytes: bytes, totalBytes: bytes, message: 'done' }
          : { phase: 'download', file: voiceFile, message: 'done' },
      ),
    ),
  ]);
  // The voice embedding is a model input, so the model can run its first inference only once both are in.
  const modelReady = now();

  progress({ phase: 'warmup', message: 'Warm-up synthesis' });
  const warmupStart = now();
  await model.generate(WARMUP_TEXT, { voice: req.voice as KokoroVoice });
  const warmupMs = now() - warmupStart;

  const records = instrumentation.endCapture();
  const download = summarizeDownloads([...modelFiles, voiceFile], records);
  tts = model;
  loadedVoice = req.voice;
  progress({ phase: 'ready' });
  return {
    download,
    loadKind: classifyLoad(download),
    initializationStart: Math.min(modelReady, dataReadyAt(modelFiles, doneAt, records) ?? started),
    modelReady,
    warmupMs,
    wasm: wasmRuntimeInfo(req.wasmThreads, wasm),
  };
}

/**
 * ORT only discovers a missing adapter when it creates the session, i.e. after the weights (311 MB for fp32)
 * have downloaded. Failing first makes forced WebGPU fail fast and lets Auto fall back without that download.
 */
async function assertWebGpuAdapter(): Promise<void> {
  if (!('gpu' in navigator)) throw new Error('WebGPU is not available in this worker (navigator.gpu is missing).');
  // Same preference transformers.js gives ONNX Runtime.
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available in this worker (requestAdapter() returned null).');
}

/** Forwards transformers.js progress as LoadProgress and records when each file was fully read ('done'). */
function progressForwarder(modelFiles: string[], doneAt: Map<string, number>, device: string) {
  const waiting = new Set(modelFiles);
  const lastPosted = new Map<string, number>();
  const bytes = new Map<string, { loaded: number; total: number }>();
  let initializing = false;
  return (p: ProgressInfo): void => {
    if (p.status === 'ready') return;
    const at = now();
    if (p.status === 'progress') {
      bytes.set(p.file, { loaded: p.loaded, total: p.total });
      if (at - (lastPosted.get(p.file) ?? -Infinity) < PROGRESS_INTERVAL_MS) return;
      lastPosted.set(p.file, at);
      progress({ phase: 'download', file: p.file, loadedBytes: p.loaded, totalBytes: p.total });
      return;
    }
    if (p.status !== 'done') {
      progress({ phase: 'download', file: p.file, message: p.status });
      return;
    }
    doneAt.set(p.file, at);
    waiting.delete(p.file);
    const read = bytes.get(p.file);
    progress({ phase: 'download', file: p.file, loadedBytes: read?.loaded, totalBytes: read?.total, message: 'done' });
    if (waiting.size === 0 && !initializing) {
      initializing = true;
      progress({ phase: 'initialize', message: `Creating the ${device} inference session` });
    }
  };
}

/**
 * initializationStart: when the last file from_pretrained needs (config, tokenizer files, ONNX weights) became
 * fully available — per file, the later of transformers.js's 'done' event (fires once the bytes have been read,
 * from the network or the Cache API, and after a fresh download has been written to the cache) and the
 * instrumentation's network completeAt. ORT session creation starts right after. The voice file is excluded:
 * it downloads in parallel and only the warm-up needs it.
 */
function dataReadyAt(files: string[], doneAt: Map<string, number>, records: FileFetchRecord[]): number | null {
  let latest: number | null = null;
  for (const file of files) {
    const times = [doneAt.get(file), ...records.filter((r) => r.file === file).map((r) => r.completeAt)];
    for (const t of times) if (t != null && (latest === null || t > latest)) latest = t;
  }
  return latest;
}

function classifyLoad(download: DownloadMetrics): WorkerLoadResult['loadKind'] {
  const fetched = new Set(download.networkFiles.map((r) => r.file));
  if (!download.expectedFiles.some((f) => fetched.has(f))) return 'warm';
  return download.cachedFiles.length === 0 ? 'cold' : 'partial';
}

/**
 * Kokoro on WASM speeds up to ~8 threads and then flattens (fp16: 0.67× real time on 4, 0.45× on 8, 0.43× on 16),
 * so 'auto' uses up to 8 instead of ORT's own min(4, cores / 2).
 */
function defaultThreads(): number {
  return Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4));
}

function wasmRuntimeInfo(requested: number, wasm: OrtWasmFlags): WasmRuntimeInfo {
  // Reporting the automatic count as the request makes a non-isolated page show up as "multithreading
  // unavailable" (spec §16) instead of silently running on one thread.
  const requestedThreads = requested > 0 ? requested : defaultThreads();
  // ORT writes the thread count it actually initialised with back into env.wasm.numThreads.
  const effectiveThreads = wasm.numThreads && wasm.numThreads > 0 ? wasm.numThreads : 1;
  const multithreadingUnavailable = requestedThreads > 1 && effectiveThreads <= 1;
  return {
    requestedThreads,
    effectiveThreads,
    multithreadingUnavailable,
    reason: multithreadingUnavailable ? singleThreadReason() : null,
    // ORT >= 1.19 ships only SIMD builds and refuses to start without SIMD unless the check is disabled.
    simd: wasm.simd !== false,
    wasmPaths: typeof wasm.wasmPaths === 'string' ? wasm.wasmPaths : JSON.stringify(wasm.wasmPaths ?? null),
  };
}

function singleThreadReason(): string {
  if (!globalThis.crossOriginIsolated) {
    return 'The page is not cross-origin isolated (COOP/COEP headers missing), so SharedArrayBuffer is unavailable and ONNX Runtime runs single-threaded.';
  }
  if (typeof SharedArrayBuffer === 'undefined') {
    return 'SharedArrayBuffer is unavailable, so ONNX Runtime runs single-threaded.';
  }
  return 'ONNX Runtime could not start WebAssembly threads and fell back to one thread (see the console warning).';
}

async function speak(req: SpeakRequest): Promise<void> {
  const model = tts;
  if (!model) throw new Error('Kokoro is not loaded in this worker.');
  let index = 0;
  try {
    if (!cancelledRuns.has(req.id)) {
      const chunks = model.stream(splitterFor(req.text, req.split), {
        voice: req.voice as KokoroVoice,
        speed: req.speed,
      });
      let generationStart = now();
      for await (const { text, audio } of chunks) {
        const generatedAt = now();
        if (cancelledRuns.has(req.id)) break;
        const samples = ownedSamples(audio.audio);
        post(
          { type: 'chunk', id: req.id, index, text, generationStart, generatedAt, audio: samples, sampleRate: audio.sampling_rate },
          [samples.buffer],
        );
        index++;
        generationStart = now();
      }
    }
  } catch (e) {
    if (req.voice === loadedVoice) throw e;
    // kokoro-js fetches a voice that load() did not pre-fetch on first use, which fails offline.
    throw new Error(`${errorMessage(e)} (voice "${req.voice}" was not pre-loaded; load() fetched "${loadedVoice}")`);
  }
  post({ type: 'done', id: req.id, generationCompleteAt: now(), chunkCount: index, cancelled: cancelledRuns.has(req.id) });
}

/** The PCM in a Float32Array that owns its whole buffer, so the buffer can be transferred. */
function ownedSamples(samples: Float32Array): Float32Array<ArrayBuffer> {
  const { buffer } = samples;
  if (buffer instanceof ArrayBuffer && samples.byteOffset === 0 && samples.byteLength === buffer.byteLength) {
    return samples as Float32Array<ArrayBuffer>;
  }
  return new Float32Array(samples);
}

self.addEventListener('message', (event: MessageEvent<TtsWorkerRequest>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'load':
      load(msg).then(
        (result) => post({ type: 'loaded', id: msg.id, result }),
        (e: unknown) => post({ type: 'error', id: msg.id, message: errorMessage(e) }),
      );
      return;
    case 'speak':
      queuedRuns.add(msg.id);
      speakQueue = speakQueue
        .then(() => speak(msg))
        .catch((e: unknown) => post({ type: 'error', id: msg.id, message: errorMessage(e) }))
        .finally(() => {
          queuedRuns.delete(msg.id);
          cancelledRuns.delete(msg.id);
        });
      return;
    case 'cancel':
      if (queuedRuns.has(msg.id)) cancelledRuns.add(msg.id);
      return;
    case 'requestCount':
      post({ type: 'requestCount', id: msg.id, count: instrumentation?.requestCount ?? 0 });
      return;
  }
});

// Failures not tied to a request must still reach the main thread, or its pending promises would hang.
self.addEventListener('error', (event: ErrorEvent) => {
  event.preventDefault();
  console.error(event.error ?? event.message);
  post({ type: 'error', id: null, message: `Uncaught error in the TTS worker: ${event.message}` });
});
self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  post({ type: 'error', id: null, message: `Unhandled rejection in the TTS worker: ${errorMessage(event.reason)}` });
});

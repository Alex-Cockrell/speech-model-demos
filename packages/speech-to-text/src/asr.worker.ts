/**
 * ASR worker: parakeet.js on ONNX Runtime Web. One worker loads one model configuration; the engine
 * terminates it and spawns a new one to change backend, quantization, threads or source.
 * Message protocol: ./protocol.ts. The main thread decides what to transcribe (transcriber.ts); this worker
 * runs one pass per 'pass' message.
 */
import * as ort from 'onnxruntime-web';
import { ParakeetModel, type TranscribeResult } from 'parakeet.js';
import { now, setMainTimeOrigin } from '@localspeech/core';
import { PARAKEET_MODEL, PARAKEET_RUNTIME } from './models.js';
import { installFetchInstrumentation, summarizeDownloads, type FetchInstrumentation } from '@localspeech/core';
import type { LoadProgress, ModelSource, WasmRuntimeInfo } from '@localspeech/core';
import type { ParakeetQuant } from './types.js';
import { expectedFileList, parakeetFiles, type ParakeetFiles } from './model-files.js';
import { canonicalModelUrl, openModelCache, retrieveModelFile, type ByteProgress } from '@localspeech/core';
import {
  ASR_SAMPLE_RATE,
  describeError,
  resolveWasmThreads,
  type LoadRequest,
  type LoadResult,
  type MainToWorker,
  type PassRequest,
  type PassResult,
  type PassWord,
  type WorkerToMain,
} from './protocol.js';

const PROGRESS_INTERVAL_MS = 100;

let instrumentation: FetchInstrumentation | null = null;
let loadStarted = false;
let model: ParakeetModel | null = null;
/** ORT sessions must not run concurrently, so every inference goes through this queue. */
let inferenceQueue: Promise<unknown> = Promise.resolve();
/** The buffer whose mel frames parakeet.js's incremental mel cache currently holds (see melPrefix). */
let melOwner: { key: string; samples: number } | null = null;

function post(message: WorkerToMain): void {
  self.postMessage(message);
}

function progress(update: Omit<LoadProgress, 'model'>): void {
  post({ type: 'progress', progress: { model: 'parakeet', ...update } });
}

self.addEventListener('message', (event: MessageEvent<MainToWorker>) => {
  const message = event.data;
  switch (message.type) {
    case 'load':
      void handleLoad(message);
      break;
    case 'pass':
      void handlePass(message);
      break;
    case 'count':
      post({ type: 'count', requestId: message.requestId, count: instrumentation?.requestCount ?? 0 });
      break;
  }
});

self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  post({ type: 'unexpectedError', message: `Unhandled error in the ASR worker: ${describeError(event.reason)}` });
});

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function handleLoad(request: LoadRequest): Promise<void> {
  if (loadStarted) {
    post({ type: 'loadError', message: 'This ASR worker already loaded a model.' });
    return;
  }
  loadStarted = true;
  try {
    setMainTimeOrigin(request.timeOrigin);
    instrumentation = installFetchInstrumentation({ source: request.source, pinnedRevisions: request.pinnedRevisions });
    post({ type: 'loaded', result: await loadModel(request, instrumentation) });
  } catch (err) {
    post({ type: 'loadError', message: describeError(err) });
  }
}

async function loadModel(request: LoadRequest, net: FetchInstrumentation): Promise<LoadResult> {
  const bundled = ort.env.versions.web;
  if (bundled && bundled !== PARAKEET_RUNTIME.version) {
    throw new Error(
      `The bundled inference runtime (${bundled}) does not match the self-hosted runtime files (${PARAKEET_RUNTIME.version}).`,
    );
  }
  // Must be set before parakeet.js's initOrt(), which otherwise points ORT at jsDelivr. A same-origin
  // prefix also makes ORT import the standalone ort-wasm-simd-threaded.jsep.mjs (and spawn that as its
  // pthread workers) instead of the copy bundled into this worker chunk.
  const wasmPaths = new URL(PARAKEET_RUNTIME.wasmPaths, self.location.origin).href;
  ort.env.wasm.wasmPaths = wasmPaths;
  if (request.backend === 'webgpu') await checkWebGpuAdapter(request.quant);

  const files = parakeetFiles(request.quant);
  const expected = expectedFileList(files);
  const { cache, error: cacheError } = await openModelCache();
  if (cacheError) storageNotice(`Model files will not be kept for next time: ${cacheError}.`);

  net.beginCapture();
  const blobs = new Map<string, Blob>();
  let networkFiles = 0;
  // Smallest first: once storing fails, the large files skip the Cache API instead of each being
  // downloaded twice (see retrieveModelFile).
  const downloadOrder = [files.tokenizer, files.decoder, files.encoder, ...(files.encoderData ? [files.encoderData] : [])];
  let store = true;
  for (const file of downloadOrder) {
    const url = canonicalModelUrl(PARAKEET_MODEL.repo, PARAKEET_MODEL.revision, file);
    try {
      const retrieved = await retrieveModelFile(cache, url, downloadProgress(file), store);
      blobs.set(file, retrieved.blob);
      if (retrieved.fromNetwork) networkFiles++;
      if (retrieved.storageError) {
        store = false;
        storageNotice(`${partLabel(files, file)}: ${retrieved.storageError}; it will be downloaded again next time.`, file);
      }
    } catch (err) {
      throw new Error(
        `Downloading the ${partLabel(files, file).toLowerCase()} from ${sourceLabel(request.source)} failed: ${describeError(err)}`,
      );
    }
  }

  const threads = resolveWasmThreads(request.threads, navigator.hardwareConcurrency);
  const initializationStart = now();
  progress({ phase: 'initialize' });
  const created = await createModel(request, threads, files, blobs);
  const modelReady = now();
  blobs.clear();

  progress({ phase: 'warmup' });
  const warmupMs = await warmUp(created);
  // ORT reads the files through blob: URLs, which the instrumentation neither counts nor records.
  const download = summarizeDownloads(expected, net.endCapture());
  model = created;
  return {
    backend: request.backend,
    quant: request.quant,
    loadKind: networkFiles === expected.length ? 'cold' : networkFiles === 0 ? 'warm' : 'partial',
    download,
    initializationStart,
    modelReady,
    warmupMs,
    wasm: wasmRuntimeInfo(threads, wasmPaths),
  };
}

/** A model file as named in messages that reach the UI (the file names identify the model). */
function partLabel(files: ParakeetFiles, file: string): string {
  if (file === files.tokenizer) return 'Vocabulary';
  if (file === files.decoder) return 'Decoder weights';
  return file === files.encoderData ? 'Encoder weights (data)' : 'Encoder weights';
}

/** Where model files come from, as named in messages: a mirror by its host, the default host not by name. */
function sourceLabel(source: ModelSource): string {
  if (source.kind !== 'mirror') return 'the public model host';
  try {
    return `the mirror (${new URL(source.baseUrl).host})`;
  } catch {
    return 'the mirror';
  }
}

/** Fails fast, before a 1–2 GB encoder download, when WebGPU cannot work in this worker. */
async function checkWebGpuAdapter(quant: ParakeetQuant): Promise<void> {
  const gpu = (navigator as Partial<NavigatorGPU>).gpu;
  if (!gpu) throw new Error('WebGPU is not available in the ASR worker (navigator.gpu is missing).');
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU returned no adapter in the ASR worker.');
  if (quant === 'fp16' && !adapter.features.has('shader-f16')) {
    throw new Error("The fp16 encoder needs the WebGPU 'shader-f16' feature, which this adapter lacks; use fp32 or WASM.");
  }
}

async function createModel(request: LoadRequest, threads: number, files: ParakeetFiles, blobs: Map<string, Blob>): Promise<ParakeetModel> {
  const urls = new Map<string, string>();
  const urlOf = (file: string): string => {
    const blob = blobs.get(file);
    if (!blob) throw new Error(`${partLabel(files, file)}: the file was not retrieved.`);
    const url = URL.createObjectURL(blob);
    urls.set(file, url);
    return url;
  };
  const warnings: string[] = [];
  const restoreWarn = collectWarnings(warnings);
  let created: ParakeetModel;
  try {
    created = await ParakeetModel.fromUrls({
      encoderUrl: urlOf(files.encoder),
      encoderDataUrl: files.encoderData ? urlOf(files.encoderData) : null,
      decoderUrl: urlOf(files.decoder),
      tokenizerUrl: urlOf(files.tokenizer),
      filenames: { encoder: files.encoder, decoder: files.decoder },
      // Plain 'webgpu' matches no session branch in parakeet.js 1.4.4 and silently runs on WASM.
      // ('webgpu-strict' creates both sessions in parallel and races ORT's WASM initialisation.)
      backend: request.backend === 'webgpu' ? 'webgpu-hybrid' : 'wasm',
      cpuThreads: threads,
      // 'js' is also what enables the incremental mel cache (melPrefix).
      preprocessorBackend: 'js',
      verbose: false,
      enableProfiling: false,
    });
  } finally {
    restoreWarn();
    for (const url of urls.values()) URL.revokeObjectURL(url);
  }

  if (request.backend === 'webgpu') {
    // The JSEP WebGPU backend defines env.webgpu.device/adapter once it has started. Read the
    // descriptors so a getter (other ORT builds) cannot create a device as a side effect.
    const device = Object.getOwnPropertyDescriptor(ort.env.webgpu, 'device')?.value as GPUDevice | undefined;
    if (!device) {
      const dropped = warnings.find((warning) => warning.includes('"webgpu"'));
      throw new Error(`The runtime did not start its WebGPU backend, so the encoder would run on WASM${dropped ? ` (${dropped})` : ''}.`);
    }
    const adapter = Object.getOwnPropertyDescriptor(ort.env.webgpu, 'adapter')?.value as GPUAdapter | undefined;
    console.info('[asr] Parakeet encoder is running on WebGPU', adapter?.info ?? '');
  }
  return created;
}

/** In hybrid mode ORT drops an execution provider that fails to start with only a console warning. */
function collectWarnings(sink: string[]): () => void {
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    sink.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
    original.apply(console, args);
  };
  return () => {
    console.warn = original;
  };
}

async function warmUp(created: ParakeetModel): Promise<number> {
  // ~1 s of very quiet noise: compiles WebGPU shaders / primes WASM kernels before the first real pass.
  const audio = new Float32Array(ASR_SAMPLE_RATE);
  let seed = 0x2545f491;
  for (let i = 0; i < audio.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    audio[i] = (seed / 0x100000000 - 0.5) * 2e-3;
  }
  const { ms } = await infer(() => created.transcribe(audio, ASR_SAMPLE_RATE, { enableProfiling: false }));
  return ms;
}

function wasmRuntimeInfo(requestedThreads: number, wasmPaths: string): WasmRuntimeInfo {
  // initOrt() and ORT itself lower env.wasm.numThreads to 1 when threads cannot work.
  const effectiveThreads = ort.env.wasm.numThreads ?? 1;
  const unavailable = requestedThreads > 1 && effectiveThreads <= 1;
  return {
    requestedThreads,
    effectiveThreads,
    multithreadingUnavailable: unavailable,
    reason: unavailable ? threadingUnavailableReason() : null,
    // ORT 1.24 ships only SIMD builds and refuses to initialise without WebAssembly SIMD.
    simd: true,
    wasmPaths,
  };
}

function threadingUnavailableReason(): string {
  if (!self.crossOriginIsolated) {
    return 'The page is not cross-origin isolated (COOP/COEP headers), so SharedArrayBuffer is unavailable and inference runs single-threaded.';
  }
  if (typeof SharedArrayBuffer === 'undefined') return 'SharedArrayBuffer is unavailable, so inference runs single-threaded.';
  return 'The runtime could not start WebAssembly threads and fell back to a single thread (see the console).';
}

/** Also logged: the UI only shows the latest progress message, and this one matters for warm loads. */
function storageNotice(message: string, file?: string): void {
  console.warn(`[asr] ${message}`);
  progress({ phase: 'download', file, message });
}

function downloadProgress(file: string): ByteProgress {
  let lastPost = -Infinity;
  return (loaded, total, done) => {
    const t = now();
    if (!done && t - lastPost < PROGRESS_INTERVAL_MS) return;
    lastPost = t;
    progress({ phase: 'download', file, loadedBytes: loaded, totalBytes: total ?? undefined });
  };
}

// ---------------------------------------------------------------------------
// Inference passes
// ---------------------------------------------------------------------------

function infer<T>(task: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const result = inferenceQueue.then(async () => {
    const start = now();
    const value = await task();
    return { value, ms: now() - start };
  });
  inferenceQueue = result.catch(() => undefined);
  return result;
}

async function handlePass(request: PassRequest): Promise<void> {
  const current = model;
  if (!current) {
    post({ type: 'passError', passId: request.passId, message: 'The transcription model is not loaded in this worker.' });
    return;
  }
  try {
    const { value, ms } = await infer(() => runPass(current, request));
    post({ type: 'passResult', passId: request.passId, ...value, computeMs: ms });
  } catch (err) {
    // The cache may hold frames of a buffer that never finished; start the next buffer from scratch.
    melOwner = null;
    current.resetMelCache();
    post({ type: 'passError', passId: request.passId, message: describeError(err) });
  }
}

async function runPass(current: ParakeetModel, request: PassRequest): Promise<Omit<PassResult, 'computeMs'>> {
  if (request.kind === 'full') {
    // One transcribe() up to 180 s (as in phase 1); parakeet.js windows longer recordings instead of running
    // the encoder's attention over the whole thing at once.
    const result = await current.transcribeLongAudio(request.audio, ASR_SAMPLE_RATE, { enableProfiling: false });
    return { text: result.text, words: null, melPrefixSamples: 0 };
  }
  const final = request.kind === 'final';
  const { prefixSamples, reused } = melPrefix(current, request.growKey, request.audio.length);
  const result = await current.transcribe(request.audio, ASR_SAMPLE_RATE, {
    returnTimestamps: final,
    returnConfidences: final,
    // true would console.log/console.table every pass.
    enableProfiling: false,
    prefixSamples,
  });
  return {
    text: result.utterance_text,
    words: final ? result.words.map(passWord) : null,
    melPrefixSamples: reused ? prefixSamples : 0,
  };
}

/**
 * parakeet.js keeps ONE incremental mel cache per model and trusts the caller that the first `prefixSamples`
 * samples equal the previous incremental call's audio, so the owner of the cache is tracked here: passes of
 * other segments (or sources) start a fresh cache instead of reusing someone else's frames. Within one buffer the
 * reuse is exact: IncrementalMelProcessor recomputes every frame whose window reaches past the common prefix,
 * and its features equal JsPreprocessor.process() bit for bit (checked for growing and cut buffers), so the
 * output equals a plain transcribe(). Passes without a key take the plain path and leave the cache alone.
 * parakeet.js's decoder-state `incremental` option is not used: the encoder attends over the whole buffer, so
 * the prefix's encoder frames change as audio is appended and a cached decoder state would not match.
 */
function melPrefix(current: ParakeetModel, key: string | null, samples: number): { prefixSamples: number; reused: boolean } {
  if (key === null || samples === 0) return { prefixSamples: 0, reused: false };
  if (melOwner?.key === key) {
    const prefixSamples = Math.min(melOwner.samples, samples);
    melOwner = { key, samples };
    return { prefixSamples, reused: true };
  }
  current.resetMelCache();
  melOwner = { key, samples };
  // With an empty cache this computes every frame and fills the cache.
  return { prefixSamples: samples, reused: false };
}

function passWord(word: TranscribeResult['words'][number]): PassWord {
  return {
    text: word.text,
    startMs: Math.round(word.start_time * 1000),
    endMs: Math.round(word.end_time * 1000),
    confidence: typeof word.confidence === 'number' ? word.confidence : null,
  };
}

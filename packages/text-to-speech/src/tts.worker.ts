/**
 * Kokoro TTS worker: model load, warm-up and synthesis on ONNX Runtime Web — streaming a whole text (speak, the
 * benchmark) or one piece on demand (synthesize, read aloud). The model runs through ./kokoro (a port of kokoro-js's
 * text pipeline on top of onnxruntime-web; no transformers.js).
 * Message protocol: ./protocol.ts. TtsEngine spawns a fresh worker for every load configuration, so a worker
 * loads exactly one model.
 */
import * as ort from 'onnxruntime-web';
import {
  canonicalModelUrl,
  installFetchInstrumentation,
  now,
  openModelCache,
  retrieveModelFile,
  setMainTimeOrigin,
  summarizeDownloads,
  type ByteProgress,
  type FetchInstrumentation,
  type LoadProgress,
  type WasmRuntimeInfo,
} from '@localspeech/core';
import { retryTexts, scrubNonFinite, speechProblem } from './audio-check.js';
import { adoptLegacyEntry } from './kokoro/legacy-cache.js';
import { KokoroModel, KOKORO_SAMPLE_RATE } from './kokoro/model.js';
import { KokoroTokenizer } from './kokoro/tokenizer.js';
import { KOKORO_MODEL, KOKORO_RUNTIME, voiceName } from './models.js';
import {
  errorMessage,
  type ChunkAudioCheck,
  type LoadRequest,
  type SpeakRequest,
  type SynthesizeRequest,
  type TtsWorkerEvent,
  type TtsWorkerRequest,
  type WorkerLoadResult,
} from './protocol.js';
import { splitterFor } from './split.js';
import { synthesizePiece, type PieceSynthesis } from './synthesize.js';

const WARMUP_TEXT = 'Hello.';
/** Forward byte progress at most this often per file. */
const PROGRESS_INTERVAL_MS = 100;
/** If pthread workers cannot start (e.g. /ort/ served without COOP/COEP/CORP), ORT would wait forever. */
const WASM_INIT_TIMEOUT_MS = 120_000;

let instrumentation: FetchInstrumentation | null = null;
let tts: KokoroModel | null = null;
let loadedVoice: string | null = null;
/** The model file cache, kept for voices fetched after the load (a voice other than the load-time one). */
let modelCache: Cache | null = null;
/** Speak runs and synthesize requests execute one after another; each waits for the previous one's inference. */
let speakQueue: Promise<void> = Promise.resolve();
const queuedRuns = new Set<number>();
const cancelledRuns = new Set<number>();

function post(msg: TtsWorkerEvent, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

function progress(p: Omit<LoadProgress, 'model'>): void {
  post({ type: 'progress', progress: { model: 'kokoro', ...p } });
}

function modelUrl(file: string): string {
  return canonicalModelUrl(KOKORO_MODEL.repo, KOKORO_MODEL.revision, file);
}

async function load(req: LoadRequest): Promise<WorkerLoadResult> {
  setMainTimeOrigin(req.timeOrigin);
  if (instrumentation) throw new Error('This TTS worker has already loaded a model.');
  instrumentation = installFetchInstrumentation({ source: req.source, pinnedRevisions: req.pinnedRevisions });

  const bundled = ort.env.versions.web;
  if (bundled && bundled !== KOKORO_RUNTIME.version) {
    throw new Error(`The bundled inference runtime (${bundled}) does not match the self-hosted runtime files (${KOKORO_RUNTIME.version}).`);
  }
  // A same-origin prefix makes ORT import its standalone .mjs glue from our origin, so its pthread workers are
  // created from that real file instead of the bundled worker chunk. ORT expects an absolute URL here.
  const wasmPaths = new URL(req.runtimeUrl, self.location.href).href;
  ort.env.wasm.wasmPaths = wasmPaths;
  ort.env.wasm.numThreads = req.wasmThreads > 0 ? req.wasmThreads : defaultThreads();
  ort.env.wasm.initTimeout = WASM_INIT_TIMEOUT_MS;
  if (req.device === 'webgpu') {
    await assertWebGpuAdapter();
    ort.env.webgpu.powerPreference = 'high-performance';
  }

  const weights = KOKORO_MODEL.dtypeFiles[req.dtype];
  const voiceFile = KOKORO_MODEL.voiceFile(req.voice);
  const files = [KOKORO_MODEL.tokenizerFile, weights, voiceFile];
  const { cache, error: cacheError } = await openModelCache();
  if (cacheError) storageNotice(`Model files will not be kept for next time: ${cacheError}.`);
  modelCache = cache;

  progress({ phase: 'download', message: `Loading the voice model (${req.dtype}) for ${req.device}` });
  instrumentation.beginCapture();
  const blobs = new Map<string, Blob>();
  let networkFiles = 0;
  let store = true;
  // Smallest first: once storing fails, the large weights skip the Cache API instead of being downloaded twice.
  for (const file of files) {
    if (cache) await adoptLegacyEntry(cache, KOKORO_MODEL.repo, file, modelUrl(file));
    try {
      const retrieved = await retrieveModelFile(cache, modelUrl(file), downloadProgress(file), store);
      blobs.set(file, retrieved.blob);
      if (retrieved.fromNetwork) networkFiles++;
      if (retrieved.storageError) {
        store = false;
        storageNotice(`${partLabel(file)}: ${retrieved.storageError}; it will be downloaded again next time.`, file);
      }
    } catch (err) {
      throw new Error(`Downloading the ${partLabel(file).toLowerCase()} failed: ${errorMessage(err)}`);
    }
  }

  const initializationStart = now();
  progress({ phase: 'initialize', message: `Creating the ${req.device} inference session` });
  const tokenizer = new KokoroTokenizer(JSON.parse(await blobs.get(KOKORO_MODEL.tokenizerFile)!.text()));
  const voiceTable = new Float32Array(await blobs.get(voiceFile)!.arrayBuffer());
  const session = await createSession(blobs.get(weights)!, req.device);
  blobs.clear();
  const model = new KokoroModel(ort, session, tokenizer, (voice) => (voice === req.voice ? Promise.resolve(voiceTable) : fetchVoice(voice)));
  // The voice table is a model input, so the model can run its first inference only once both are in.
  const modelReady = now();

  progress({ phase: 'warmup', message: 'Warm-up synthesis' });
  const warmupStart = now();
  await model.generate(WARMUP_TEXT, { voice: req.voice, speed: 1 });
  const warmupMs = now() - warmupStart;

  // ORT reads the weights through a blob: URL, which the instrumentation neither counts nor records.
  const download = summarizeDownloads(files, instrumentation.endCapture());
  tts = model;
  loadedVoice = req.voice;
  progress({ phase: 'ready' });
  return {
    download,
    loadKind: networkFiles === files.length ? 'cold' : networkFiles === 0 ? 'warm' : 'partial',
    initializationStart,
    modelReady,
    warmupMs,
    wasm: wasmRuntimeInfo(req.wasmThreads, wasmPaths),
  };
}

async function createSession(weights: Blob, device: LoadRequest['device']): Promise<ort.InferenceSession> {
  const url = URL.createObjectURL(weights);
  try {
    const session = await ort.InferenceSession.create(url, { executionProviders: [device === 'webgpu' ? 'webgpu' : 'wasm'] });
    if (device === 'webgpu') {
      // The JSEP WebGPU backend defines env.webgpu.device once it has started; without it the session runs on WASM.
      const gpu = Object.getOwnPropertyDescriptor(ort.env.webgpu, 'device')?.value as GPUDevice | undefined;
      if (!gpu) {
        await session.release();
        throw new Error('The runtime did not start its WebGPU backend, so the voice model would run on WASM.');
      }
    }
    return session;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A voice other than the load-time one, fetched on first use (needs the network unless it was cached before). */
async function fetchVoice(voice: string): Promise<Float32Array> {
  const file = KOKORO_MODEL.voiceFile(voice);
  if (modelCache) await adoptLegacyEntry(modelCache, KOKORO_MODEL.repo, file, modelUrl(file));
  const { blob } = await retrieveModelFile(modelCache, modelUrl(file), () => undefined, true);
  return new Float32Array(await blob.arrayBuffer());
}

/** A model file as named in messages that reach the UI (file names would identify the model). */
function partLabel(file: string): string {
  if (file === KOKORO_MODEL.tokenizerFile) return 'Vocabulary';
  if (file.startsWith('voices/')) return 'Voice';
  return 'Voice model weights';
}

/** Also logged: the UI only shows the latest progress message, and this one matters for warm loads. */
function storageNotice(message: string, file?: string): void {
  console.warn(`[tts] ${message}`);
  progress({ phase: 'download', file, message });
}

function downloadProgress(file: string): ByteProgress {
  let lastPost = -Infinity;
  return (loaded, total, done) => {
    const t = now();
    if (!done && t - lastPost < PROGRESS_INTERVAL_MS) return;
    lastPost = t;
    progress({ phase: 'download', file, loadedBytes: loaded, totalBytes: total ?? undefined, message: done ? 'done' : undefined });
  };
}

/**
 * ORT only discovers a missing adapter when it creates the session, i.e. after the weights (311 MB for fp32)
 * have downloaded. Failing first makes forced WebGPU fail fast and lets Auto fall back without that download.
 */
async function assertWebGpuAdapter(): Promise<void> {
  if (!('gpu' in navigator)) throw new Error('WebGPU is not available in this worker (navigator.gpu is missing).');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available in this worker (requestAdapter() returned null).');
}

/**
 * Kokoro on WASM speeds up to ~8 threads and then flattens (fp16: 0.67× real time on 4, 0.45× on 8, 0.43× on 16),
 * so 'auto' uses up to 8 instead of ORT's own min(4, cores / 2).
 */
function defaultThreads(): number {
  return Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4));
}

function wasmRuntimeInfo(requested: number, wasmPaths: string): WasmRuntimeInfo {
  // Reporting the automatic count as the request makes a non-isolated page show up as "multithreading
  // unavailable" (spec §16) instead of silently running on one thread.
  const requestedThreads = requested > 0 ? requested : defaultThreads();
  // ORT writes the thread count it actually initialised with back into env.wasm.numThreads.
  const configured = ort.env.wasm.numThreads;
  const effectiveThreads = configured && configured > 0 ? configured : 1;
  const multithreadingUnavailable = requestedThreads > 1 && effectiveThreads <= 1;
  return {
    requestedThreads,
    effectiveThreads,
    multithreadingUnavailable,
    reason: multithreadingUnavailable ? singleThreadReason() : null,
    // ORT >= 1.19 ships only SIMD builds and refuses to start without SIMD.
    simd: true,
    wasmPaths,
  };
}

/** Why a voice may fail: only the load-time voice is downloaded up front (display names, not voice ids). */
function notPreloaded(voice: string): string {
  const loaded = loadedVoice ? `only ${voiceName(loadedVoice)} was downloaded with the model` : 'no voice was downloaded with the model';
  return `the ${voiceName(voice)} voice was not downloaded at load time; ${loaded}`;
}

function singleThreadReason(): string {
  if (!globalThis.crossOriginIsolated) {
    return 'The page is not cross-origin isolated (COOP/COEP headers missing), so SharedArrayBuffer is unavailable and inference runs single-threaded.';
  }
  if (typeof SharedArrayBuffer === 'undefined') {
    return 'SharedArrayBuffer is unavailable, so inference runs single-threaded.';
  }
  return 'The runtime could not start WebAssembly threads and fell back to one thread (see the console warning).';
}

async function speak(req: SpeakRequest): Promise<void> {
  const model = tts;
  if (!model) throw new Error('The voice model is not loaded in this worker.');
  let index = 0;
  try {
    if (!cancelledRuns.has(req.id)) {
      const chunks = model.stream(splitterFor(req.text, req.split), {
        voice: req.voice,
        speed: req.speed,
      });
      let generationStart = now();
      for await (const { text, audio } of chunks) {
        if (cancelledRuns.has(req.id)) break;
        const checked = await checkedChunk(model, text, audio.audio, req);
        const generatedAt = now();
        const samples = ownedSamples(checked.samples);
        post(
          {
            type: 'chunk',
            id: req.id,
            index,
            text,
            generationStart,
            generatedAt,
            audio: samples,
            sampleRate: audio.sampling_rate,
            audioCheck: checked.audioCheck,
          },
          [samples.buffer],
        );
        index++;
        generationStart = now();
      }
    }
  } catch (e) {
    if (req.voice === loadedVoice) throw e;
    // A voice that load() did not fetch is downloaded on first use, which fails offline.
    throw new Error(`${errorMessage(e)} (${notPreloaded(req.voice)})`);
  }
  post({ type: 'done', id: req.id, generationCompleteAt: now(), chunkCount: index, cancelled: cancelledRuns.has(req.id) });
}

/**
 * The model can return unusable audio for some chunks (all NaN in fp16 on certain clauses). Regenerate with
 * altered wording; if that fails too, play silence of the same length (keeps the benchmark's timing honest) and
 * report it in the chunk's audioCheck.
 */
async function checkedChunk(
  model: KokoroModel,
  text: string,
  samples: Float32Array,
  req: SpeakRequest,
): Promise<{ samples: Float32Array; audioCheck: ChunkAudioCheck | null }> {
  const problem = speechProblem(samples);
  if (!problem) return { samples, audioCheck: null };
  let retries = 0;
  for (const variant of retryTexts(text)) {
    retries++;
    console.warn(`[tts] chunk came back ${problem}; retrying as "${variant}"`);
    const retry = (await model.generate(variant, { voice: req.voice, speed: req.speed })).audio;
    if (!speechProblem(retry)) return { samples: retry, audioCheck: { problem, retries, failed: false } };
  }
  console.warn(`[tts] chunk still unusable after ${retries} retries: "${text}"`);
  scrubNonFinite(samples);
  return { samples, audioCheck: { problem, retries, failed: true } };
}

// ---------------------------------------------------------------------------
// synthesize: one piece on demand (read aloud)
// ---------------------------------------------------------------------------

async function synthesize(req: SynthesizeRequest): Promise<void> {
  const model = tts;
  if (!model) throw new Error('The voice model is not loaded in this worker.');
  if (cancelledRuns.has(req.id)) {
    post({
      type: 'synthesized',
      id: req.id,
      audio: new Float32Array(0),
      sampleRate: KOKORO_SAMPLE_RATE,
      generationStart: null,
      generatedAt: now(),
      inferences: 0,
      maxTokens: 0,
      overflowSplits: 0,
      truncated: false,
      firstProblem: null,
      retries: 0,
      failed: false,
      skipped: true,
    });
    return;
  }
  const generationStart = now();
  let result: PieceSynthesis;
  try {
    result = await synthesizePiece(model, req.text, { voice: req.voice, speed: req.speed });
  } catch (e) {
    if (req.voice === loadedVoice) throw e;
    // A voice that load() did not fetch is downloaded on first use, which fails offline.
    throw new Error(`${errorMessage(e)} (${notPreloaded(req.voice)})`);
  }
  const audio = ownedSamples(result.audio);
  post(
    {
      type: 'synthesized',
      id: req.id,
      audio,
      sampleRate: result.sampleRate,
      generationStart,
      generatedAt: now(),
      inferences: result.inferences,
      maxTokens: result.maxTokens,
      overflowSplits: result.overflowSplits,
      truncated: result.truncated,
      firstProblem: result.firstProblem,
      retries: result.retries,
      failed: result.failed,
      skipped: false,
    },
    [audio.buffer],
  );
}

/**
 * Error text for the main thread, which shows it in the UI. Library errors can quote a model file's URL (the
 * host and the model repository), so that is replaced; the console keeps the original.
 */
function uiError(e: unknown): string {
  const message = errorMessage(e);
  const redacted = message.replace(/"?https?:\/\/[^\s"'<>]*\/resolve\/[^\s"'<>]+"?/g, 'a model file');
  if (redacted !== message) console.warn('[tts]', message);
  return redacted;
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
        (e: unknown) => post({ type: 'error', id: msg.id, message: uiError(e) }),
      );
      return;
    case 'speak':
    case 'synthesize':
      queuedRuns.add(msg.id);
      speakQueue = speakQueue
        .then(() => (msg.type === 'speak' ? speak(msg) : synthesize(msg)))
        .catch((e: unknown) => post({ type: 'error', id: msg.id, message: uiError(e) }))
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
  post({ type: 'error', id: null, message: `Uncaught error in the TTS worker: ${uiError(event.message)}` });
});
self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  post({ type: 'error', id: null, message: `Unhandled rejection in the TTS worker: ${uiError(event.reason)}` });
});

/**
 * ASR worker: parakeet.js on ONNX Runtime Web. One worker loads one model configuration; the engine
 * terminates it and spawns a new one to change backend, quantization, threads or source.
 * Message protocol: ./protocol.ts.
 */
import * as ort from 'onnxruntime-web';
import { ParakeetModel, type StatefulStreamingTranscriber } from 'parakeet.js';
import { now, setMainTimeOrigin } from '@/lib/clock';
import { ORT_ASSETS } from '@/lib/config';
import { installFetchInstrumentation, summarizeDownloads, type FetchInstrumentation } from '@/lib/net/instrument';
import type { AsrSettings, LoadProgress, ParakeetQuant, WasmRuntimeInfo } from '@/lib/types';
import { expectedFileList, parakeetFiles, type ParakeetFiles } from './model-files';
import { canonicalModelUrl, openModelCache, retrieveModelFile, type ByteProgress } from './model-store';
import { concatPcm } from './pcm';
import {
  ASR_SAMPLE_RATE,
  describeError,
  type LoadRequest,
  type LoadResult,
  type MainToWorker,
  type WorkerToMain,
} from './protocol';

const PROGRESS_INTERVAL_MS = 100;

interface Run {
  id: number;
  streamer: StatefulStreamingTranscriber;
  /** Every chunk received, for the full-utterance pass. */
  audio: Float32Array[];
  /** Chunks waiting for the streaming transcriber. */
  pending: Float32Array[];
  draining: Promise<void> | null;
  text: string;
  computeMs: number;
  samples: number;
  chunks: number;
  error: string | null;
  /** No more chunks accepted (finishing or cancelled). */
  closed: boolean;
}

let instrumentation: FetchInstrumentation | null = null;
let loadStarted = false;
let model: ParakeetModel | null = null;
let run: Run | null = null;
/** ORT sessions must not run concurrently, so every inference goes through this queue. */
let inferenceQueue: Promise<unknown> = Promise.resolve();

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
    case 'start':
      startRun(message.runId);
      break;
    case 'chunk':
      acceptChunk(message.runId, message.audio);
      break;
    case 'finish':
      void finishRun(message.runId, message.mode, message.tail);
      break;
    case 'cancel':
      if (run?.id === message.runId) closeRun(run);
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
  if (bundled && bundled !== ORT_ASSETS.parakeet.version) {
    throw new Error(
      `onnxruntime-web ${bundled} is bundled, but the self-hosted runtime files are for ${ORT_ASSETS.parakeet.version} (ORT_ASSETS.parakeet).`,
    );
  }
  // Must be set before parakeet.js's initOrt(), which otherwise points ORT at jsDelivr. A same-origin
  // prefix also makes ORT import the standalone ort-wasm-simd-threaded.jsep.mjs (and spawn that as its
  // pthread workers) instead of the copy bundled into this worker chunk.
  const wasmPaths = new URL(ORT_ASSETS.parakeet.wasmPaths, self.location.origin).href;
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
    const url = canonicalModelUrl(file);
    try {
      const retrieved = await retrieveModelFile(cache, url, downloadProgress(file), store);
      blobs.set(file, retrieved.blob);
      if (retrieved.fromNetwork) networkFiles++;
      if (retrieved.storageError) {
        store = false;
        storageNotice(`${file}: ${retrieved.storageError}; it will be downloaded again next time.`, file);
      }
    } catch (err) {
      throw new Error(`Downloading ${file} from ${net.resolveUrl(url)} failed: ${describeError(err)}`);
    }
  }

  const initializationStart = now();
  progress({ phase: 'initialize' });
  const created = await createModel(request, files, blobs);
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
    wasm: wasmRuntimeInfo(request.threads, wasmPaths),
  };
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

async function createModel(request: LoadRequest, files: ParakeetFiles, blobs: Map<string, Blob>): Promise<ParakeetModel> {
  const urls = new Map<string, string>();
  const urlOf = (file: string): string => {
    const blob = blobs.get(file);
    if (!blob) throw new Error(`${file} was not retrieved.`);
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
      cpuThreads: request.threads > 0 ? request.threads : undefined,
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
      throw new Error(`ONNX Runtime did not start its WebGPU backend, so the encoder would run on WASM${dropped ? ` (${dropped})` : ''}.`);
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
  // ~1 s of very quiet noise: compiles WebGPU shaders / primes WASM kernels before the first real chunk.
  const audio = new Float32Array(ASR_SAMPLE_RATE);
  let seed = 0x2545f491;
  for (let i = 0; i < audio.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    audio[i] = (seed / 0x100000000 - 0.5) * 2e-3;
  }
  const { ms } = await infer(() => created.transcribe(audio, ASR_SAMPLE_RATE));
  return ms;
}

function wasmRuntimeInfo(threads: number, wasmPaths: string): WasmRuntimeInfo {
  // Same rule as parakeet.js initOrt(): cpuThreads || navigator.hardwareConcurrency || 4.
  const requestedThreads = threads > 0 ? threads : navigator.hardwareConcurrency || 4;
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
    return 'The page is not cross-origin isolated (COOP/COEP headers), so SharedArrayBuffer is unavailable and ONNX Runtime runs single-threaded.';
  }
  if (typeof SharedArrayBuffer === 'undefined') return 'SharedArrayBuffer is unavailable, so ONNX Runtime runs single-threaded.';
  return 'ONNX Runtime could not start WebAssembly threads and fell back to a single thread (see the console).';
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
// Streaming transcription
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

function startRun(runId: number): void {
  if (run) closeRun(run);
  if (!model) {
    post({ type: 'runError', runId, message: 'The ASR model is not loaded in this worker.' });
    return;
  }
  run = {
    id: runId,
    // A fresh transcriber per recording: no decoder state or text carries over between runs.
    streamer: model.createStreamingTranscriber({ returnTimestamps: true, sampleRate: ASR_SAMPLE_RATE }),
    audio: [],
    pending: [],
    draining: null,
    text: '',
    computeMs: 0,
    samples: 0,
    chunks: 0,
    error: null,
    closed: false,
  };
}

function closeRun(target: Run): void {
  target.closed = true;
  target.pending.length = 0;
  if (run === target) run = null;
}

function acceptChunk(runId: number, audio: Float32Array): void {
  const target = run;
  if (!target || target.id !== runId || target.closed || target.error) return;
  target.audio.push(audio);
  target.pending.push(audio);
  void drain(target);
}

function drain(target: Run): Promise<void> {
  target.draining ??= processPending(target).finally(() => {
    target.draining = null;
  });
  return target.draining;
}

async function processPending(target: Run): Promise<void> {
  while (target.pending.length > 0 && !target.error && run === target) {
    const chunk = target.pending.shift()!;
    try {
      const { value, ms } = await infer(() => target.streamer.processChunk(chunk));
      target.computeMs += ms;
      target.samples += chunk.length;
      target.chunks += 1;
      target.text = value.text;
      if (run === target) post({ type: 'partial', runId: target.id, text: value.text, computeMs: ms });
    } catch (err) {
      target.error = `Streaming transcription failed: ${describeError(err)}`;
      // Once finishing, finishRun reports (a successful full pass supersedes a failed chunk).
      if (run === target && !target.closed) post({ type: 'runError', runId: target.id, message: target.error });
    }
  }
}

async function finishRun(runId: number, mode: AsrSettings['finalPass'], tail: Float32Array | null): Promise<void> {
  const target = run;
  if (!target || target.id !== runId) {
    post({ type: 'runError', runId, message: 'The ASR worker has no matching recording.' });
    return;
  }
  target.closed = true;
  try {
    if (target.error) throw new Error(target.error);
    if (tail && tail.length > 0) {
      target.audio.push(tail);
      if (mode === 'streaming') target.pending.push(tail);
    }

    let finalText: string;
    let finalPassComputeMs: number | null = null;
    let finalPassSamples = 0;
    let chunksDropped = 0;
    if (mode === 'full') {
      // Chunks that have not started yet are superseded by the full pass; one already running
      // finishes first because both go through the inference queue.
      chunksDropped = target.pending.length;
      target.pending.length = 0;
      const audio = concatPcm(target.audio);
      finalPassSamples = audio.length;
      finalText = '';
      if (audio.length > 0) {
        const current = model;
        if (!current) throw new Error('The ASR model is not loaded in this worker.');
        const { value, ms } = await infer(() => current.transcribe(audio, ASR_SAMPLE_RATE));
        finalText = value.utterance_text;
        finalPassComputeMs = ms;
      }
      await target.draining;
    } else {
      await drain(target);
      if (target.error) throw new Error(target.error);
      finalText = target.streamer.finalize().text;
    }

    post({
      type: 'final',
      runId,
      streamingText: target.text,
      finalText,
      streamingComputeMs: target.computeMs,
      streamedSamples: target.samples,
      finalPassComputeMs,
      finalPassSamples,
      chunksProcessed: target.chunks,
      chunksDropped,
    });
  } catch (err) {
    post({ type: 'runError', runId, message: describeError(err) });
  } finally {
    closeRun(target);
  }
}

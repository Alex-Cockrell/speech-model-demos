/**
 * Speaker-embedding worker: CAM++ on onnxruntime-web (the build and self-hosted runtime files the ASR uses),
 * WASM execution provider. One worker loads one configuration; SpeakerEngine terminates it and spawns a new one
 * to change threads or source. Message protocol: ./protocol.ts.
 *
 * Per segment: Kaldi fbank (./fbank.ts) → speech gate, windows, mean normalisation (./embed.ts) → one batched
 * ORT run → averaged, L2-normalised embedding. Runs are serialised: an ORT session must not run concurrently.
 */
import * as ort from 'onnxruntime-web';
import { now, setMainTimeOrigin } from '../clock';
import { ORT_ASSETS, SPEAKER_MODEL } from '../config';
import { installFetchInstrumentation, summarizeDownloads, type FetchInstrumentation } from '../net/instrument';
import type { LoadProgress, ModelSource, WasmRuntimeInfo } from '../types';
import { poolEmbeddings, prepareEmbeddingInput } from './embed';
import { Fbank } from './fbank';
import { SPEAKER_FBANK, SPEAKER_INPUT, SPEAKER_OUTPUT, SPEAKER_PREPARE, SPEAKER_SAMPLE_RATE } from './model';
import { canonicalModelUrl, retrieveModelFile, type ByteProgress, type RetrievedModel } from './model-store';
import { disableCountIncludePad } from './onnx-patch';
import {
  errorMessage,
  type EmbedRequest,
  type EmbedResult,
  type LoadRequest,
  type SpeakerWorkerEvent,
  type SpeakerWorkerRequest,
  type WorkerLoadResult,
} from './protocol';

const PROGRESS_INTERVAL_MS = 100;
/** Pthread start-up failures (e.g. /ort/ served without COOP/COEP/CORP) otherwise wait forever. */
const WASM_INIT_TIMEOUT_MS = 60_000;

let instrumentation: FetchInstrumentation | null = null;
let loadStarted = false;
let session: ort.InferenceSession | null = null;
const fbank = new Fbank(SPEAKER_FBANK);
/** Every inference goes through this queue. */
let queue: Promise<unknown> = Promise.resolve();

function post(msg: SpeakerWorkerEvent, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

function progress(p: Omit<LoadProgress, 'model'>): void {
  post({ type: 'progress', progress: { model: 'speaker', ...p } });
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function load(req: LoadRequest): Promise<WorkerLoadResult> {
  if (loadStarted) throw new Error('This speaker worker has already loaded a model.');
  loadStarted = true;
  setMainTimeOrigin(req.timeOrigin);
  const bundled = ort.env.versions.web;
  if (bundled && bundled !== ORT_ASSETS.parakeet.version) {
    throw new Error(
      `The bundled inference runtime (${bundled}) does not match the self-hosted runtime files (${ORT_ASSETS.parakeet.version}).`,
    );
  }
  instrumentation = installFetchInstrumentation({ source: req.source, pinnedRevisions: req.pinnedRevisions });
  instrumentation.beginCapture();

  // Before the first session: a same-origin absolute prefix makes ORT load the self-hosted .wasm/.mjs files
  // (shared with the ASR worker, so the browser's caches serve them) instead of a CDN.
  const wasmPaths = new URL(ORT_ASSETS.parakeet.wasmPaths, self.location.href).href;
  ort.env.wasm.wasmPaths = wasmPaths;
  ort.env.wasm.numThreads = req.wasmThreads;
  ort.env.wasm.initTimeout = WASM_INIT_TIMEOUT_MS;

  const file = SPEAKER_MODEL.files.model;
  progress({ phase: 'download', file, message: 'Loading the speaker model' });
  const url = canonicalModelUrl(file);
  let retrieved: RetrievedModel;
  try {
    retrieved = await retrieveModelFile(url, downloadProgress(file));
  } catch (e) {
    throw new Error(`Downloading the speaker model from ${sourceLabel(req.source)} failed: ${errorMessage(e)}`);
  }
  if (retrieved.storageError) {
    const message = `The speaker model will be downloaded again next time: ${retrieved.storageError}.`;
    console.warn(`[speaker] ${message}`);
    progress({ phase: 'download', file, message });
  }

  const initializationStart = now();
  progress({ phase: 'initialize', message: 'Creating the WASM inference session' });
  // In memory only: the cached file stays byte-identical to the pinned one.
  const patchedNodes = disableCountIncludePad(retrieved.bytes);
  if (patchedNodes === 0) throw new Error('The speaker model file does not have the AveragePool attributes this loader expects to fix.');
  const created = await ort.InferenceSession.create(retrieved.bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const modelReady = now();

  progress({ phase: 'warmup', message: 'Warm-up embedding' });
  const warmupStart = now();
  await embedWith(created, warmupAudio(), 0);
  const warmupMs = now() - warmupStart;

  const download = summarizeDownloads([file], instrumentation.endCapture());
  session = created;
  progress({ phase: 'ready' });
  return {
    download,
    loadKind: retrieved.fromNetwork ? 'cold' : 'warm',
    initializationStart,
    modelReady,
    warmupMs,
    wasm: wasmRuntimeInfo(req.wasmThreads, wasmPaths),
    patchedNodes,
  };
}

function downloadProgress(file: string): ByteProgress {
  let lastPost = -Infinity;
  return (loaded, total, done) => {
    const at = now();
    if (!done && at - lastPost < PROGRESS_INTERVAL_MS) return;
    lastPost = at;
    progress({ phase: 'download', file, loadedBytes: loaded, totalBytes: total ?? undefined, message: done ? 'done' : undefined });
  };
}

/** Two seconds of quiet noise: runs fbank and the model once, so the first real segment pays no start-up cost. */
function warmupAudio(): Float32Array {
  const audio = new Float32Array(2 * SPEAKER_SAMPLE_RATE);
  let seed = 0x2545f491;
  for (let i = 0; i < audio.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    audio[i] = (seed / 0x100000000 - 0.5) * 0.02;
  }
  return audio;
}

function wasmRuntimeInfo(requestedThreads: number, wasmPaths: string): WasmRuntimeInfo {
  // ORT writes the thread count it initialised with back into env.wasm.numThreads.
  const effectiveThreads = ort.env.wasm.numThreads && ort.env.wasm.numThreads > 0 ? ort.env.wasm.numThreads : 1;
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

/** Where model files come from, as named in messages: a mirror by its host, the default host not by name. */
function sourceLabel(source: ModelSource): string {
  if (source.kind !== 'mirror') return 'the public model host';
  try {
    return `the mirror (${new URL(source.baseUrl).host})`;
  } catch {
    return 'the mirror';
  }
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

async function embedWith(target: ort.InferenceSession, audio: Float32Array, minSpeechMs: number): Promise<EmbedResult> {
  const prepared = prepareEmbeddingInput(fbank, audio, { ...SPEAKER_PREPARE, minSpeechMs }, now);
  if (!prepared.batch) {
    return { embedding: null, speechMs: prepared.speechMs, computeMs: prepared.featureMs, featureMs: prepared.featureMs, inferenceMs: 0, windows: 0 };
  }
  const { data, windows, frames, bins } = prepared.batch;
  const input = new ort.Tensor('float32', data, [windows, frames, bins]);
  const started = now();
  const outputs = await target.run({ [SPEAKER_INPUT]: input });
  const inferenceMs = now() - started;
  const output = outputs[SPEAKER_OUTPUT];
  try {
    const values = (await output.getData()) as Float32Array;
    const dim = output.dims[output.dims.length - 1];
    return {
      embedding: poolEmbeddings(values, windows, dim),
      speechMs: prepared.speechMs,
      computeMs: prepared.featureMs + inferenceMs,
      featureMs: prepared.featureMs,
      inferenceMs,
      windows,
    };
  } finally {
    output.dispose();
  }
}

function embed(req: EmbedRequest): Promise<EmbedResult> {
  const result = queue.then(() => {
    if (!session) throw new Error('The speaker model is not loaded in this worker.');
    return embedWith(session, req.audio, req.minSpeechMs);
  });
  queue = result.catch(() => undefined);
  return result;
}

self.addEventListener('message', (event: MessageEvent<SpeakerWorkerRequest>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'load':
      load(msg).then(
        (result) => post({ type: 'loaded', id: msg.id, result }),
        (e: unknown) => post({ type: 'error', id: msg.id, message: errorMessage(e) }),
      );
      return;
    case 'embed':
      embed(msg).then(
        (result) => post({ type: 'embedded', id: msg.id, result }, result.embedding ? [result.embedding.buffer] : []),
        (e: unknown) => post({ type: 'error', id: msg.id, message: `Speaker embedding failed: ${errorMessage(e)}` }),
      );
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
  post({ type: 'error', id: null, message: `Uncaught error in the speaker worker: ${event.message}` });
});
self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  post({ type: 'error', id: null, message: `Unhandled rejection in the speaker worker: ${errorMessage(event.reason)}` });
});

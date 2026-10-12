/**
 * Shared contracts for the browser-local speech PoC.
 *
 * Timestamp convention
 * --------------------
 * Every numeric field named `...At`, `...Start`, `...Stop`, `...Ready` or `...Complete` is a
 * main-thread `performance.now()` value in milliseconds. Code running in a Web Worker must use
 * `now()` from this package (clock.ts) (after calling `setMainTimeOrigin()`), which already returns
 * main-thread clock values. Fields ending in `Ms` are durations in milliseconds.
 *
 * `null` means "did not happen / could not be measured". Never use 0 as a sentinel.
 */

// ---------------------------------------------------------------------------
// Backends, models, sources
// ---------------------------------------------------------------------------

export type BackendChoice = 'auto' | 'webgpu' | 'wasm';
export type ResolvedBackend = 'webgpu' | 'wasm';
/** The two models of the benchmark pipeline. */
export type ModelKey = 'parakeet' | 'kokoro';
/** Every model the app can load: the pipeline models plus the speaker-embedding model used for meeting diarization. */
export type AnyModelKey = ModelKey | 'speaker';

/** How the model's bytes were obtained for this load (spec §8). */
export type LoadKind =
  /** every expected model file came over the network */
  | 'cold'
  /** every expected model file came from persistent browser storage (Cache API / IndexedDB) */
  | 'warm'
  /** a mix of network and persistent storage (e.g. an earlier download was interrupted) */
  | 'partial'
  /** the model was already initialised in this page session with the same configuration */
  | 'session';

export interface ModelSource {
  kind: 'huggingface' | 'mirror';
  /** e.g. 'https://huggingface.co' or 'https://models.example.com' — no trailing slash */
  baseUrl: string;
}

export interface IntervalStats {
  count: number;
  meanMs: number | null;
  medianMs: number | null;
  minMs: number | null;
  maxMs: number | null;
}

// ---------------------------------------------------------------------------
// Downloads & model loading (spec §8)
// ---------------------------------------------------------------------------

export interface FileFetchRecord {
  /** Path inside the model repo, e.g. 'onnx/model_quantized.onnx', 'voices/af_heart.bin'; or the asset file name for runtime files. */
  file: string;
  /** URL actually requested (after source rewrite). */
  url: string;
  kind: 'model' | 'runtime' | 'other';
  requestStart: number;
  responseHeadersAt: number | null;
  /** First body bytes received. */
  firstByteAt: number | null;
  completeAt: number | null;
  /** Body bytes actually read from the network response. */
  bytes: number;
  status: number | null;
  error: string | null;
}

export interface DownloadMetrics {
  /** Model files this load configuration needs. */
  expectedFiles: string[];
  /** Model files that were fetched over the network during this load. */
  networkFiles: FileFetchRecord[];
  /** Expected files that never touched the network (served from persistent storage). */
  cachedFiles: string[];
  downloadStart: number | null;
  firstByteAt: number | null;
  downloadComplete: number | null;
  timeToFirstByteMs: number | null;
  totalDownloadMs: number | null;
  /** Network body bytes for model files (0 on a warm load). */
  downloadedBytes: number;
  /** downloadedBytes / totalDownloadMs, in MB/s where MB = 1e6 bytes. */
  effectiveMBps: number | null;
  /** Runtime assets (ORT .wasm/.mjs) fetched during the load. Not included in downloadedBytes. */
  runtimeFiles: FileFetchRecord[];
  runtimeBytes: number;
}

export interface WasmRuntimeInfo {
  /** Threads we asked ONNX Runtime for. */
  requestedThreads: number;
  /** Threads ONNX Runtime actually uses after initialisation. */
  effectiveThreads: number;
  /** true when requestedThreads > 1 but ORT could not run multithreaded. Must be surfaced in the UI (spec §16). */
  multithreadingUnavailable: boolean;
  reason: string | null;
  simd: boolean;
  /** Where the ORT .wasm/.mjs files were loaded from. */
  wasmPaths: string;
}

export interface ModelLoadRecord {
  model: AnyModelKey;
  /** e.g. 'NVIDIA Parakeet TDT 0.6B v3' */
  displayName: string;
  /** Hugging Face repo the files come from (or are mirrored from). */
  repo: string;
  /** Pinned commit SHA. */
  revision: string;
  /** e.g. { encoder: 'int8', decoder: 'int8' } or { model: 'q8' } */
  quantization: Record<string, string>;
  requestedBackend: BackendChoice;
  resolvedBackend: ResolvedBackend;
  /** Set when Auto tried WebGPU and fell back to WASM. */
  fallbackReason: string | null;
  source: ModelSource;
  loadKind: LoadKind;
  /** When load() was called. */
  loadStart: number;
  download: DownloadMetrics;
  /** When model loading/compilation began after the required data was available. */
  initializationStart: number;
  /** When the model could perform its first inference. */
  modelReady: number;
  initializationMs: number;
  /** modelReady - (download.downloadStart ?? loadStart) */
  totalColdStartMs: number;
  /** Duration of a tiny warm-up inference run right after modelReady (shader compilation etc.), if run. */
  warmupMs: number | null;
  wasm: WasmRuntimeInfo;
  /** e.g. { 'parakeet.js': '1.4.4', 'onnxruntime-web': '1.24.1' } */
  versions: Record<string, string>;
}

export interface LoadProgress {
  model: AnyModelKey;
  phase: 'download' | 'initialize' | 'warmup' | 'ready' | 'error';
  file?: string;
  loadedBytes?: number;
  totalBytes?: number;
  message?: string;
}

/** Aggregate download progress of a model load, as the packages' high-level APIs report it. */
export interface DownloadProgress {
  phase: LoadProgress['phase'];
  loadedBytes: number;
  /** Null while the sizes are not known yet. */
  totalBytes: number | null;
  /** 0…1 of the known download size; null while unknown. */
  fraction: number | null;
}

export interface WebGpuInfo {
  /** navigator.gpu exists */
  apiPresent: boolean;
  /** requestAdapter() returned an adapter */
  adapterAvailable: boolean;
  adapter: {
    vendor: string;
    architecture: string;
    device: string;
    description: string;
    isFallbackAdapter: boolean | null;
  } | null;
  features: string[];
  shaderF16: boolean;
  limits: {
    maxBufferSize: number;
    maxStorageBufferBindingSize: number;
  } | null;
  error: string | null;
}

export interface StorageInfo {
  usageBytes: number | null;
  quotaBytes: number | null;
  /** navigator.storage.persisted() */
  persisted: boolean | null;
}

export interface EnvironmentInfo {
  collectedAt: string;
  userAgent: string;
  browser: { name: string; version: string; fullVersion: string | null };
  os: { name: string; version: string | null; architecture: string | null; bitness: string | null };
  mobile: boolean | null;
  hardwareConcurrency: number | null;
  /** navigator.deviceMemory (Chromium only, capped at 8). */
  deviceMemoryGB: number | null;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  wasm: {
    /** The WebAssembly API exists (V8 jitless mode, e.g. Edge Enhanced Security Mode, can remove it). */
    available: boolean;
    simd: boolean;
    threads: boolean;
    /** Time for a fixed 10M-iteration integer loop; a few ms when JIT-compiled. null if it could not run. */
    speedProbeMs: number | null;
    /** The probe ran far slower than compiled code would: WebAssembly is probably being interpreted. */
    likelyInterpreted: boolean | null;
  };
  webgpu: WebGpuInfo;
  storage: StorageInfo;
  online: boolean;
}

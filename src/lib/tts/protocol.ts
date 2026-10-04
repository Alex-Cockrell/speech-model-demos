/**
 * Messages between TtsEngine (main thread) and tts.worker.ts.
 *
 * Main → worker: load (exactly once per worker), speak, cancel, requestCount.
 * Worker → main: progress* → loaded | error during a load; chunk* → done | error per speak run;
 * error with id null for failures not tied to a request (uncaught exception / unhandled rejection).
 *
 * Nothing here imports kokoro-js, so the main thread can import it without bundling the model library.
 */
import type {
  DownloadMetrics,
  KokoroDtype,
  LoadKind,
  LoadProgress,
  ModelSource,
  ResolvedBackend,
  TtsSettings,
  WasmRuntimeInfo,
} from '../types';

export interface LoadRequest {
  type: 'load';
  id: number;
  /** Main-thread performance.timeOrigin, for setMainTimeOrigin(). */
  timeOrigin: number;
  source: ModelSource;
  pinnedRevisions: Record<string, string>;
  device: ResolvedBackend;
  dtype: KokoroDtype;
  /** ORT WASM threads; 0 keeps ONNX Runtime's default. */
  wasmThreads: number;
  /** Fetched during the load and used for the warm-up, so later runs need no network. */
  voice: string;
}

export interface SpeakRequest {
  type: 'speak';
  id: number;
  text: string;
  voice: string;
  speed: number;
  split: TtsSettings['split'];
}

/** Stop posting chunks for speak run `id`. The inference already in flight still runs to completion. */
export interface CancelRequest {
  type: 'cancel';
  id: number;
}

export interface RequestCountRequest {
  type: 'requestCount';
  id: number;
}

export type TtsWorkerRequest = LoadRequest | SpeakRequest | CancelRequest | RequestCountRequest;

/** The part of a ModelLoadRecord measured inside the worker. */
export interface WorkerLoadResult {
  download: DownloadMetrics;
  loadKind: Exclude<LoadKind, 'session'>;
  initializationStart: number;
  modelReady: number;
  warmupMs: number;
  wasm: WasmRuntimeInfo;
}

export interface ChunkEvent {
  type: 'chunk';
  /** Speak run id. */
  id: number;
  index: number;
  text: string;
  /** Chunk 0: just before iteration began. Chunk n: right after chunk n-1 was posted. */
  generationStart: number;
  generatedAt: number;
  /** Mono PCM; its buffer is transferred. */
  audio: Float32Array<ArrayBuffer>;
  sampleRate: number;
}

export interface DoneEvent {
  type: 'done';
  id: number;
  generationCompleteAt: number;
  chunkCount: number;
  cancelled: boolean;
}

export type TtsWorkerEvent =
  | { type: 'progress'; progress: LoadProgress }
  | { type: 'loaded'; id: number; result: WorkerLoadResult }
  | ChunkEvent
  | DoneEvent
  | { type: 'requestCount'; id: number; count: number }
  | { type: 'error'; id: number | null; message: string };

/** Readable message for anything thrown (ONNX Runtime / Emscripten can throw strings or numbers). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

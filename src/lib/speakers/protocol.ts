/**
 * Messages between SpeakerEngine (main thread) and speaker.worker.ts. One worker loads one configuration.
 *
 * Main → worker: load (once per worker), embed, requestCount.
 * Worker → main: progress* → loaded | error for a load; embedded | error per embed (an embed error only fails
 * that request); requestCount; error with id null for failures not tied to a request (uncaught exception or
 * unhandled rejection), which the engine treats as fatal for the worker.
 *
 * Nothing here imports ONNX Runtime, so the main thread can import it without bundling the runtime.
 */
import type { DownloadMetrics, LoadKind, LoadProgress, ModelSource, WasmRuntimeInfo } from '../types';

export interface LoadRequest {
  type: 'load';
  id: number;
  /** Main-thread performance.timeOrigin, for setMainTimeOrigin(). */
  timeOrigin: number;
  source: ModelSource;
  pinnedRevisions: Record<string, string>;
  /** ORT WASM threads (>= 1). The model always runs on the WASM execution provider (see engine.ts). */
  wasmThreads: number;
}

export interface EmbedRequest {
  type: 'embed';
  id: number;
  /** 16 kHz mono PCM; its buffer is transferred. */
  audio: Float32Array;
  /** Segments with less speech get no embedding. */
  minSpeechMs: number;
}

export interface RequestCountRequest {
  type: 'requestCount';
  id: number;
}

export type SpeakerWorkerRequest = LoadRequest | EmbedRequest | RequestCountRequest;

/** The part of a ModelLoadRecord measured inside the worker. */
export interface WorkerLoadResult {
  download: DownloadMetrics;
  loadKind: Exclude<LoadKind, 'session'>;
  initializationStart: number;
  modelReady: number;
  warmupMs: number;
  wasm: WasmRuntimeInfo;
  /** AveragePool nodes switched to count_include_pad 0 (see onnx-patch.ts); 52 for CAM++. */
  patchedNodes: number;
}

export interface EmbedResult {
  /** L2-normalised embedding (buffer transferred), or null when the segment has too little speech. */
  embedding: Float32Array | null;
  /** Speech in the segment according to the energy gate. */
  speechMs: number;
  /** Feature extraction + inference. */
  computeMs: number;
  featureMs: number;
  inferenceMs: number;
  /** Model windows the segment was split into (0 when not embedded). */
  windows: number;
}

export type SpeakerWorkerEvent =
  | { type: 'progress'; progress: LoadProgress }
  | { type: 'loaded'; id: number; result: WorkerLoadResult }
  | { type: 'embedded'; id: number; result: EmbedResult }
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

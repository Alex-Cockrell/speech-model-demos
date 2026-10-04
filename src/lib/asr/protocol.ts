/**
 * Messages between AsrEngine (main thread, via worker-client.ts) and asr.worker.ts.
 *
 * One worker loads one model configuration. Load:  main 'load' → worker 'progress'* → 'loaded' | 'loadError'.
 * Inference:                                      main 'pass' → worker 'passResult' | 'passError' (same passId).
 *                                                 The main thread keeps at most one pass in flight (LiveTranscriber).
 * Any time:                                       main 'count' → worker 'count' (fetch() calls so far).
 * Unhandled promise rejections inside the worker arrive as 'unexpectedError'.
 */
import type { DownloadMetrics, LoadKind, LoadProgress, ModelSource, ParakeetQuant, ResolvedBackend, WasmRuntimeInfo } from '@/lib/types';

export const ASR_SAMPLE_RATE = 16000;

export interface LoadRequest {
  type: 'load';
  /** Main-thread performance.timeOrigin, for setMainTimeOrigin(). */
  timeOrigin: number;
  source: ModelSource;
  pinnedRevisions: Record<string, string>;
  backend: ResolvedBackend;
  quant: ParakeetQuant;
  /** ORT WASM threads as set by the user; 0 = automatic (resolveWasmThreads). */
  threads: number;
}

export interface LoadResult {
  backend: ResolvedBackend;
  quant: ParakeetQuant;
  loadKind: Exclude<LoadKind, 'session'>;
  download: DownloadMetrics;
  initializationStart: number;
  modelReady: number;
  warmupMs: number | null;
  wasm: WasmRuntimeInfo;
}

/**
 * 'partial' → text only, of an open segment from its start; 'final' → a closed segment, with word timestamps and
 * confidences; 'full' → the whole benchmark recording after Stop (windowed by parakeet.js beyond 180 s).
 */
export type PassKind = 'partial' | 'final' | 'full';

export interface PassRequest {
  type: 'pass';
  passId: number;
  kind: PassKind;
  /** 16 kHz mono PCM, transferred. */
  audio: Float32Array;
  /**
   * Identifies a growing buffer (one segment of one run). Successive passes with the same key must start with the
   * same samples, so the worker can reuse the mel frames of the common prefix (exact, see asr.worker.ts).
   */
  growKey: string | null;
}

export interface PassWord {
  text: string;
  /** ms from the start of the pass audio */
  startMs: number;
  endMs: number;
  confidence: number | null;
}

export interface PassResult {
  text: string;
  /** Final passes only. */
  words: PassWord[] | null;
  /** Inference time inside the worker. */
  computeMs: number;
  /** Leading samples whose mel frames came from the previous pass of the same buffer (0 = computed from scratch). */
  melPrefixSamples: number;
}

export type MainToWorker = LoadRequest | PassRequest | { type: 'count'; requestId: number };

export type WorkerToMain =
  | { type: 'progress'; progress: LoadProgress }
  | { type: 'loaded'; result: LoadResult }
  | { type: 'loadError'; message: string }
  | ({ type: 'passResult'; passId: number } & PassResult)
  | { type: 'passError'; passId: number; message: string }
  | { type: 'count'; requestId: number; count: number }
  | { type: 'unexpectedError'; message: string };

/**
 * ORT WASM threads for a load. Automatic leaves two logical cores to the rest of the machine (the call app,
 * the speaker-embedding worker, the UI): hardwareConcurrency − 2, at least 1. Threads are fixed when ORT
 * initialises, so benchmark and meeting share this choice; an explicit setting is used as is.
 */
export function resolveWasmThreads(requested: number, hardwareConcurrency: number | undefined): number {
  if (requested > 0) return requested;
  return Math.max(1, (hardwareConcurrency || 4) - 2);
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

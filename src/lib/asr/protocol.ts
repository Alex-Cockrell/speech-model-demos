/**
 * Messages between AsrEngine (main thread) and asr.worker.ts.
 *
 * One worker loads one model configuration. Load:   main 'load' → worker 'progress'* → 'loaded' | 'loadError'.
 * Recording (runId increases per recording):       main 'start', 'chunk'*, then 'finish' (or 'cancel')
 *                                                  → worker 'partial'* → 'final' | 'runError'.
 * Any time:                                        main 'count' → worker 'count' (fetch() calls so far).
 * Unhandled promise rejections inside the worker arrive as 'unexpectedError'.
 */
import type {
  AsrSettings,
  DownloadMetrics,
  LoadKind,
  LoadProgress,
  ModelSource,
  ParakeetQuant,
  ResolvedBackend,
  WasmRuntimeInfo,
} from '@/lib/types';

export const ASR_SAMPLE_RATE = 16000;
/** One encoder frame (8x subsampling of 10 ms features). Chunks and the padded tail are multiples of this. */
export const ENCODER_FRAME_SAMPLES = 1280;

export interface LoadRequest {
  type: 'load';
  /** Main-thread performance.timeOrigin, for setMainTimeOrigin(). */
  timeOrigin: number;
  source: ModelSource;
  pinnedRevisions: Record<string, string>;
  backend: ResolvedBackend;
  quant: ParakeetQuant;
  /** ORT WASM threads; 0 = automatic (parakeet.js uses navigator.hardwareConcurrency). */
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

export interface RunFinal {
  runId: number;
  /** Cumulative streaming text after the last processed chunk. */
  streamingText: string;
  finalText: string;
  streamingComputeMs: number;
  /** Samples the streaming transcriber actually processed (dropped chunks excluded). */
  streamedSamples: number;
  finalPassComputeMs: number | null;
  /** Samples in the full-utterance pass (0 when finalPass is 'streaming'). */
  finalPassSamples: number;
  chunksProcessed: number;
  /** Queued chunks skipped because the full final pass superseded them. */
  chunksDropped: number;
}

export type MainToWorker =
  | LoadRequest
  | { type: 'start'; runId: number }
  | { type: 'chunk'; runId: number; audio: Float32Array }
  | { type: 'finish'; runId: number; mode: AsrSettings['finalPass']; tail: Float32Array | null }
  | { type: 'cancel'; runId: number }
  | { type: 'count'; requestId: number };

export type WorkerToMain =
  | { type: 'progress'; progress: LoadProgress }
  | { type: 'loaded'; result: LoadResult }
  | { type: 'loadError'; message: string }
  | { type: 'partial'; runId: number; text: string; computeMs: number }
  | ({ type: 'final' } & RunFinal)
  | { type: 'runError'; runId: number; message: string }
  | { type: 'count'; requestId: number; count: number }
  | { type: 'unexpectedError'; message: string };

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

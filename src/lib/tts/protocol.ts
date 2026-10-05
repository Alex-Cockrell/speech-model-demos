/**
 * Messages between TtsEngine (main thread) and tts.worker.ts.
 *
 * Main → worker: load (exactly once per worker), speak, synthesize, cancel, requestCount.
 * Worker → main: progress* → loaded | error during a load; chunk* → done | error per speak run;
 * synthesized | error per synthesize request; error with id null for failures not tied to a request
 * (uncaught exception / unhandled rejection).
 *
 * speak streams a whole text (the benchmark); synthesize generates exactly one piece on demand, so the caller
 * (read aloud) decides how far generation runs ahead of playback. Both run one at a time, in arrival order.
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
  TtsChunkRecord,
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

/**
 * Generate one piece of text as one utterance (no sentence splitting), answered by a SynthesizedEvent. The worker
 * checks Kokoro's token window and, if the piece would be truncated, splits it and concatenates the audio.
 */
export interface SynthesizeRequest {
  type: 'synthesize';
  id: number;
  text: string;
  voice: string;
  speed: number;
}

/**
 * Stop posting chunks for speak run `id`, or skip synthesize request `id` if it has not started.
 * The inference already in flight still runs to completion.
 */
export interface CancelRequest {
  type: 'cancel';
  id: number;
}

export interface RequestCountRequest {
  type: 'requestCount';
  id: number;
}

export type TtsWorkerRequest = LoadRequest | SpeakRequest | SynthesizeRequest | CancelRequest | RequestCountRequest;

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
  /** Set when the model returned unusable audio for this chunk (see TtsChunkRecord.audioCheck). */
  audioCheck: ChunkAudioCheck | null;
}

export type ChunkAudioCheck = NonNullable<TtsChunkRecord['audioCheck']>;

export interface DoneEvent {
  type: 'done';
  id: number;
  generationCompleteAt: number;
  chunkCount: number;
  cancelled: boolean;
}

export interface SynthesizedEvent {
  type: 'synthesized';
  id: number;
  /** Mono PCM of the whole piece (empty when skipped); its buffer is transferred. */
  audio: Float32Array<ArrayBuffer>;
  sampleRate: number;
  /** When the worker started this request (after any queue wait) and finished it. null when skipped. */
  generationStart: number | null;
  generatedAt: number;
  /** Kokoro inferences used: 1, more when the piece had to be split to fit the token window. */
  inferences: number;
  /** Largest phoneme-token count of those inferences (including the two `$`). */
  maxTokens: number;
  /** Splits made because the piece exceeded Kokoro's token window. */
  overflowSplits: number;
  /** A part could not be split further and was synthesized truncated (its end is missing). */
  truncated: boolean;
  /** What was wrong with the first attempt's audio ('invalid' = NaN samples), or null when it was fine. */
  firstProblem: 'empty' | 'invalid' | 'silent' | null;
  /** Re-generations with altered wording because the model returned empty (NaN or silent) audio. */
  retries: number;
  /** Still empty after the retries: no audio, the piece is skipped. */
  failed: boolean;
  /** Cancelled before it started: no audio. A request cancelled while running still returns its audio. */
  skipped: boolean;
}

export type TtsWorkerEvent =
  | { type: 'progress'; progress: LoadProgress }
  | { type: 'loaded'; id: number; result: WorkerLoadResult }
  | ChunkEvent
  | DoneEvent
  | SynthesizedEvent
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

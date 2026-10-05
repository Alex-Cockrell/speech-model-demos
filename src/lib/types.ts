/**
 * Shared contracts for the browser-local speech PoC.
 *
 * Timestamp convention
 * --------------------
 * Every numeric field named `...At`, `...Start`, `...Stop`, `...Ready` or `...Complete` is a
 * main-thread `performance.now()` value in milliseconds. Code running in a Web Worker must use
 * `now()` from `@/lib/clock` (after calling `setMainTimeOrigin()`), which already returns
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

// ---------------------------------------------------------------------------
// ASR (spec §9)
// ---------------------------------------------------------------------------

export type ParakeetQuant = 'int8' | 'fp16' | 'fp32';

export interface AsrSettings {
  /** 'auto' → int8 on WASM; fp16 on WebGPU when the adapter has shader-f16, else fp32. */
  encoderQuant: 'auto' | ParakeetQuant;
  /**
   * How often the in-progress segment is re-transcribed (from its start) to refresh the live partial text.
   * A pass is skipped while the previous one is still running, so slow machines update less often instead of lagging.
   */
  partialIntervalMs: number;
  /** A pause at least this long ends the current segment (VAD-based segmentation). */
  minSilenceMs: number;
  /** Segments are cut at the quietest recent point once they reach this length, keeping each pass bounded. */
  maxSegmentMs: number;
  /**
   * 'segments' → each segment gets its final transcription as soon as it ends; on Stop only the last one remains,
   *              so Stop → final text stays short however long the recording is. The meeting mode always works this way.
   * 'full'     → benchmark only: after Stop, re-transcribe the whole recording in one pass and use that as the final text.
   */
  finalPass: 'segments' | 'full';
  /** ORT WASM threads. 0 = automatic. */
  wasmThreads: number;
}

export interface PartialUpdate {
  at: number;
  text: string;
}

export interface MicInfo {
  contextSampleRate: number;
  deviceLabel: string | null;
  trackSettings: MediaTrackSettings;
}

export interface AsrRunMetrics {
  /** User pressed Record. */
  micStart: number;
  /** First detected speech activity (approximate, energy based). null if none detected. */
  speechStart: number | null;
  /** First microphone chunk handed to Parakeet. */
  firstAudioSubmitted: number | null;
  /** First non-empty partial transcript. */
  firstPartialAt: number | null;
  recordingStop: number;
  finalTranscriptAt: number;
  /** One entry every time the visible partial transcript changed. */
  partials: PartialUpdate[];
  /** speechStart → first partial */
  voiceToFirstTextMs: number | null;
  /** firstAudioSubmitted → first partial */
  submitToFirstTextMs: number | null;
  /** Intervals between consecutive partial updates. */
  updateIntervals: IntervalStats;
  partialUpdateCount: number;
  /** recordingStop → finalTranscript */
  finalizationMs: number;
  audioDurationSec: number;
  /** Total ASR inference compute time for the run (streaming chunks + final pass). */
  computeMs: number;
  /** computeMs / audio duration. < 1.0 is faster than real time. */
  rtf: number | null;
  /** Inference time spent while recording and on segment finals (partial passes + per-segment final passes). */
  streamingComputeMs: number;
  /** streamingComputeMs / audio duration. */
  streamingRtf: number | null;
  /** Inference time of the whole-recording final pass (null when finalPass === 'segments'). */
  finalPassComputeMs: number | null;
  /** finalPassComputeMs / audio duration. */
  finalPassRtf: number | null;
  /** Inference passes run for this recording (partial re-transcriptions + segment finals). */
  chunksSubmitted: number;
  /** Concatenated per-segment final texts (the final text in 'segments' mode; compared against the full pass in 'full' mode). */
  streamingText: string;
  /** Exact text handed to TTS. */
  finalText: string;
  settings: AsrSettings;
  mic: MicInfo;
}

// ---------------------------------------------------------------------------
// TTS (spec §10)
// ---------------------------------------------------------------------------

export type KokoroDtype = 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';

export interface TtsSettings {
  /** 'auto' → fp16 on WASM (q8's int8 path is ~2× slower there), fp32 on WebGPU (kokoro-js recommendation). */
  dtype: 'auto' | KokoroDtype;
  voice: string;
  speed: number;
  /** 'sentence' = kokoro-js default splitter; 'clause' also splits on , ; : for more, smaller chunks. */
  split: 'sentence' | 'clause';
  /** ORT WASM threads. 0 = automatic. */
  wasmThreads: number;
}

export interface TtsChunkRecord {
  index: number;
  text: string;
  generationStart: number;
  generatedAt: number;
  generationMs: number;
  audioDurationMs: number;
  /** When this chunk is scheduled to start playing (main-thread clock). */
  scheduledPlaybackAt: number;
  /** Audio already queued ahead of the playhead when this chunk arrived. 0 if playback had drained. */
  bufferedAheadMs: number;
  /** Playback had drained before this chunk arrived (only meaningful for index > 0). */
  underrun: boolean;
  /** Audible silence caused by waiting for this chunk. */
  gapMs: number;
  /**
   * Present only when the voice model returned unusable audio for this chunk: 'invalid' (NaN samples, seen with
   * fp16 on some clauses), 'silent' or 'empty'; retries with altered wording; failed = still unusable (played as
   * silence).
   */
  audioCheck?: { problem: 'empty' | 'invalid' | 'silent'; retries: number; failed: boolean };
}

export interface TtsRunMetrics {
  /** Immediately before the transcript text is submitted to Kokoro. */
  ttsStart: number;
  firstAudioGeneratedAt: number | null;
  firstPlaybackStartAt: number | null;
  generationCompleteAt: number | null;
  playbackCompleteAt: number | null;
  /** firstAudioGeneratedAt - ttsStart */
  timeToFirstAudioMs: number | null;
  /** firstPlaybackStartAt - ttsStart */
  timeToFirstSpeechMs: number | null;
  chunks: TtsChunkRecord[];
  /** Intervals between consecutive chunk generatedAt values. */
  chunkIntervals: IntervalStats;
  bufferUnderruns: number;
  /** Chunks the voice model returned as unusable audio: regenerated, and still unusable after retries. */
  audioProblems?: { retriedChunks: number; failedChunks: number };
  /** Sum of gapMs across chunks. */
  audiblePauseMs: number;
  minBufferedMs: number | null;
  maxBufferedMs: number | null;
  generationComputeMs: number;
  generatedAudioMs: number;
  /** generationComputeMs / generatedAudioMs */
  generationRtf: number | null;
  audioOutput: {
    contextSampleRate: number;
    baseLatencyMs: number | null;
    outputLatencyMs: number | null;
  };
  /** Exact text that was synthesised. */
  text: string;
  settings: TtsSettings;
}

// ---------------------------------------------------------------------------
// End-to-end, accuracy, environment
// ---------------------------------------------------------------------------

export interface EndToEndMetrics {
  /** speechStart → first partial transcript */
  voiceToFirstTextMs: number | null;
  /** recordingStop → final transcript */
  stopToFinalTextMs: number | null;
  /** final transcript → first playback start */
  textToFirstSpeechMs: number | null;
  /** recordingStop → first playback start (headline metric) */
  stopToFirstSpeechMs: number | null;
  /** speechStart → playback complete */
  fullRoundTripMs: number | null;
}

export interface WerBreakdown {
  normalizedExpected: string;
  normalizedHypothesis: string;
  exactMatch: boolean;
  wer: number;
  substitutions: number;
  insertions: number;
  deletions: number;
  referenceWordCount: number;
}

export interface AccuracyResult extends WerBreakdown {
  phraseId: string;
  expected: string;
  /** Raw, untouched final transcript. */
  hypothesis: string;
  /** Same comparison for the streaming text, when a final pass produced a different final text. */
  streaming: (WerBreakdown & { hypothesis: string }) | null;
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

// ---------------------------------------------------------------------------
// Benchmark record (spec §14)
// ---------------------------------------------------------------------------

export type RunMode = 'free' | 'benchmark';

export interface BenchmarkPhrase {
  id: string;
  title: string;
  text: string;
}

export interface ModelSummary {
  name: string;
  repo: string;
  revision: string;
  quantization: Record<string, string>;
  backend: ResolvedBackend;
  loadKind: LoadKind;
  /** Pipeline runs completed with this loaded instance before this one (0 = first run after load). */
  runsSinceLoad: number;
  versions: Record<string, string>;
}

export interface BenchmarkRecord {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  /** Free text, e.g. "Managed Dell 5440". */
  label: string;
  /** Test-matrix row from spec §17 ('1'..'6'), if the user tagged it. */
  testCase: string | null;
  mode: RunMode;
  app: { version: string; commit: string | null; builtAt: string | null; origin: string };
  environment: EnvironmentInfo;
  settings: {
    backend: BackendChoice;
    modelSource: ModelSource;
    asr: AsrSettings;
    tts: TtsSettings;
  };
  models: { parakeet: ModelSummary | null; kokoro: ModelSummary | null };
  downloads: { parakeet: ModelLoadRecord | null; kokoro: ModelLoadRecord | null };
  asr: AsrRunMetrics | null;
  tts: TtsRunMetrics | null;
  endToEnd: EndToEndMetrics;
  accuracy: AccuracyResult | null;
  privacy: {
    /** Network requests observed (page + inference workers) between Record and playback complete. Expected: 0. */
    networkRequestsDuringRun: number;
    onlineAtStart: boolean;
    onlineAtEnd: boolean;
  };
  errors: string[];
}

// ---------------------------------------------------------------------------
// Meeting transcription (phase 2)
// ---------------------------------------------------------------------------

/** 'mic' = getUserMedia microphone; 'system' = audio captured with getDisplayMedia (call / tab / system audio). */
export type AudioSourceKind = 'mic' | 'system';

export interface TranscriptWord {
  text: string;
  /** ms from session start */
  startMs: number;
  endMs: number;
  confidence: number | null;
}

export interface TranscriptSegment {
  id: string;
  source: AudioSourceKind;
  /** ms from session start on the audio timeline (comparable across sources). */
  startMs: number;
  endMs: number;
  text: string;
  words: TranscriptWord[] | null;
  /** Assigned by speaker clustering; null until assigned or when the segment was too short to identify. */
  speakerId: string | null;
  speakerConfidence: number | null;
}

export interface TranscriptSpeaker {
  /** Stable within a transcript, e.g. 'mic-1', 'system-2'. Clustering never mixes sources. */
  id: string;
  /** Display name: 'Speaker 1' by default, renamed by the user. */
  name: string;
  source: AudioSourceKind;
}

export interface SessionStats {
  /** Audio captured, per source. */
  audioMs: Partial<Record<AudioSourceKind, number>>;
  /** All ASR inference time in the session (partials + finals). */
  asrComputeMs: number;
  /** asrComputeMs / total audio across sources. Must stay well below 1 for a meeting to keep up. */
  rtf: number | null;
  /** End of a segment's speech → its final text, over all segments. */
  finalLatency: IntervalStats;
  /** Worst backlog of untranscribed audio observed during the session. */
  maxBacklogMs: number;
  /** Partial passes skipped because inference was busy. */
  skippedPartials: number;
  segments: number;
  speakerComputeMs: number | null;
}

export interface Transcript {
  schemaVersion: 1;
  id: string;
  title: string;
  /** ISO timestamps */
  createdAt: string;
  updatedAt: string;
  /** Wall-clock length of the session. */
  durationMs: number;
  sources: AudioSourceKind[];
  speakers: TranscriptSpeaker[];
  segments: TranscriptSegment[];
  stats: SessionStats | null;
  /** Model/backend facts for context when comparing transcripts across machines. */
  models: { asr: ModelSummary | null; speaker: ModelSummary | null };
  app: { version: string; commit: string | null };
}

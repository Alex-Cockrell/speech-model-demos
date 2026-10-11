/** Speech-to-text contracts. Timestamp conventions: see @localspeech/core's types. */
import type { IntervalStats } from '@localspeech/core';

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

/** 'mic' = getUserMedia microphone; 'system' = audio captured with getDisplayMedia (call / tab / system audio). */
export type AudioSourceKind = 'mic' | 'system';

export interface TranscriptWord {
  text: string;
  /** ms from session start */
  startMs: number;
  endMs: number;
  confidence: number | null;
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

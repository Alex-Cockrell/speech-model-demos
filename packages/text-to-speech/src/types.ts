/** Text-to-speech contracts. Timestamp conventions: see @localspeech/core's types. */
import type { IntervalStats } from '@localspeech/core';

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

/**
 * Continuous, multi-source transcription for the meeting mode. OWNER: ASR agent (implementation lives in
 * engine.ts → live-session.ts, transcriber.ts, segmenter.ts); consumed by the meeting UI.
 *
 * Each source (microphone, call/system audio) is segmented by voice activity into speech segments. While a
 * segment is open, it is re-transcribed from its start every `partialIntervalMs` (skipped while inference is
 * busy) to produce live partial text. When the speaker pauses for `minSilenceMs` (or the segment reaches
 * `maxSegmentMs`), the segment is transcribed once more as its final text and handed out with its audio, so
 * the meeting layer can assign a speaker. Finals always run before partials. Memory stays flat: only open
 * segments are kept.
 *
 * Time base: `startMs` / `endMs` are milliseconds since the session started (wall-clock timeline, so segments
 * from different sources interleave correctly). `at` fields are main-thread clock values (now()).
 */
import type { AsrSettings, AudioSourceKind, SessionStats, TranscriptWord } from './types.js';

export interface SessionSourceInput {
  kind: AudioSourceKind;
  /**
   * 'mic': optional; when omitted the engine opens the default microphone itself.
   * 'system': required; a stream with an audio track from requestSystemAudio(), which must be called
   * synchronously inside the user's click, before any await.
   * The session owns the stream: it is stopped when the session ends, or right away if the session cannot start.
   */
  stream?: MediaStream;
}

export interface SessionOptions {
  sources: SessionSourceInput[];
  /** Defaults to the values from the engine's last load(). */
  segmentation?: Partial<Pick<AsrSettings, 'partialIntervalMs' | 'minSilenceMs' | 'maxSegmentMs'>>;
}

export interface SegmentStartEvent {
  segmentId: string;
  source: AudioSourceKind;
  /** Start of the segment's audio: 300 ms before the detected speech onset. */
  startMs: number;
  at: number;
}

export interface SegmentPartialEvent {
  segmentId: string;
  source: AudioSourceKind;
  startMs: number;
  /** Text of the whole open segment so far (replaces the previous partial of this segment). */
  text: string;
  at: number;
}

export interface SegmentFinalEvent {
  segmentId: string;
  source: AudioSourceKind;
  startMs: number;
  /** startMs + audio duration. */
  endMs: number;
  /** Final text. Can be empty (noise that passed the VAD); the meeting UI drops empty segments. */
  text: string;
  /** Word timings in session ms with confidences; null when the final pass failed and the last partial text was kept. */
  words: TranscriptWord[] | null;
  /** 16 kHz mono PCM of the segment. Ownership passes to the receiver (transfer it to the speaker worker). */
  audio: Float32Array;
  /** Inference time of the final pass (0 when it did not run). */
  computeMs: number;
  /**
   * End of the segment's speech → final text available on the main thread. Includes the minSilenceMs pause that
   * ended the segment, the wait for the worker and the pass itself.
   */
  latencyMs: number;
  at: number;
}

export interface LiveSessionStats {
  at: number;
  elapsedMs: number;
  audioMs: Partial<Record<AudioSourceKind, number>>;
  asrComputeMs: number;
  /** asrComputeMs / total audio. Must stay well below 1 for the meeting to keep up. */
  rtf: number | null;
  /**
   * Ended speech queued behind the final pass in flight (that segment itself is not counted). Stays at 0 while
   * the machine keeps up; growing means it can't.
   */
  backlogMs: number;
  /** Finals waiting for or in inference. */
  queueDepth: number;
  /** Partial passes that could not run on time (one per partialIntervalMs of waiting). */
  skippedPartials: number;
  /** Finals delivered so far. */
  segments: number;
}

export interface SessionCallbacks {
  onSegmentStart?: (e: SegmentStartEvent) => void;
  onPartial?: (e: SegmentPartialEvent) => void;
  onFinal?: (e: SegmentFinalEvent) => void;
  /** RMS 0..1 per source, roughly every 50 ms. */
  onLevel?: (source: AudioSourceKind, rms: number) => void;
  /** About once per second. */
  onStats?: (s: LiveSessionStats) => void;
  /**
   * A source ended on its own (screen sharing stopped, device unplugged). The session continues with the rest;
   * once every source has ended it stays open, idle, until stop().
   */
  onSourceEnded?: (source: AudioSourceKind, reason: string) => void;
  /** Non-fatal problems, e.g. one inference pass failed. */
  onError?: (message: string) => void;
}

export interface TranscriptionSession {
  /** Main-thread clock value when the session started; startMs values are relative to it. */
  readonly startedAt: number;
  readonly sources: readonly AudioSourceKind[];
  readonly paused: boolean;
  /** Stop listening (audio during a pause is discarded; open segments are finalized first). */
  pause(): void;
  resume(): void;
  /**
   * Stop capture, finalize open segments (their onFinal fires before this resolves), release devices.
   * speakerComputeMs is null in the result (the meeting layer fills it). Calling it again returns the same promise.
   */
  stop(): Promise<SessionStats>;
  /** Ends at once without finalizing open segments (no more events); devices are released. */
  abort(reason?: string): void;
}

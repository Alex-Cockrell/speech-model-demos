/**
 * Shared contracts for the browser-local speech PoC.
 *
 * Timestamp convention
 * --------------------
 * Every numeric field named `...At`, `...Start`, `...Stop`, `...Ready` or `...Complete` is a
 * main-thread `performance.now()` value in milliseconds. Code running in a Web Worker must use
 * `now()` from `@localspeech/core` (after calling `setMainTimeOrigin()`), which already returns
 * main-thread clock values. Fields ending in `Ms` are durations in milliseconds.
 *
 * `null` means "did not happen / could not be measured". Never use 0 as a sentinel.
 */

export type * from '@localspeech/core';
export type * from '@localspeech/speech-to-text';
export type * from '@localspeech/text-to-speech';

import type { AudioSourceKind, TranscriptWord } from '@localspeech/speech-to-text';
import type { AsrRunMetrics, AsrSettings, SessionStats } from '@localspeech/speech-to-text';
import type { TtsRunMetrics, TtsSettings } from '@localspeech/text-to-speech';
import type { BackendChoice, EnvironmentInfo, LoadKind, ModelLoadRecord, ModelSource, ResolvedBackend } from '@localspeech/core';

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

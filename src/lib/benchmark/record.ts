/** Assembly of the per-run benchmark record (spec §14). */
import { span } from '@localspeech/core';
import { APP_INFO } from '../config';
import type {
  AccuracyResult,
  AsrRunMetrics,
  BenchmarkRecord,
  EndToEndMetrics,
  EnvironmentInfo,
  ModelLoadRecord,
  ModelSummary,
  RunMode,
  TtsRunMetrics,
} from '../types';

/** Spec §11 aggregates. Missing stages yield null, never 0. */
export function computeEndToEnd(asr: AsrRunMetrics | null, tts: TtsRunMetrics | null): EndToEndMetrics {
  return {
    voiceToFirstTextMs: span(asr?.speechStart, asr?.firstPartialAt),
    stopToFinalTextMs: span(asr?.recordingStop, asr?.finalTranscriptAt),
    textToFirstSpeechMs: span(asr?.finalTranscriptAt, tts?.firstPlaybackStartAt),
    stopToFirstSpeechMs: span(asr?.recordingStop, tts?.firstPlaybackStartAt),
    fullRoundTripMs: span(asr?.speechStart, tts?.playbackCompleteAt),
  };
}

export function summarizeModel(load: ModelLoadRecord | null, runsSinceLoad: number): ModelSummary | null {
  if (!load) return null;
  return {
    name: load.displayName,
    repo: load.repo,
    revision: load.revision,
    quantization: load.quantization,
    backend: load.resolvedBackend,
    loadKind: load.loadKind,
    runsSinceLoad,
    versions: load.versions,
  };
}

export interface ModelRunInput {
  /** Load record of the instance used for this run. */
  load: ModelLoadRecord | null;
  /** Runs completed with that instance before this one. */
  runsSinceLoad: number;
}

export interface RecordInput {
  id: string;
  createdAt: string;
  label: string;
  testCase: string | null;
  mode: RunMode;
  /** location.origin */
  origin: string;
  environment: EnvironmentInfo;
  settings: BenchmarkRecord['settings'];
  parakeet: ModelRunInput;
  kokoro: ModelRunInput;
  asr: AsrRunMetrics | null;
  tts: TtsRunMetrics | null;
  accuracy: AccuracyResult | null;
  privacy: BenchmarkRecord['privacy'];
  errors: string[];
}

export function buildBenchmarkRecord(input: RecordInput): BenchmarkRecord {
  return {
    schemaVersion: 1,
    id: input.id,
    createdAt: input.createdAt,
    label: input.label.trim(),
    testCase: input.testCase,
    mode: input.mode,
    app: { version: APP_INFO.version, commit: APP_INFO.commit, builtAt: APP_INFO.builtAt, origin: input.origin },
    environment: input.environment,
    settings: input.settings,
    models: {
      parakeet: summarizeModel(input.parakeet.load, input.parakeet.runsSinceLoad),
      kokoro: summarizeModel(input.kokoro.load, input.kokoro.runsSinceLoad),
    },
    downloads: { parakeet: input.parakeet.load, kokoro: input.kokoro.load },
    asr: input.asr,
    tts: input.tts,
    endToEnd: computeEndToEnd(input.asr, input.tts),
    accuracy: input.accuracy,
    privacy: input.privacy,
    errors: input.errors,
  };
}

export function newRunId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** e.g. speech-benchmarks-2026-10-04-1432.json */
export function exportFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `speech-benchmarks-${day}-${pad(date.getHours())}${pad(date.getMinutes())}.json`;
}

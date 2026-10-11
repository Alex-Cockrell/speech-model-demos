import { DEFAULT_ASR_SETTINGS, DEFAULT_TTS_SETTINGS, HUGGING_FACE_BASE_URL, NETWORK_LOCKED, defaultModelSource } from '../config';
import { VOICES } from '@localspeech/text-to-speech';
import type { AsrSettings, BackendChoice, ModelSource, RunMode, TtsSettings } from '../types';
import { BENCHMARK_PHRASES, DEFAULT_PHRASE_ID } from './phrases';
import { TEST_MATRIX } from './testMatrix';

/** Everything the dashboard persists per browser. */
export interface AppSettings {
  backend: BackendChoice;
  sourceKind: ModelSource['kind'];
  /** Kept while Hugging Face is selected so switching back doesn't lose it. */
  mirrorBaseUrl: string;
  asr: AsrSettings;
  tts: TtsSettings;
  mode: RunMode;
  phraseId: string;
  /** Free-text device label, e.g. "Managed Dell 5440". */
  label: string;
  /** Spec §17 test-matrix row id, if the tester tagged one. */
  testCase: string | null;
}

export const BACKEND_CHOICES: readonly BackendChoice[] = ['auto', 'webgpu', 'wasm'];
export const ENCODER_QUANTS: readonly AsrSettings['encoderQuant'][] = ['auto', 'int8', 'fp16', 'fp32'];
export const FINAL_PASSES: readonly AsrSettings['finalPass'][] = ['segments', 'full'];
export const KOKORO_DTYPES: readonly TtsSettings['dtype'][] = ['auto', 'q8', 'fp32', 'fp16', 'q4', 'q4f16'];
export const TTS_SPLITS: readonly TtsSettings['split'][] = ['sentence', 'clause'];
/** 0 = let ONNX Runtime decide. */
export const WASM_THREAD_CHOICES: readonly number[] = [0, 1, 2, 4, 8, 16];
export const PARTIAL_INTERVAL_CHOICES: readonly number[] = [400, 600, 800, 1200, 1600, 2400];
export const MIN_SILENCE_CHOICES: readonly number[] = [300, 450, 600, 800, 1000, 1500];
export const MAX_SEGMENT_CHOICES: readonly number[] = [10_000, 15_000, 20_000, 30_000];
export const SPEED_RANGE = { min: 0.5, max: 2, step: 0.05 } as const;
const RUN_MODES: readonly RunMode[] = ['free', 'benchmark'];
const SOURCE_KINDS: readonly ModelSource['kind'][] = ['huggingface', 'mirror'];

export { VOICES, voiceName } from '@localspeech/text-to-speech';

export function defaultSettings(): AppSettings {
  const source = defaultModelSource();
  return {
    backend: 'auto',
    sourceKind: source.kind,
    mirrorBaseUrl: source.kind === 'mirror' ? source.baseUrl : '',
    asr: { ...DEFAULT_ASR_SETTINGS },
    tts: { ...DEFAULT_TTS_SETTINGS },
    mode: 'benchmark',
    phraseId: DEFAULT_PHRASE_ID,
    label: '',
    testCase: null,
  };
}

type Loose = Record<string, unknown>;

function isObject(v: unknown): v is Loose {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function oneOf<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Accepts anything (e.g. stale or hand-edited localStorage) and returns valid settings. */
export function sanitizeSettings(raw: unknown): AppSettings {
  const d = defaultSettings();
  if (!isObject(raw)) return d;
  const asr: Loose = isObject(raw.asr) ? raw.asr : {};
  const tts: Loose = isObject(raw.tts) ? raw.tts : {};
  return {
    backend: oneOf(raw.backend, BACKEND_CHOICES, d.backend),
    sourceKind: oneOf(raw.sourceKind, SOURCE_KINDS, d.sourceKind),
    mirrorBaseUrl: typeof raw.mirrorBaseUrl === 'string' ? raw.mirrorBaseUrl.slice(0, 500) : d.mirrorBaseUrl,
    asr: {
      encoderQuant: oneOf(asr.encoderQuant, ENCODER_QUANTS, d.asr.encoderQuant),
      partialIntervalMs: oneOf(asr.partialIntervalMs, PARTIAL_INTERVAL_CHOICES, d.asr.partialIntervalMs),
      minSilenceMs: oneOf(asr.minSilenceMs, MIN_SILENCE_CHOICES, d.asr.minSilenceMs),
      maxSegmentMs: oneOf(asr.maxSegmentMs, MAX_SEGMENT_CHOICES, d.asr.maxSegmentMs),
      // Settings saved by version 1 (no partialIntervalMs yet) carry its old 'full' default; give them the new one.
      finalPass: asr.partialIntervalMs === undefined ? d.asr.finalPass : oneOf(asr.finalPass, FINAL_PASSES, d.asr.finalPass),
      wasmThreads: oneOf(asr.wasmThreads, WASM_THREAD_CHOICES, d.asr.wasmThreads),
    },
    tts: {
      dtype: oneOf(tts.dtype, KOKORO_DTYPES, d.tts.dtype),
      voice: oneOf(
        tts.voice,
        VOICES.map((v) => v.id),
        d.tts.voice,
      ),
      speed: clampNumber(tts.speed, SPEED_RANGE.min, SPEED_RANGE.max, d.tts.speed),
      split: oneOf(tts.split, TTS_SPLITS, d.tts.split),
      wasmThreads: oneOf(tts.wasmThreads, WASM_THREAD_CHOICES, d.tts.wasmThreads),
    },
    mode: oneOf(raw.mode, RUN_MODES, d.mode),
    phraseId: oneOf(
      raw.phraseId,
      BENCHMARK_PHRASES.map((p) => p.id),
      d.phraseId,
    ),
    label: typeof raw.label === 'string' ? raw.label.slice(0, 120) : d.label,
    testCase: oneOf(raw.testCase, [null, ...TEST_MATRIX.map((t) => t.id)], null),
  };
}

/** http(s) origin + optional path, no trailing slash, no query/fragment. null when invalid. */
export function normalizeBaseUrl(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.search || url.hash) return null;
    return trimmed;
  } catch {
    return null;
  }
}

export function resolveModelSource(s: Pick<AppSettings, 'sourceKind' | 'mirrorBaseUrl'>): {
  source: ModelSource | null;
  error: string | null;
} {
  // A locked build may only reach its own model host, so a saved in-app choice is ignored.
  if (NETWORK_LOCKED) return { source: defaultModelSource(), error: null };
  if (s.sourceKind === 'huggingface') return { source: { kind: 'huggingface', baseUrl: HUGGING_FACE_BASE_URL }, error: null };
  const baseUrl = normalizeBaseUrl(s.mirrorBaseUrl);
  return baseUrl
    ? { source: { kind: 'mirror', baseUrl }, error: null }
    : { source: null, error: 'Enter a valid mirror base URL, e.g. https://models.example.com' };
}

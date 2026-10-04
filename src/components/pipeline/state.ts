/** Pipeline state shared by the controller and the panels, and what each state allows. */
import { resolveModelSource, type AppSettings } from '@/lib/benchmark/settings';
import type {
  AccuracyResult,
  AsrRunMetrics,
  AsrSettings,
  BackendChoice,
  BenchmarkPhrase,
  BenchmarkRecord,
  EnvironmentInfo,
  LoadProgress,
  ModelKey,
  ModelLoadRecord,
  ModelSource,
  PartialUpdate,
  RunMode,
  StorageInfo,
  TtsChunkRecord,
  TtsRunMetrics,
  TtsSettings,
} from '@/lib/types';

export type ModelPhase = 'idle' | 'loading' | 'ready' | 'error';

/** What a model instance was loaded with. */
export interface LoadConfig<S> {
  backend: BackendChoice;
  source: ModelSource;
  settings: S;
}

export interface FileProgress {
  loadedBytes: number;
  totalBytes: number | null;
}

export interface ModelState<S> {
  phase: ModelPhase;
  /** Latest progress event while loading. */
  progress: LoadProgress | null;
  /** Byte progress per file while loading. */
  fileProgress: Record<string, FileProgress>;
  loadStartedAt: number | null;
  /** Result of the latest successful load() call: may be a 'session' record when the instance was reused. */
  record: ModelLoadRecord | null;
  /** How the active instance was originally loaded (cold / warm / partial); differs from record after a session load. */
  instanceRecord: ModelLoadRecord | null;
  /** Configuration of the active instance; null when nothing is loaded. */
  applied: LoadConfig<S> | null;
  error: string | null;
  /** Runs completed with the active instance. */
  runsSinceLoad: number;
}

export interface ModelsState {
  parakeet: ModelState<AsrSettings>;
  kokoro: ModelState<TtsSettings>;
}

export type RunPhase = 'starting' | 'recording' | 'finalizing' | 'speaking' | 'done' | 'failed' | 'cancelled';
export type RunStage = 'microphone' | 'asr' | 'tts' | 'privacy';

export interface RunError {
  stage: RunStage;
  message: string;
}

/** Requests seen between Record and playback complete, by origin; null = could not be counted. */
export interface NetworkCounts {
  page: number | null;
  asrWorker: number | null;
  ttsWorker: number | null;
}

export interface RunState {
  id: string;
  phase: RunPhase;
  mode: RunMode;
  phrase: BenchmarkPhrase | null;
  /** now() at the Record click. For live displays only; the ASR engine records micStart itself. */
  clickedAt: number;
  speechStartAt: number | null;
  partials: PartialUpdate[];
  asr: AsrRunMetrics | null;
  /** now() right before tts.speak(). For live displays until TtsRunMetrics.ttsStart arrives. */
  speakCalledAt: number | null;
  chunks: TtsChunkRecord[];
  playbackStartAt: number | null;
  tts: TtsRunMetrics | null;
  accuracy: AccuracyResult | null;
  network: NetworkCounts | null;
  record: BenchmarkRecord | null;
  errors: RunError[];
}

export interface CacheClearResult {
  at: string;
  cleared: string[];
  errors: string[];
}

export interface PersistRequestResult {
  persisted: boolean | null;
  error: string | null;
}

export interface PipelineSnapshot {
  environment: EnvironmentInfo | null;
  environmentError: string | null;
  online: boolean;
  storage: StorageInfo | null;
  storageError: string | null;
  settings: AppSettings;
  settingsError: string | null;
  models: ModelsState;
  loading: boolean;
  clearing: boolean;
  /** asr.startRecording() hasn't settled; a new Record waits even if that run was cancelled. */
  startPending: boolean;
  run: RunState | null;
  history: BenchmarkRecord[];
  historyError: string | null;
  cacheClear: CacheClearResult | null;
  persistRequest: PersistRequestResult | null;
  /**
   * A meeting session or read-aloud playback in progress (claimed through PipelineController.claimActivity).
   * The microphone, audio output and models are shared between modes, so only one mode runs at a time.
   */
  activity: AppActivity | null;
}

/** Long-running work outside the benchmark run itself. */
export type AppActivity = 'meeting' | 'readaloud';

export const ACTIVITY_NAMES: Record<AppActivity, string> = { meeting: 'the meeting transcription', readaloud: 'read-aloud playback' };

/** User-facing model names: the UI never names the underlying models or libraries. */
export const MODEL_NAMES: Record<ModelKey, string> = { parakeet: 'Transcription model', kokoro: 'Voice model' };

const ACTIVE_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>(['starting', 'recording', 'finalizing', 'speaking']);

export function isRunActive(run: RunState | null): boolean {
  return run != null && ACTIVE_PHASES.has(run.phase);
}

/** `holder`: the mode asking, which may load models while it holds the activity (e.g. claim, then load, then play). */
export function loadBlocker(s: PipelineSnapshot, holder?: AppActivity): string | null {
  if (!s.environment) return 'Detecting the environment…';
  if (s.loading) return 'Loading…';
  if (s.clearing) return 'Clearing model caches…';
  if (s.startPending || isRunActive(s.run)) return 'Wait for the current run to finish.';
  if (s.activity && s.activity !== holder) return `Stop ${ACTIVITY_NAMES[s.activity]} first.`;
  return resolveModelSource(s.settings).error;
}

export function recordBlocker(s: PipelineSnapshot): string | null {
  if (!s.environment) return 'Detecting the environment…';
  if (s.loading) return 'Loading models…';
  if (s.clearing) return 'Clearing model caches…';
  if (s.startPending) return 'The microphone is still starting…';
  if (isRunActive(s.run)) return 'A run is in progress.';
  if (s.activity) return `Stop ${ACTIVITY_NAMES[s.activity]} first.`;
  const missing = (['parakeet', 'kokoro'] as const).filter((k) => s.models[k].phase !== 'ready');
  if (missing.length > 0) return `Load the ${missing.map((k) => MODEL_NAMES[k].toLowerCase()).join(' and ')} first.`;
  return null;
}

export function clearBlocker(s: PipelineSnapshot): string | null {
  if (s.loading) return 'Wait for loading to finish.';
  if (s.clearing) return 'Clearing…';
  if (s.startPending || isRunActive(s.run)) return 'Wait for the current run to finish.';
  if (s.activity) return `Stop ${ACTIVITY_NAMES[s.activity]} first.`;
  return null;
}

function idleModel<S>(): ModelState<S> {
  return {
    phase: 'idle',
    progress: null,
    fileProgress: {},
    loadStartedAt: null,
    record: null,
    instanceRecord: null,
    applied: null,
    error: null,
    runsSinceLoad: 0,
  };
}

export function initialModels(): ModelsState {
  return { parakeet: idleModel(), kokoro: idleModel() };
}

/** Count a completed run, and notice an engine that lost its model mid-session (e.g. its worker crashed). */
export function afterRun<S>(model: ModelState<S>, used: boolean, stillLoaded: boolean, name: string): ModelState<S> {
  if (model.phase === 'ready' && !stillLoaded) {
    return { ...model, phase: 'error', applied: null, error: `The ${name.toLowerCase()} is no longer loaded (its worker stopped). Load models again.` };
  }
  return used ? { ...model, runsSinceLoad: model.runsSinceLoad + 1 } : model;
}

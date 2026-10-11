/**
 * Pipeline orchestration: environment, model loading, the Record → Parakeet → Kokoro run, privacy
 * accounting, benchmark records, run history and storage utilities.
 *
 * A plain class holding one immutable snapshot, so the async run flow always reads current state
 * (no stale React closures). useSpeechPipeline subscribes to it with useSyncExternalStore.
 */
import { assessAccuracy } from '@/lib/accuracy/wer';
import { AsrEngine } from '@localspeech/speech-to-text';
import { errorMessage } from '@/lib/benchmark/errors';
import { HISTORY_LIMIT, readHistory, readSettings, removeHistory, writeHistory, writeSettings } from '@/lib/benchmark/persist';
import { findPhrase } from '@/lib/benchmark/phrases';
import { buildBenchmarkRecord, newRunId } from '@/lib/benchmark/record';
import { resolveModelSource, sanitizeSettings, type AppSettings } from '@/lib/benchmark/settings';
import { now } from '@localspeech/core';
import { HUGGING_FACE_BASE_URL } from '@/lib/config';
import { detectEnvironment } from '@localspeech/core';
import { clearModelCaches, createPageNetworkMonitor, getStorageInfo, requestPersistentStorage } from '@localspeech/core';
import { TtsEngine } from '@localspeech/text-to-speech';
import type {
  AccuracyResult,
  AsrRunMetrics,
  AsrSettings,
  BenchmarkPhrase,
  BenchmarkRecord,
  EnvironmentInfo,
  LoadProgress,
  ModelKey,
  ModelLoadRecord,
  RunMode,
  TtsRunMetrics,
  TtsSettings,
} from '@/lib/types';
import { createLevelStore, type LevelStore } from './levelStore';
import { createProgressSink } from './progress';
import {
  afterRun,
  clearBlocker,
  initialModels,
  isRunActive,
  loadBlocker,
  MODEL_NAMES,
  recordBlocker,
  type AppActivity,
  type LoadConfig,
  type ModelState,
  type ModelsState,
  type NetworkCounts,
  type PipelineSnapshot,
  type RunError,
  type RunStage,
  type RunState,
} from './state';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RunContext {
  id: string;
  createdAt: string;
  asr: AsrEngine;
  tts: TtsEngine;
  monitor: { start(): void; stop(): number } | null;
  /** Engine request counts at Record time. */
  baseline: Promise<PromiseSettledResult<number>[]>;
  onlineAtStart: boolean;
  mode: RunMode;
  phrase: BenchmarkPhrase | null;
  label: string;
  testCase: string | null;
  /** Configuration actually used by this run (the loaded instances' settings + per-run TTS fields). */
  settings: BenchmarkRecord['settings'];
  playbackStopped: boolean;
}

/** Calls fn immediately, turning a synchronous throw into a rejected promise. */
function attempt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return fn();
  } catch (e) {
    return Promise.reject(e);
  }
}

const COUNT_TIMEOUT_MS = 5000;

/** Request counts come from the workers; one that stopped answering must not leave the run unfinished. */
function requestCount(fn: () => Promise<number>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${COUNT_TIMEOUT_MS} ms`)), COUNT_TIMEOUT_MS);
    attempt(fn).then(
      (count) => {
        clearTimeout(timer);
        resolve(count);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const MICROPHONE_ERRORS = new Set(['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'SecurityError']);

function isMicrophoneError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && MICROPHONE_ERRORS.has((e as { name?: string }).name ?? '');
}

/** Only used if detectEnvironment() breaks its never-throw contract, so the app stays usable. */
function fallbackEnvironment(error: string): EnvironmentInfo {
  return {
    collectedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    browser: { name: 'Unknown', version: '', fullVersion: null },
    os: { name: 'Unknown', version: null, architecture: null, bitness: null },
    mobile: null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemoryGB: null,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    wasm: {
      available: typeof WebAssembly !== 'undefined',
      simd: false,
      threads: false,
      speedProbeMs: null,
      likelyInterpreted: null,
    },
    webgpu: {
      apiPresent: 'gpu' in navigator,
      adapterAvailable: false,
      adapter: null,
      features: [],
      shaderF16: false,
      limits: null,
      error,
    },
    storage: { usageBytes: null, quotaBytes: null, persisted: null },
    online: navigator.onLine,
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/** ASR settings that apply per run, without reloading the model. */
const RUN_ASR_KEYS = ['partialIntervalMs', 'minSilenceMs', 'maxSegmentMs', 'finalPass'] as const;

function pickRunAsrSettings(asr: AsrSettings): Pick<AsrSettings, (typeof RUN_ASR_KEYS)[number]> {
  return {
    partialIntervalMs: asr.partialIntervalMs,
    minSilenceMs: asr.minSilenceMs,
    maxSegmentMs: asr.maxSegmentMs,
    finalPass: asr.finalPass,
  };
}

export class PipelineController {
  readonly level: LevelStore = createLevelStore();
  private snapshot: PipelineSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly cacheClearListeners = new Set<() => void>();
  private asrEngine: AsrEngine | null = null;
  private ttsEngine: TtsEngine | null = null;
  private runCtx: RunContext | null = null;

  constructor() {
    const { settings, error: settingsError } = readSettings();
    const { history, error: historyError } = readHistory();
    this.snapshot = {
      environment: null,
      environmentError: null,
      online: navigator.onLine,
      storage: null,
      storageError: null,
      settings,
      settingsError,
      models: initialModels(),
      loading: false,
      clearing: false,
      startPending: false,
      run: null,
      history,
      historyError,
      cacheClear: null,
      persistRequest: null,
      activity: null,
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): PipelineSnapshot => this.snapshot;

  private set(patch: Partial<PipelineSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private patchModel<S>(key: ModelKey, patch: Partial<ModelState<S>>): void {
    const models = { ...this.snapshot.models, [key]: { ...this.snapshot.models[key], ...patch } } as ModelsState;
    this.set({ models });
  }

  private patchRun(id: string, patch: Partial<RunState> | ((run: RunState) => Partial<RunState>)): void {
    const run = this.snapshot.run;
    if (!run || run.id !== id) return;
    this.set({ run: { ...run, ...(typeof patch === 'function' ? patch(run) : patch) } });
  }

  private addRunError(id: string, stage: RunStage, message: string): void {
    this.patchRun(id, (run) => ({ errors: [...run.errors, { stage, message }] }));
  }

  private asr(): AsrEngine {
    return (this.asrEngine ??= new AsrEngine());
  }

  private tts(): TtsEngine {
    return (this.ttsEngine ??= new TtsEngine());
  }

  // ----- shared with the meeting and read-aloud modes ----------------------

  /** The one Parakeet engine of the page; every mode uses it so the model is loaded once. */
  readonly getAsrEngine = (): AsrEngine => this.asr();

  /** The one Kokoro engine of the page. */
  readonly getTtsEngine = (): TtsEngine => this.tts();

  /**
   * Reserve the microphone / audio output / models for a long-running mode. Returns false (and changes
   * nothing) while a benchmark run, model load, cache clear or the other mode is in progress.
   */
  readonly claimActivity = (activity: AppActivity): boolean => {
    const s = this.snapshot;
    if (s.activity === activity) return true;
    if (s.activity || s.loading || s.clearing || s.startPending || isRunActive(s.run)) return false;
    this.set({ activity });
    return true;
  };

  /**
   * Engines owned outside this controller (the meeting's speaker model) subscribe here to dispose their
   * workers before the caches are deleted, so the next load is cold for them too.
   */
  readonly onCachesCleared = (listener: () => void): (() => void) => {
    this.cacheClearListeners.add(listener);
    return () => {
      this.cacheClearListeners.delete(listener);
    };
  };

  readonly releaseActivity = (activity: AppActivity): void => {
    if (this.snapshot.activity !== activity) return;
    this.set({ activity: null });
    // Per-run ASR settings changed while the meeting ran were deferred.
    void this.applyAsrRunSettings();
  };

  // ----- lifecycle ---------------------------------------------------------

  /** Call from an effect; returns the cleanup. */
  readonly mount = (): (() => void) => {
    const syncOnline = () => this.set({ online: navigator.onLine });
    window.addEventListener('online', syncOnline);
    window.addEventListener('offline', syncOnline);
    syncOnline();
    void this.loadEnvironment();
    void this.refreshStorage();
    return () => {
      window.removeEventListener('online', syncOnline);
      window.removeEventListener('offline', syncOnline);
      this.teardown();
    };
  };

  private async loadEnvironment(): Promise<void> {
    try {
      const environment = await detectEnvironment();
      this.set({ environment, environmentError: null, storage: this.snapshot.storage ?? environment.storage });
    } catch (e) {
      const message = errorMessage(e);
      this.set({ environment: fallbackEnvironment(message), environmentError: message });
    }
  }

  /** Release microphone, audio and workers on unmount. There is no UI left to show errors in, hence console. */
  private teardown(): void {
    const ctx = this.runCtx;
    this.runCtx = null;
    if (ctx) {
      try {
        ctx.monitor?.stop();
      } catch (e) {
        console.error(e);
      }
      attempt(() => ctx.asr.cancelRecording()).catch((e) => console.error(e));
      try {
        ctx.tts.stop();
      } catch (e) {
        console.error(e);
      }
      this.patchRun(ctx.id, { phase: 'cancelled' });
    }
    for (const engine of [this.asrEngine, this.ttsEngine]) {
      try {
        engine?.dispose();
      } catch (e) {
        console.error(e);
      }
    }
    this.asrEngine = null;
    this.ttsEngine = null;
    this.level.set(0);
    this.set({ models: initialModels(), loading: false, startPending: false });
  }

  // ----- settings ----------------------------------------------------------

  readonly updateSettings = (update: (s: AppSettings) => AppSettings): void => {
    const previous = this.snapshot.settings.asr;
    const settings = sanitizeSettings(update(this.snapshot.settings));
    this.set({ settings, settingsError: writeSettings(settings) });
    if (RUN_ASR_KEYS.some((k) => settings.asr[k] !== previous[k])) {
      void this.applyAsrRunSettings();
    }
  };

  /**
   * The per-run ASR settings (RUN_ASR_KEYS) reach the ASR engine only through load(). Re-sending the loaded configuration with
   * the new values is an instant session reuse, so they act as per-run settings: no reload, and the card keeps
   * showing how the instance was really loaded.
   */
  private async applyAsrRunSettings(): Promise<void> {
    const s = this.snapshot;
    const model = s.models.parakeet;
    const applied = model.applied;
    const engine = this.asrEngine;
    if (model.phase !== 'ready' || !applied || !engine || !s.environment || s.loading) return;
    // The engine rejects load() while a meeting session or recording runs; releaseActivity() re-applies.
    if (s.activity || s.startPending || isRunActive(s.run)) return;
    const runSettings = pickRunAsrSettings(s.settings.asr);
    const settings: AsrSettings = { ...applied.settings, ...runSettings };
    try {
      const result = await engine.load({ ...applied, settings, environment: s.environment });
      const current = this.snapshot.models.parakeet;
      if (result.loadKind !== 'session') {
        // Not expected (same load key), but if the engine did reload, mirror it.
        this.patchModel<AsrSettings>('parakeet', {
          record: result,
          instanceRecord: engine.loadRecord ?? result,
          applied: { ...applied, settings },
          runsSinceLoad: 0,
        });
      } else if (current.applied && current.record === model.record) {
        this.patchModel<AsrSettings>('parakeet', {
          applied: { ...current.applied, settings: { ...current.applied.settings, ...runSettings } },
        });
      }
    } catch (e) {
      this.patchModel('parakeet', { error: `Could not apply the per-run ASR settings: ${errorMessage(e)}` });
    }
  }

  // ----- model loading -----------------------------------------------------

  /**
   * Load (or re-use) the given models with the current settings; the meeting and read-aloud modes need one each.
   * A mode that already holds the activity passes it, so it can claim first and load afterwards without a race.
   */
  readonly loadModels = async (
    keys: readonly ModelKey[] = ['parakeet', 'kokoro'],
    opts: { activity?: AppActivity } = {},
  ): Promise<void> => {
    const s = this.snapshot;
    const environment = s.environment;
    const { source } = resolveModelSource(s.settings);
    if (loadBlocker(s, opts.activity) !== null || !environment || !source) return;

    this.set({ loading: true, cacheClear: null });
    const backend = s.settings.backend;
    const asrConfig: LoadConfig<AsrSettings> = { backend, source, settings: { ...s.settings.asr } };
    const ttsConfig: LoadConfig<TtsSettings> = { backend, source, settings: { ...s.settings.tts } };

    // Sequential, so each model's download and initialisation are measured without contention.
    if (keys.includes('parakeet')) {
      const asr = this.asr();
      await this.loadModel('parakeet', asrConfig, asr, (onProgress) => asr.load({ ...asrConfig, environment, onProgress }));
    }
    if (keys.includes('kokoro')) {
      const tts = this.tts();
      await this.loadModel('kokoro', ttsConfig, tts, (onProgress) => tts.load({ ...ttsConfig, environment, onProgress }));
    }

    this.set({ loading: false });
    void this.refreshStorage();
  };

  private async loadModel<S>(
    key: ModelKey,
    config: LoadConfig<S>,
    engine: { readonly isLoaded: boolean; readonly loadRecord: ModelLoadRecord | null },
    load: (onProgress: (p: LoadProgress) => void) => Promise<ModelLoadRecord>,
  ): Promise<void> {
    const previous = this.snapshot.models[key];
    const sink = createProgressSink((progress, fileProgress) => this.patchModel(key, { progress, fileProgress }));
    this.patchModel(key, { phase: 'loading', progress: null, fileProgress: {}, loadStartedAt: now(), error: null });
    try {
      const record = await load(sink.push);
      sink.close();
      this.patchModel<S>(key, {
        phase: 'ready',
        progress: null,
        fileProgress: {},
        record,
        instanceRecord: engine.loadRecord ?? (record.loadKind === 'session' ? previous.instanceRecord : record),
        applied: config,
        error: null,
        // A session load reuses the same instance, so its run count carries on.
        runsSinceLoad: record.loadKind === 'session' ? previous.runsSinceLoad : 0,
      });
    } catch (e) {
      sink.close();
      const message = errorMessage(e);
      if (engine.isLoaded && previous.applied) {
        this.patchModel(key, {
          phase: 'ready',
          progress: null,
          fileProgress: {},
          record: previous.record,
          instanceRecord: engine.loadRecord ?? previous.instanceRecord,
          error: `Load failed; the previously loaded instance is still active. ${message}`,
        });
      } else {
        this.patchModel(key, {
          phase: 'error',
          progress: null,
          fileProgress: {},
          record: null,
          instanceRecord: null,
          applied: null,
          error: message,
          runsSinceLoad: 0,
        });
      }
    }
  }

  // ----- the run -----------------------------------------------------------

  /** Record button. Everything up to asr.startRecording() runs synchronously inside the click. */
  readonly record = (): void => {
    const clickedAt = now();
    const s = this.snapshot;
    if (recordBlocker(s) !== null) return;
    const asr = this.asr();
    const tts = this.tts();
    const errors: RunError[] = [];

    // Autoplay policy: the playback AudioContext must be created/resumed synchronously in this gesture.
    try {
      tts.unlockAudio();
    } catch (e) {
      errors.push({ stage: 'tts', message: `Could not unlock audio playback: ${errorMessage(e)}` });
    }

    let monitor: RunContext['monitor'] = null;
    try {
      monitor = createPageNetworkMonitor();
      monitor.start();
    } catch (e) {
      monitor = null;
      errors.push({ stage: 'privacy', message: `Page network monitor unavailable: ${errorMessage(e)}` });
    }

    const { settings, models } = s;
    const parakeet = models.parakeet.applied;
    const kokoro = models.kokoro.applied;
    const ctx: RunContext = {
      id: newRunId(),
      createdAt: new Date().toISOString(),
      asr,
      tts,
      monitor,
      baseline: Promise.allSettled([requestCount(() => asr.networkRequestCount()), requestCount(() => tts.networkRequestCount())]),
      onlineAtStart: navigator.onLine,
      mode: settings.mode,
      phrase: settings.mode === 'benchmark' ? findPhrase(settings.phraseId) : null,
      label: settings.label,
      testCase: settings.testCase,
      settings: {
        backend: parakeet?.backend ?? kokoro?.backend ?? settings.backend,
        modelSource: parakeet?.source ?? kokoro?.source ?? { kind: 'huggingface', baseUrl: HUGGING_FACE_BASE_URL },
        asr: parakeet?.settings ?? settings.asr,
        // Load-time fields must match the loaded instance (its voice file was pre-fetched); speed and split are per run.
        tts: { ...(kokoro?.settings ?? settings.tts), speed: settings.tts.speed, split: settings.tts.split },
      },
      playbackStopped: false,
    };
    this.runCtx = ctx;

    const started = attempt(() =>
      asr.startRecording({
        onPartial: (update) => {
          if (this.runCtx === ctx) this.patchRun(ctx.id, (run) => ({ partials: [...run.partials, update] }));
        },
        onSpeechStart: (at) => {
          if (this.runCtx === ctx) this.patchRun(ctx.id, { speechStartAt: at });
        },
        onLevel: (rms) => {
          if (this.runCtx === ctx && this.snapshot.run?.phase === 'recording') this.level.set(rms);
        },
      }),
    );

    this.set({
      startPending: true,
      run: {
        id: ctx.id,
        phase: 'starting',
        mode: ctx.mode,
        phrase: ctx.phrase,
        clickedAt,
        speechStartAt: null,
        partials: [],
        asr: null,
        speakCalledAt: null,
        chunks: [],
        playbackStartAt: null,
        tts: null,
        accuracy: null,
        network: null,
        record: null,
        errors,
      },
    });

    started.then(
      () => {
        this.set({ startPending: false });
        if (this.runCtx !== ctx) {
          // Cancelled while the microphone was opening: make sure it is released.
          attempt(() => asr.cancelRecording()).catch((e) =>
            this.addRunError(ctx.id, 'microphone', `Releasing the microphone failed: ${errorMessage(e)}`),
          );
          return;
        }
        this.patchRun(ctx.id, { phase: 'recording' });
      },
      (e) => {
        this.set({ startPending: false });
        if (this.runCtx !== ctx) return;
        this.addRunError(ctx.id, isMicrophoneError(e) ? 'microphone' : 'asr', `Could not start recording: ${errorMessage(e)}`);
        void this.finishRun(ctx, null, null, null);
      },
    );
  };

  /** Stop button: finalize the transcript and hand it straight to Kokoro. */
  readonly stop = (): void => {
    const ctx = this.runCtx;
    const run = this.snapshot.run;
    if (!ctx || run?.id !== ctx.id || run.phase !== 'recording') return;
    // First thing in the handler: stopRecording() timestamps recordingStop itself.
    const stopped = attempt(() => ctx.asr.stopRecording());
    this.level.set(0);
    this.patchRun(ctx.id, { phase: 'finalizing' });
    void this.transcribeAndSpeak(ctx, stopped);
  };

  private async transcribeAndSpeak(ctx: RunContext, stopped: Promise<AsrRunMetrics>): Promise<void> {
    let asr: AsrRunMetrics | null = null;
    try {
      asr = await stopped;
    } catch (e) {
      this.addRunError(ctx.id, 'asr', `Finalizing the transcript failed: ${errorMessage(e)}`);
    }
    if (this.runCtx !== ctx) return; // unmounted while finalizing
    let tts: TtsRunMetrics | null = null;
    let accuracy: AccuracyResult | null = null;
    if (asr) {
      const text = asr.finalText;
      if (text.trim() === '') {
        accuracy = ctx.phrase ? assessAccuracy(ctx.phrase, asr.finalText, asr.streamingText) : null;
        this.addRunError(ctx.id, 'tts', 'The final transcript is empty, so TTS was skipped.');
        this.patchRun(ctx.id, { asr, accuracy });
      } else {
        // Straight from the ASR result into Kokoro, with no React render in between.
        const speakCalledAt = now();
        const spoken = attempt(() =>
          ctx.tts.speak(text, ctx.settings.tts, {
            onChunk: (chunk) => {
              if (this.runCtx === ctx) this.patchRun(ctx.id, (run) => ({ chunks: [...run.chunks, chunk] }));
            },
            onPlaybackStart: (at) => {
              if (this.runCtx === ctx) this.patchRun(ctx.id, { playbackStartAt: at });
            },
          }),
        );
        accuracy = ctx.phrase ? assessAccuracy(ctx.phrase, asr.finalText, asr.streamingText) : null;
        this.patchRun(ctx.id, { phase: 'speaking', asr, accuracy, speakCalledAt });
        try {
          tts = await spoken;
        } catch (e) {
          if (!ctx.playbackStopped) this.addRunError(ctx.id, 'tts', `Speech synthesis failed: ${errorMessage(e)}`);
        }
      }
    }
    await this.finishRun(ctx, asr, tts, accuracy);
  }

  /** Privacy accounting, benchmark record, history. Runs for every run that got past Record, failed or not. */
  private async finishRun(
    ctx: RunContext,
    asr: AsrRunMetrics | null,
    tts: TtsRunMetrics | null,
    accuracy: AccuracyResult | null,
  ): Promise<void> {
    let page: number | null = null;
    if (ctx.monitor) {
      try {
        page = ctx.monitor.stop();
      } catch (e) {
        this.addRunError(ctx.id, 'privacy', `Page network monitor failed: ${errorMessage(e)}`);
      }
    }
    const [asrBefore, ttsBefore] = await ctx.baseline;
    const [asrAfter, ttsAfter] = await Promise.allSettled([
      requestCount(() => ctx.asr.networkRequestCount()),
      requestCount(() => ctx.tts.networkRequestCount()),
    ]);
    const network: NetworkCounts = {
      page,
      asrWorker: this.requestDelta(ctx.id, 'ASR worker', asrBefore, asrAfter),
      ttsWorker: this.requestDelta(ctx.id, 'TTS worker', ttsBefore, ttsAfter),
    };

    const s = this.snapshot;
    const { parakeet, kokoro } = s.models;
    const environment = s.environment ?? fallbackEnvironment('environment was not detected before the run');
    const errors = s.run?.id === ctx.id ? s.run.errors : [];
    const record = buildBenchmarkRecord({
      id: ctx.id,
      createdAt: ctx.createdAt,
      label: ctx.label,
      testCase: ctx.testCase,
      mode: ctx.mode,
      origin: location.origin,
      // Storage and connectivity as they were for this run, not when the page loaded.
      environment: { ...environment, storage: s.storage ?? environment.storage, online: ctx.onlineAtStart },
      settings: { ...ctx.settings, asr: asr?.settings ?? ctx.settings.asr, tts: tts?.settings ?? ctx.settings.tts },
      // The load that created the instance (cold/warm/partial), not a later no-op 'session' reload, so the
      // download and initialization numbers stay in every run's record; runsSinceLoad says how long ago it was.
      parakeet: { load: parakeet.instanceRecord ?? parakeet.record, runsSinceLoad: parakeet.runsSinceLoad },
      kokoro: { load: kokoro.instanceRecord ?? kokoro.record, runsSinceLoad: kokoro.runsSinceLoad },
      asr,
      tts,
      accuracy,
      privacy: {
        networkRequestsDuringRun: (network.page ?? 0) + (network.asrWorker ?? 0) + (network.ttsWorker ?? 0),
        onlineAtStart: ctx.onlineAtStart,
        onlineAtEnd: navigator.onLine,
      },
      errors: errors.map((e) => `${e.stage}: ${e.message}`),
    });

    const models: ModelsState = {
      parakeet: afterRun(parakeet, asr !== null, ctx.asr.isLoaded, MODEL_NAMES.parakeet),
      kokoro: afterRun(kokoro, tts !== null, ctx.tts.isLoaded, MODEL_NAMES.kokoro),
    };
    const history = [record, ...s.history].slice(0, HISTORY_LIMIT);
    this.runCtx = null;
    this.set({ models, history, historyError: writeHistory(history) });
    this.patchRun(ctx.id, { phase: asr && tts ? 'done' : 'failed', tts, network, record });
  }

  private requestDelta(
    runId: string,
    who: string,
    before: PromiseSettledResult<number> | undefined,
    after: PromiseSettledResult<number>,
  ): number | null {
    if (before?.status === 'fulfilled' && after.status === 'fulfilled') return Math.max(0, after.value - before.value);
    const reason = before?.status === 'rejected' ? before.reason : after.status === 'rejected' ? after.reason : 'no baseline';
    this.addRunError(runId, 'privacy', `Could not count ${who} requests: ${errorMessage(reason)}`);
    return null;
  }

  /** Abort while starting or recording; produces no benchmark record. */
  readonly cancel = (): void => {
    const ctx = this.runCtx;
    const phase = this.snapshot.run?.phase;
    if (!ctx || (phase !== 'starting' && phase !== 'recording')) return;
    this.runCtx = null;
    this.level.set(0);
    try {
      ctx.monitor?.stop();
    } catch (e) {
      this.addRunError(ctx.id, 'privacy', `Page network monitor failed: ${errorMessage(e)}`);
    }
    attempt(() => ctx.asr.cancelRecording()).catch((e) =>
      this.addRunError(ctx.id, 'microphone', `Cancelling the recording failed: ${errorMessage(e)}`),
    );
    this.patchRun(ctx.id, { phase: 'cancelled' });
  };

  readonly stopPlayback = (): void => {
    const ctx = this.runCtx;
    if (!ctx || this.snapshot.run?.phase !== 'speaking') return;
    ctx.playbackStopped = true;
    this.addRunError(ctx.id, 'tts', 'Playback was stopped by the user before it completed, so this run has no TTS metrics.');
    try {
      ctx.tts.stop();
    } catch (e) {
      this.addRunError(ctx.id, 'tts', `Stopping playback failed: ${errorMessage(e)}`);
    }
  };

  // ----- utilities ---------------------------------------------------------

  readonly refreshStorage = async (): Promise<void> => {
    try {
      this.set({ storage: await getStorageInfo(), storageError: null });
    } catch (e) {
      this.set({ storageError: errorMessage(e) });
    }
  };

  readonly requestPersistence = async (): Promise<void> => {
    try {
      this.set({ persistRequest: { persisted: await requestPersistentStorage(), error: null } });
    } catch (e) {
      this.set({ persistRequest: { persisted: null, error: errorMessage(e) } });
    }
    await this.refreshStorage();
  };

  readonly clearCaches = async (): Promise<void> => {
    if (clearBlocker(this.snapshot) !== null) return;
    this.set({ clearing: true, cacheClear: null });
    const errors: string[] = [];
    // Dispose first so the workers release their Cache API / IndexedDB handles; fresh engines are created on the next load.
    const engines = [
      [MODEL_NAMES.parakeet, this.asrEngine],
      [MODEL_NAMES.kokoro, this.ttsEngine],
    ] as const;
    for (const [name, engine] of engines) {
      try {
        engine?.dispose();
      } catch (e) {
        errors.push(`${name} dispose failed: ${errorMessage(e)}`);
      }
    }
    this.asrEngine = null;
    this.ttsEngine = null;
    for (const listener of this.cacheClearListeners) {
      try {
        listener();
      } catch (e) {
        errors.push(`Model reset failed: ${errorMessage(e)}`);
      }
    }
    this.set({ models: initialModels() });
    let cleared: string[] = [];
    try {
      cleared = await clearModelCaches();
    } catch (e) {
      errors.push(errorMessage(e));
    }
    this.set({ clearing: false, cacheClear: { at: new Date().toISOString(), cleared, errors } });
    await this.refreshStorage();
  };

  readonly clearHistory = (): void => {
    this.set({ history: [], historyError: removeHistory() });
  };
}

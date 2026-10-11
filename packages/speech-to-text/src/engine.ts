/**
 * ASR engine (main-thread facade). OWNER: ASR agent.
 *
 * Microphone / call audio → AudioWorklet capture (capture.ts, one AudioContext) → 16 kHz mono → voice-activity
 * segmentation per source (segmenter.ts) → scheduling (transcriber.ts): each open segment is re-transcribed from
 * its start every partialIntervalMs for live text, and once more when it ends for its final text → one Web Worker
 * running parakeet.js (asr.worker.ts via worker-client.ts, messages in protocol.ts).
 *
 * Two ways to use it, never at the same time:
 *  - startRecording / stopRecording: the benchmark (recording.ts → AsrRunMetrics);
 *  - startSession: continuous multi-source meeting transcription (live-session.ts, contract in session.ts).
 *
 * Settings: partialIntervalMs, minSilenceMs, maxSegmentMs (and finalPass, for recordings) are read when a recording
 * or session starts, from the last load() call (a session may override them). Call load() before each run; with
 * nothing load-relevant changed it returns a 'session' record at once. load() is rejected while a recording or
 * session is running. WASM threads 0 (automatic) means hardwareConcurrency − 2 (resolveWasmThreads in protocol.ts).
 */
import { mainTimeOriginForWorkers, now } from '@local-speech/core';
import { DEFAULT_ASR_SETTINGS, PARAKEET_LIBRARY_VERSIONS, PARAKEET_RUNTIME, PARAKEET_MODEL } from './models.js';
import type { BackendChoice, DownloadMetrics, EnvironmentInfo, LoadProgress, ModelLoadRecord, ModelSource, ResolvedBackend } from '@local-speech/core';
import type { AsrRunMetrics, AsrSettings } from './types.js';
import { stopStreams } from './capture.js';
import { LiveSession, type Segmentation } from './live-session.js';
import { DECODER_QUANT, resolveEncoderQuant } from './model-files.js';
import { describeError, type LoadResult } from './protocol.js';
import { BenchmarkRecording, type AsrRecordingCallbacks } from './recording.js';
import type { SessionCallbacks, SessionOptions, TranscriptionSession } from './session.js';
import type { TranscriberLog } from './transcriber.js';
import { AsrWorkerClient } from './worker-client.js';

export type { AsrRecordingCallbacks } from './recording.js';

export interface AsrLoadOptions {
  backend: BackendChoice;
  source: ModelSource;
  settings: AsrSettings;
  /** From detectEnvironment(); used to resolve 'auto' backend and quantization. */
  environment: EnvironmentInfo;
  onProgress?: (p: LoadProgress) => void;
}

const LOG: TranscriberLog = {
  info: (message) => console.info(`[asr] ${message}`),
  debug: (message) => console.debug(`[asr] ${message}`),
  warn: (message) => console.warn(`[asr] ${message}`),
};

export class AsrEngine {
  private client: AsrWorkerClient | null = null;
  private record: ModelLoadRecord | null = null;
  private loadedKey: string | null = null;
  private settings: AsrSettings = { ...DEFAULT_ASR_SETTINGS };
  private loadQueue: Promise<unknown> = Promise.resolve();
  private recording: BenchmarkRecording | null = null;
  private session: LiveSession | null = null;
  private sessionStarting = false;
  private runNo = 0;

  get isLoaded(): boolean {
    return this.client !== null && this.record !== null;
  }

  /**
   * Record of the load that produced the current model instance (cold / warm / partial). load() calls
   * that reuse the instance return separate 'session' records and do not replace this one.
   */
  get loadRecord(): ModelLoadRecord | null {
    return this.record;
  }

  /**
   * Load (or re-use) the Parakeet model. Same backend + settings + source as the current
   * instance → returns a record with loadKind 'session'. Different config → new worker.
   * backend 'auto' tries WebGPU and falls back to WASM, recording fallbackReason.
   */
  async load(opts: AsrLoadOptions): Promise<ModelLoadRecord> {
    const result = this.loadQueue.then(() => this.loadNow(opts));
    this.loadQueue = result.catch(() => undefined);
    return result;
  }

  /** Opens the microphone and starts a benchmark recording. Call from a user gesture. */
  async startRecording(callbacks: AsrRecordingCallbacks): Promise<void> {
    const micStart = now();
    const client = this.client;
    if (!client || !this.record) throw new Error('Load the transcription model before recording.');
    if (this.recording) throw new Error('A recording is already in progress.');
    if (this.session || this.sessionStarting) throw new Error('Stop the meeting transcription before recording.');

    const recording = new BenchmarkRecording(client, { ...this.settings }, callbacks, micStart, this.nextRunTag(), LOG);
    this.recording = recording;
    try {
      await recording.started;
    } catch (err) {
      recording.cancel();
      if (this.recording === recording) this.recording = null;
      throw err;
    }
  }

  /** Stops the microphone, finalizes the transcript and returns the run's ASR metrics. */
  async stopRecording(): Promise<AsrRunMetrics> {
    const recordingStop = now();
    const recording = this.recording;
    if (!recording) throw new Error('No recording in progress.');
    try {
      return await recording.stop(recordingStop);
    } finally {
      if (this.recording === recording) this.recording = null;
    }
  }

  /** Abort a recording without producing metrics. */
  async cancelRecording(): Promise<void> {
    const recording = this.recording;
    this.recording = null;
    recording?.cancel();
  }

  /**
   * Continuous multi-source transcription for the meeting mode (contract: ./session.ts). Requires a loaded
   * model; only one session or recording at a time. Call from the user's click (microphone permission).
   * The session owns the streams it is given: they are stopped when it ends, or right away if it cannot start.
   */
  async startSession(opts: SessionOptions, callbacks: SessionCallbacks): Promise<TranscriptionSession> {
    const provided = opts.sources.flatMap((source) => (source.stream ? [source.stream] : []));
    let client: AsrWorkerClient;
    try {
      if (!this.client || !this.record) throw new Error('Load the transcription model before starting the meeting transcription.');
      client = this.client;
      if (this.recording) throw new Error('Finish the benchmark recording before starting the meeting transcription.');
      if (this.session || this.sessionStarting) throw new Error('A meeting transcription is already running.');
      checkSources(opts);
      this.sessionStarting = true;
    } catch (err) {
      stopStreams(provided);
      throw err;
    }

    try {
      const segmentation = normalizeSettings({ ...this.settings, ...opts.segmentation });
      const session: LiveSession = await LiveSession.start({
        sources: opts.sources,
        segmentation: pickSegmentation(segmentation),
        runner: client,
        runTag: this.nextRunTag(),
        callbacks,
        log: LOG,
        onClosed: () => {
          if (this.session === session) this.session = null;
        },
      });
      if (this.client !== client) {
        // Disposed, or the worker failed, while the devices were opening.
        session.abort('The transcription model was unloaded while the meeting transcription was starting.');
        throw new Error('The transcription model was unloaded while the meeting transcription was starting.');
      }
      this.session = session;
      return session;
    } finally {
      this.sessionStarting = false;
    }
  }

  /** fetch() calls the ASR worker has made since it started (privacy check). */
  async networkRequestCount(): Promise<number> {
    return this.client ? this.client.requestCount() : 0;
  }

  dispose(): void {
    this.recording?.cancel();
    this.recording = null;
    this.session?.abort('The ASR engine was disposed; transcription stopped.');
    this.session = null;
    this.unload();
  }

  private nextRunTag(): string {
    return `run${++this.runNo}`;
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  private async loadNow(opts: AsrLoadOptions): Promise<ModelLoadRecord> {
    const loadStart = now();
    if (this.recording || this.session || this.sessionStarting) {
      throw new Error(
        this.recording
          ? 'A benchmark recording is running; the transcription model cannot be loaded or reconfigured until it has finished.'
          : 'The meeting transcription is running; stop it before loading or reconfiguring the transcription model.',
      );
    }
    const settings = normalizeSettings(opts.settings);
    const key = JSON.stringify([opts.backend, opts.source.kind, opts.source.baseUrl, settings.encoderQuant, settings.wasmThreads]);
    if (this.client && this.record && this.loadedKey === key) {
      this.settings = settings;
      opts.onProgress?.({ model: 'parakeet', phase: 'ready', message: 'Already initialised in this page session.' });
      return sessionRecord(this.record, loadStart);
    }

    this.unload();
    try {
      const { result, fallbackReason } = await this.loadWithFallback(opts, settings);
      this.record = loadRecord(opts, loadStart, result, fallbackReason);
      this.loadedKey = key;
      this.settings = settings;
      opts.onProgress?.({ model: 'parakeet', phase: 'ready' });
      return this.record;
    } catch (err) {
      this.unload();
      const error = err instanceof Error ? err : new Error(describeError(err));
      opts.onProgress?.({ model: 'parakeet', phase: 'error', message: error.message });
      throw error;
    }
  }

  private async loadWithFallback(
    opts: AsrLoadOptions,
    settings: AsrSettings,
  ): Promise<{ result: LoadResult; fallbackReason: string | null }> {
    if (opts.backend !== 'auto') return { result: await this.attempt(opts.backend, settings, opts), fallbackReason: null };

    const gpu = opts.environment.webgpu;
    if (!gpu.adapterAvailable) {
      const why = gpu.error ?? (gpu.apiPresent ? 'no WebGPU adapter' : 'navigator.gpu is missing');
      return { result: await this.attempt('wasm', settings, opts), fallbackReason: `WebGPU is not available (${why}).` };
    }
    try {
      return { result: await this.attempt('webgpu', settings, opts), fallbackReason: null };
    } catch (err) {
      const reason = describeError(err);
      this.unload();
      opts.onProgress?.({ model: 'parakeet', phase: 'initialize', message: `WebGPU failed, falling back to WASM: ${reason}` });
      return { result: await this.attempt('wasm', settings, opts), fallbackReason: reason };
    }
  }

  /** One worker, one backend. Throws on any failure (including WebGPU silently not starting). */
  private async attempt(backend: ResolvedBackend, settings: AsrSettings, opts: AsrLoadOptions): Promise<LoadResult> {
    const quant = resolveEncoderQuant(backend, settings.encoderQuant, opts.environment);
    const client: AsrWorkerClient = new AsrWorkerClient(
      (progress) => opts.onProgress?.(progress),
      (error) => this.onWorkerFailure(client, error),
    );
    this.client = client;
    return client.loadModel({
      type: 'load',
      timeOrigin: mainTimeOriginForWorkers(),
      source: { ...opts.source },
      pinnedRevisions: { [PARAKEET_MODEL.repo]: PARAKEET_MODEL.revision },
      backend,
      quant,
      threads: settings.wasmThreads,
    });
  }

  private unload(): void {
    this.client?.terminate();
    this.client = null;
    this.record = null;
    this.loadedKey = null;
  }

  private onWorkerFailure(client: AsrWorkerClient, error: Error): void {
    if (client !== this.client) return;
    // The worker may be unusable now: drop it so the next load() starts a fresh one instead of hanging. A running
    // recording or session learns about it from its passes failing (and reports it).
    this.unload();
    console.error('[asr] worker failure', error);
  }
}

// ---------------------------------------------------------------------------
// Settings and records
// ---------------------------------------------------------------------------

function checkSources(opts: SessionOptions): void {
  if (opts.sources.length === 0) throw new Error('Choose at least one audio source.');
  const kinds = new Set(opts.sources.map((source) => source.kind));
  if (kinds.size !== opts.sources.length) throw new Error('Each audio source can only be used once per session.');
  for (const source of opts.sources) {
    if (source.kind === 'system' && !source.stream) throw new Error('Call audio needs the stream returned by requestSystemAudio().');
  }
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function normalizeSettings(settings: AsrSettings): AsrSettings {
  const d = DEFAULT_ASR_SETTINGS;
  return {
    ...settings,
    partialIntervalMs: clamp(settings.partialIntervalMs, 200, 10_000, d.partialIntervalMs),
    minSilenceMs: clamp(settings.minSilenceMs, 200, 5000, d.minSilenceMs),
    // Above the 2 s window searched for a cut point.
    maxSegmentMs: clamp(settings.maxSegmentMs, 4000, 60_000, d.maxSegmentMs),
    finalPass: settings.finalPass === 'full' ? 'full' : 'segments',
    wasmThreads: Number.isFinite(settings.wasmThreads) ? Math.max(0, Math.floor(settings.wasmThreads)) : 0,
  };
}

function pickSegmentation(settings: AsrSettings): Segmentation {
  return { partialIntervalMs: settings.partialIntervalMs, minSilenceMs: settings.minSilenceMs, maxSegmentMs: settings.maxSegmentMs };
}

function loadRecord(opts: AsrLoadOptions, loadStart: number, result: LoadResult, fallbackReason: string | null): ModelLoadRecord {
  return {
    model: 'parakeet',
    displayName: PARAKEET_MODEL.displayName,
    repo: PARAKEET_MODEL.repo,
    revision: PARAKEET_MODEL.revision,
    quantization: { encoder: result.quant, decoder: DECODER_QUANT },
    requestedBackend: opts.backend,
    resolvedBackend: result.backend,
    fallbackReason,
    source: { ...opts.source },
    loadKind: result.loadKind,
    loadStart,
    download: result.download,
    initializationStart: result.initializationStart,
    modelReady: result.modelReady,
    initializationMs: result.modelReady - result.initializationStart,
    totalColdStartMs: result.modelReady - (result.download.downloadStart ?? loadStart),
    warmupMs: result.warmupMs,
    wasm: result.wasm,
    versions: { 'parakeet.js': PARAKEET_LIBRARY_VERSIONS['parakeet.js'], 'onnxruntime-web': PARAKEET_RUNTIME.version },
  };
}

function sessionRecord(instance: ModelLoadRecord, at: number): ModelLoadRecord {
  const download: DownloadMetrics = {
    expectedFiles: [...instance.download.expectedFiles],
    networkFiles: [],
    cachedFiles: [],
    downloadStart: null,
    firstByteAt: null,
    downloadComplete: null,
    timeToFirstByteMs: null,
    totalDownloadMs: null,
    downloadedBytes: 0,
    effectiveMBps: null,
    runtimeFiles: [],
    runtimeBytes: 0,
  };
  return {
    ...instance,
    loadKind: 'session',
    loadStart: at,
    download,
    initializationStart: at,
    modelReady: at,
    initializationMs: 0,
    totalColdStartMs: 0,
    warmupMs: null,
  };
}

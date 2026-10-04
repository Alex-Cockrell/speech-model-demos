/**
 * ASR engine (main-thread facade). OWNER: ASR agent.
 *
 * Microphone → AudioWorklet PCM capture (capture.ts) → 16 kHz mono → energy VAD + level meter →
 * chunkMs batches → Web Worker running parakeet.js (asr.worker.ts, messages in protocol.ts) →
 * StatefulStreamingTranscriber partials → final transcript, from one full-utterance pass after Stop
 * (finalPass 'full') or the concatenated streaming text (finalPass 'streaming').
 *
 * Settings: chunkMs and finalPass are read when a recording starts, from the last load() call. Call
 * load() before each run; with nothing load-relevant changed it returns a 'session' record at once.
 */
import { mainTimeOriginForWorkers, now, span } from '@/lib/clock';
import { DEFAULT_ASR_SETTINGS, LIBRARY_VERSIONS, ORT_ASSETS, PARAKEET_MODEL } from '@/lib/config';
import { intervalStats } from '@/lib/stats';
import type {
  AsrRunMetrics,
  AsrSettings,
  BackendChoice,
  DownloadMetrics,
  EnvironmentInfo,
  LoadProgress,
  MicInfo,
  ModelLoadRecord,
  ModelSource,
  PartialUpdate,
  ResolvedBackend,
} from '@/lib/types';
import { MicCapture } from './capture';
import { DECODER_QUANT, resolveEncoderQuant } from './model-files';
import { PcmQueue, meanSquare, padToMultiple } from './pcm';
import {
  ASR_SAMPLE_RATE,
  ENCODER_FRAME_SAMPLES,
  describeError,
  type LoadRequest,
  type LoadResult,
  type MainToWorker,
  type RunFinal,
  type WorkerToMain,
} from './protocol';
import { EnergyVad } from './vad';

export interface AsrLoadOptions {
  backend: BackendChoice;
  source: ModelSource;
  settings: AsrSettings;
  /** From detectEnvironment(); used to resolve 'auto' backend and quantization. */
  environment: EnvironmentInfo;
  onProgress?: (p: LoadProgress) => void;
}

export interface AsrRecordingCallbacks {
  onPartial?: (update: PartialUpdate) => void;
  onSpeechStart?: (at: number) => void;
  /** Microphone RMS level 0..1, roughly every 50 ms, for a level meter. */
  onLevel?: (rms: number) => void;
}

const LEVEL_INTERVAL_SAMPLES = ASR_SAMPLE_RATE / 20;
const ENCODER_FRAME_MS = (ENCODER_FRAME_SAMPLES / ASR_SAMPLE_RATE) * 1000;

interface ActiveRecording {
  id: number;
  settings: AsrSettings;
  callbacks: AsrRecordingCallbacks;
  capture: MicCapture;
  started: Promise<void>;
  stopping: boolean;
  micStart: number;
  chunkSamples: number;
  queue: PcmQueue;
  vad: EnergyVad;
  levelSum: number;
  levelCount: number;
  capturedSamples: number;
  speechStart: number | null;
  firstAudioSubmitted: number | null;
  chunksSubmitted: number;
  partials: PartialUpdate[];
  visibleText: string;
  firstPartialAt: number | null;
  final: Deferred<RunFinal & { at: number }>;
}

export class AsrEngine {
  private client: AsrWorkerClient | null = null;
  private record: ModelLoadRecord | null = null;
  private loadedKey: string | null = null;
  private settings: AsrSettings = { ...DEFAULT_ASR_SETTINGS };
  private loadQueue: Promise<unknown> = Promise.resolve();
  private recording: ActiveRecording | null = null;
  private nextRunId = 1;

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

  /** Opens the microphone and starts streaming transcription. Call from a user gesture. */
  async startRecording(callbacks: AsrRecordingCallbacks): Promise<void> {
    const micStart = now();
    const client = this.client;
    if (!client || !this.record) throw new Error('Load the Parakeet model before recording.');
    if (this.recording) throw new Error('A recording is already in progress.');

    const settings = { ...this.settings };
    const rec: ActiveRecording = {
      id: this.nextRunId++,
      settings,
      callbacks,
      capture: new MicCapture((samples) => this.onAudio(rec, samples)),
      started: Promise.resolve(),
      stopping: false,
      micStart,
      chunkSamples: (settings.chunkMs / 1000) * ASR_SAMPLE_RATE,
      queue: new PcmQueue(),
      vad: new EnergyVad(ASR_SAMPLE_RATE),
      levelSum: 0,
      levelCount: 0,
      capturedSamples: 0,
      speechStart: null,
      firstAudioSubmitted: null,
      chunksSubmitted: 0,
      partials: [],
      visibleText: '',
      firstPartialAt: null,
      final: deferred<RunFinal & { at: number }>(),
    };
    this.recording = rec;
    client.post({ type: 'start', runId: rec.id });
    rec.started = rec.capture.start();
    try {
      await rec.started;
    } catch (err) {
      this.abandon(rec, err instanceof Error ? err : new Error(describeError(err)));
      throw err;
    }
  }

  /** Stops the microphone, finalizes the transcript and returns the run's ASR metrics. */
  async stopRecording(): Promise<AsrRunMetrics> {
    const recordingStop = now();
    const rec = this.recording;
    if (!rec) throw new Error('No recording in progress.');
    if (rec.stopping) throw new Error('The recording is already stopping.');
    rec.stopping = true;
    try {
      await rec.started;
      const mic = rec.capture.mic;
      if (!mic) throw new Error('The microphone did not start.');
      await rec.capture.stop();

      const remainder = rec.queue.take(rec.queue.length);
      const tail = remainder.length > 0 ? padToMultiple(remainder, ENCODER_FRAME_SAMPLES) : null;
      if (tail) {
        rec.firstAudioSubmitted ??= now();
        if (rec.settings.finalPass === 'streaming') rec.chunksSubmitted++;
      }
      if (this.client) {
        this.client.post({ type: 'finish', runId: rec.id, mode: rec.settings.finalPass, tail }, tail ? [tail.buffer] : []);
      } else {
        // No-op when a worker failure already rejected the run; its reason is the one reported.
        rec.final.reject(new Error('The ASR worker is not running.'));
      }
      const final = await rec.final.promise;
      return runMetrics(rec, mic, final, recordingStop, final.at);
    } finally {
      rec.capture.release();
      if (this.recording === rec) this.recording = null;
    }
  }

  /** Abort a recording without producing metrics. */
  async cancelRecording(): Promise<void> {
    const rec = this.recording;
    if (rec) this.abandon(rec, new Error('The recording was cancelled.'));
  }

  /** fetch() calls the ASR worker has made since it started (privacy check). */
  async networkRequestCount(): Promise<number> {
    return this.client ? this.client.requestCount() : 0;
  }

  dispose(): void {
    if (this.recording) this.abandon(this.recording, new Error('The ASR engine was disposed.'));
    this.unload();
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  private async loadNow(opts: AsrLoadOptions): Promise<ModelLoadRecord> {
    const loadStart = now();
    const settings = normalizeSettings(opts.settings);
    const key = JSON.stringify([opts.backend, opts.source.kind, opts.source.baseUrl, settings.encoderQuant, settings.wasmThreads]);
    if (this.client && this.record && this.loadedKey === key) {
      this.settings = settings;
      opts.onProgress?.({ model: 'parakeet', phase: 'ready', message: 'Already initialised in this page session.' });
      return sessionRecord(this.record, loadStart);
    }
    if (this.recording) throw new Error('Stop the current recording before loading a different ASR configuration.');

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
      (message) => this.onRunMessage(message),
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
    if (this.recording) this.recording.final.reject(new Error('The ASR model was unloaded during the recording.'));
    this.client?.terminate();
    this.client = null;
    this.record = null;
    this.loadedKey = null;
  }

  private onWorkerFailure(client: AsrWorkerClient, error: Error): void {
    if (client !== this.client) return;
    // The worker may be unusable now: drop it so the next load() starts a fresh one instead of hanging.
    this.unload();
    console.error('[asr] worker failure', error);
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  private onAudio(rec: ActiveRecording, samples: Float32Array): void {
    if (this.recording !== rec) return;
    rec.capturedSamples += samples.length;
    rec.queue.push(samples);
    while (rec.queue.length >= rec.chunkSamples) {
      const chunk = rec.queue.take(rec.chunkSamples);
      rec.firstAudioSubmitted ??= now();
      rec.chunksSubmitted++;
      this.client?.post({ type: 'chunk', runId: rec.id, audio: chunk }, [chunk.buffer]);
    }

    const speechSample = rec.vad.push(samples);
    if (speechSample !== null) {
      const at = rec.capture.timeAtSample(speechSample);
      rec.speechStart = at;
      notify(() => rec.callbacks.onSpeechStart?.(at));
    }
    rec.levelSum += meanSquare(samples) * samples.length;
    rec.levelCount += samples.length;
    if (rec.levelCount >= LEVEL_INTERVAL_SAMPLES) {
      const rms = Math.min(1, Math.sqrt(rec.levelSum / rec.levelCount));
      rec.levelSum = 0;
      rec.levelCount = 0;
      notify(() => rec.callbacks.onLevel?.(rms));
    }
  }

  private onRunMessage(message: RunMessage): void {
    const rec = this.recording;
    if (!rec || message.runId !== rec.id) return;
    if (message.type === 'final') {
      rec.final.resolve({ ...message, at: now() });
    } else if (message.type === 'runError') {
      rec.final.reject(new Error(message.message));
    } else if (message.text !== rec.visibleText) {
      const update: PartialUpdate = { at: now(), text: message.text };
      rec.visibleText = message.text;
      rec.partials.push(update);
      if (rec.firstPartialAt === null && message.text.trim() !== '') rec.firstPartialAt = update.at;
      notify(() => rec.callbacks.onPartial?.(update));
    }
  }

  private abandon(rec: ActiveRecording, reason: Error): void {
    rec.capture.release();
    rec.final.reject(reason);
    if (this.recording === rec) this.recording = null;
    this.client?.post({ type: 'cancel', runId: rec.id });
  }
}

// ---------------------------------------------------------------------------
// Worker client
// ---------------------------------------------------------------------------

type RunMessage = Extract<WorkerToMain, { runId: number }>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Rejections reach whoever awaits; this only keeps unobserved ones out of the console.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

class AsrWorkerClient {
  private readonly worker: Worker;
  private load: Deferred<LoadResult> | null = null;
  private readonly counts = new Map<number, Deferred<number>>();
  private nextCountId = 1;
  private terminated = false;

  constructor(
    private readonly onProgress: (progress: LoadProgress) => void,
    private readonly onRunMessage: (message: RunMessage) => void,
    private readonly onFailure: (error: Error) => void,
  ) {
    this.worker = new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module', name: 'parakeet-asr' });
    this.worker.addEventListener('message', (event: MessageEvent<WorkerToMain>) => this.dispatch(event.data));
    this.worker.addEventListener('error', (event: ErrorEvent) => {
      const where = event.filename ? ` (${event.filename}:${event.lineno})` : '';
      this.fail(
        new Error(
          event.message
            ? `ASR worker error: ${event.message}${where}`
            : 'The ASR worker failed to start or crashed (no details; see the browser console).',
        ),
      );
    });
    this.worker.addEventListener('messageerror', () => this.fail(new Error('The ASR worker sent a message that could not be read.')));
  }

  loadModel(request: LoadRequest): Promise<LoadResult> {
    this.load?.reject(new Error('Superseded by a newer load request.'));
    const pending = deferred<LoadResult>();
    this.load = pending;
    this.post(request);
    return pending.promise;
  }

  post(message: MainToWorker, transfer: Transferable[] = []): void {
    if (!this.terminated) this.worker.postMessage(message, transfer);
  }

  requestCount(): Promise<number> {
    if (this.terminated) return Promise.reject(new Error('The ASR worker is not running.'));
    const requestId = this.nextCountId++;
    const pending = deferred<number>();
    this.counts.set(requestId, pending);
    this.post({ type: 'count', requestId });
    return pending.promise;
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.worker.terminate();
    this.rejectPending(new Error('The ASR worker was terminated.'));
  }

  private dispatch(message: WorkerToMain): void {
    switch (message.type) {
      case 'progress':
        this.onProgress(message.progress);
        break;
      case 'loaded':
        this.load?.resolve(message.result);
        this.load = null;
        break;
      case 'loadError':
        this.load?.reject(new Error(message.message));
        this.load = null;
        break;
      case 'count':
        this.counts.get(message.requestId)?.resolve(message.count);
        this.counts.delete(message.requestId);
        break;
      case 'unexpectedError':
        this.fail(new Error(message.message));
        break;
      default:
        this.onRunMessage(message);
    }
  }

  private fail(error: Error): void {
    if (this.terminated) return;
    this.rejectPending(error);
    this.onFailure(error);
  }

  private rejectPending(error: Error): void {
    this.load?.reject(error);
    this.load = null;
    for (const pending of this.counts.values()) pending.reject(error);
    this.counts.clear();
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function normalizeSettings(settings: AsrSettings): AsrSettings {
  // Chunks are whole encoder frames (80 ms) so streaming offsets and timestamps stay exact.
  const requested = Number.isFinite(settings.chunkMs) ? settings.chunkMs : DEFAULT_ASR_SETTINGS.chunkMs;
  const chunkMs = Math.max(1, Math.round(requested / ENCODER_FRAME_MS)) * ENCODER_FRAME_MS;
  const wasmThreads = Number.isFinite(settings.wasmThreads) ? Math.max(0, Math.floor(settings.wasmThreads)) : 0;
  return { ...settings, chunkMs, wasmThreads };
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
    versions: { 'parakeet.js': LIBRARY_VERSIONS['parakeet.js'], 'onnxruntime-web': ORT_ASSETS.parakeet.version },
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

function runMetrics(rec: ActiveRecording, mic: MicInfo, final: RunFinal, recordingStop: number, finalTranscriptAt: number): AsrRunMetrics {
  const computeMs = final.streamingComputeMs + (final.finalPassComputeMs ?? 0);
  return {
    micStart: rec.micStart,
    speechStart: rec.speechStart,
    firstAudioSubmitted: rec.firstAudioSubmitted,
    firstPartialAt: rec.firstPartialAt,
    recordingStop,
    finalTranscriptAt,
    partials: rec.partials,
    voiceToFirstTextMs: span(rec.speechStart, rec.firstPartialAt),
    submitToFirstTextMs: span(rec.firstAudioSubmitted, rec.firstPartialAt),
    updateIntervals: intervalStats(rec.partials.map((update) => update.at)),
    partialUpdateCount: rec.partials.length,
    finalizationMs: finalTranscriptAt - recordingStop,
    audioDurationSec: rec.capturedSamples / ASR_SAMPLE_RATE,
    computeMs,
    rtf: perAudio(computeMs, rec.capturedSamples),
    streamingComputeMs: final.streamingComputeMs,
    // Over the audio the streamer actually processed (chunks dropped for the full pass excluded).
    streamingRtf: perAudio(final.streamingComputeMs, final.streamedSamples),
    finalPassComputeMs: final.finalPassComputeMs,
    finalPassRtf: final.finalPassComputeMs === null ? null : perAudio(final.finalPassComputeMs, final.finalPassSamples),
    chunksSubmitted: rec.chunksSubmitted,
    streamingText: final.streamingText,
    finalText: final.finalText,
    settings: rec.settings,
    mic,
  };
}

/** Compute milliseconds per millisecond of 16 kHz audio. */
function perAudio(computeMs: number, samples: number): number | null {
  return samples > 0 ? computeMs / ((samples / ASR_SAMPLE_RATE) * 1000) : null;
}

/** UI callbacks must not break capture. */
function notify(callback: () => void): void {
  try {
    callback();
  } catch (err) {
    console.error('[asr] recording callback threw', err);
  }
}

/**
 * TTS engine (main-thread facade). OWNER: TTS agent.
 *
 * speak(): text → Web Worker running Kokoro (./kokoro, sentence by sentence) → Float32 audio chunks (24 kHz) →
 * Web Audio scheduled playback with underrun / buffer tracking (the benchmark).
 * synthesize(): one piece of text → one audio buffer, no playback; read aloud (./reader.ts) schedules the
 * pieces itself so it can bound how far generation runs ahead of playback.
 *
 * Worker protocol: ./protocol.ts. Playback scheduling and continuity definitions: ./playback.ts.
 */
import { mainTimeOriginForWorkers, now } from '@localspeech/core';
import { KOKORO_MODEL, KOKORO_LIBRARY_VERSIONS, KOKORO_RUNTIME } from './models.js';
import type { BackendChoice, DownloadMetrics, LoadProgress, ModelLoadRecord, ModelSource, ResolvedBackend, WebGpuInfo } from '@localspeech/core';
import type { KokoroDtype, TtsChunkRecord, TtsRunMetrics, TtsSettings } from './types.js';
import {
  errorMessage,
  type SynthesizedEvent,
  type TtsWorkerEvent,
  type TtsWorkerRequest,
  type WorkerLoadResult,
} from './protocol.js';
import { SpeakRun } from './run.js';

export interface TtsLoadOptions {
  backend: BackendChoice;
  source: ModelSource;
  /** Load-time fields: dtype, wasmThreads, voice (voice file is pre-fetched so offline runs work). */
  settings: TtsSettings;
  /** Only WebGPU availability is used (to resolve 'auto'); detectEnvironment() or detectWebGpuSupport() provide it. */
  environment: TtsEnvironment;
  /** URL of the folder serving ONNX Runtime's ort-wasm-simd-threaded.jsep.{mjs,wasm}; default KOKORO_RUNTIME.wasmPaths. */
  runtimeUrl?: string;
  onProgress?: (p: LoadProgress) => void;
}

export interface TtsEnvironment {
  webgpu: Pick<WebGpuInfo, 'adapterAvailable' | 'error'>;
}

export interface TtsSpeakCallbacks {
  onChunk?: (chunk: TtsChunkRecord) => void;
  onPlaybackStart?: (at: number) => void;
}

/** Per-request synthesis options; voice and speed may differ from the load-time settings. */
export interface SynthesisOptions {
  voice: string;
  speed: number;
}

export interface SynthesisResult {
  /** Mono PCM; empty when the request was skipped. */
  audio: Float32Array;
  sampleRate: number;
  /** now() when the request was posted to the worker. */
  requestedAt: number;
  /** When the worker started the request (after waiting for earlier ones) and finished it; start null if skipped. */
  generationStart: number | null;
  generatedAt: number;
  /** Kokoro inferences used (> 1 when the piece exceeded the token window and was split). */
  inferences: number;
  /** Largest phoneme-token count of those inferences. */
  maxTokens: number;
  overflowSplits: number;
  /** Part of the text could not be split further and was cut off by Kokoro's 512-token window. */
  truncated: boolean;
  /** What was wrong with the first attempt's audio ('invalid' = NaN samples), or null when it was fine. */
  firstProblem: 'empty' | 'invalid' | 'silent' | null;
  /** Re-generations with altered wording because the model returned empty audio. */
  retries: number;
  /** No usable audio even after retries; `audio` is empty. */
  failed: boolean;
  /** Cancelled before the worker started it. */
  skipped: boolean;
}

/** A synthesize() request in flight. */
export interface SynthesisJob {
  readonly id: number;
  /** Rejects when the worker fails, crashes or is replaced (load, dispose). */
  readonly result: Promise<SynthesisResult>;
  /** Skips the request if the worker has not started it; an inference already running completes. */
  cancel(): void;
}

/** A busy worker answers between inferences; anything slower than this means it is stuck. */
const REQUEST_COUNT_TIMEOUT_MS = 10_000;
/** How long speak() waits for a suspended AudioContext to resume before reporting blocked audio. */
const RESUME_TIMEOUT_MS = 1_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface LoadedInstance {
  key: string;
  record: ModelLoadRecord;
  settings: TtsSettings;
}

interface Attempt {
  device: ResolvedBackend;
  dtype: KokoroDtype;
  result: WorkerLoadResult;
}

export class TtsEngine {
  private worker: Worker | null = null;
  private ctx: AudioContext | null = null;
  private instance: LoadedInstance | null = null;
  private inflight: { key: string; promise: Promise<ModelLoadRecord> } | null = null;
  /** Bumped by every fresh load and by dispose(), so a superseded load neither falls back nor commits. */
  private loadToken = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private run: SpeakRun | null = null;
  private progressSink: ((p: LoadProgress) => void) | null = null;

  get isLoaded(): boolean {
    return this.instance !== null && this.worker !== null;
  }

  /**
   * Record of the load that produced the current model instance (cold / warm / partial). load() calls that
   * reuse the instance return separate 'session' records and do not replace this one.
   */
  get loadRecord(): ModelLoadRecord | null {
    return this.instance?.record ?? null;
  }

  /** Same semantics as AsrEngine.load (session reuse, auto fallback). */
  async load(opts: TtsLoadOptions): Promise<ModelLoadRecord> {
    const loadStart = now();
    const key = loadKey(opts);
    const instance = this.instance;
    if (this.worker && instance?.key === key) {
      safeCall(() => opts.onProgress?.({ model: 'kokoro', phase: 'ready', message: 'Already loaded in this session' }));
      return sessionRecord(instance.record, loadStart);
    }
    if (this.inflight?.key === key) return this.inflight.promise;
    const promise = this.loadFresh(opts, key, loadStart);
    this.inflight = { key, promise };
    try {
      return await promise;
    } finally {
      if (this.inflight?.promise === promise) this.inflight = null;
    }
  }

  /**
   * Create/resume the playback AudioContext. Must be called synchronously inside a user-gesture
   * handler (e.g. the Record button click) so later playback is not blocked by autoplay policy.
   */
  unlockAudio(): void {
    if (typeof AudioContext === 'undefined') return;
    if (!this.ctx || this.ctx.state === 'closed') this.ctx = new AudioContext({ latencyHint: 'interactive' });
    const ctx = this.ctx;
    if (ctx.state !== 'running') ctx.resume().catch(() => undefined);
    // Safari (iOS in particular) only unlocks output once a source has been started inside the gesture.
    const blip = ctx.createBufferSource();
    blip.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    blip.connect(ctx.destination);
    blip.start();
  }

  /** Synthesise sentence by sentence and play chunks as they arrive. Resolves after playback completes. */
  async speak(text: string, settings: TtsSettings, callbacks: TtsSpeakCallbacks = {}): Promise<TtsRunMetrics> {
    if (!text.trim()) throw new Error('Nothing to speak: the text is empty.');
    if (!this.isLoaded) throw new Error('The voice model is not loaded; load it first.');
    this.stop();
    const ctx = await this.runningContext();
    const instance = this.instance;
    if (!this.worker || !instance) throw new Error('The voice model was unloaded while audio output was being prepared.');
    this.stop(); // a concurrent speak() may have started while we awaited the AudioContext

    const id = this.nextId++;
    const run = new SpeakRun({
      id,
      ctx,
      text,
      // dtype and wasmThreads only take effect at load time: record the ones the model was loaded with.
      settings: { ...settings, dtype: instance.settings.dtype, wasmThreads: instance.settings.wasmThreads },
      callbacks,
    });
    this.run = run;
    run.begin();
    this.post({ type: 'speak', id, text, voice: settings.voice, speed: settings.speed, split: settings.split });
    try {
      return await run.result;
    } finally {
      if (this.run === run) this.run = null;
    }
  }

  /**
   * Generate one piece of text as one utterance, without playing it. Requests run one at a time in the worker,
   * in order (after a speak() in progress). Read aloud uses this to generate on demand, a bounded distance ahead
   * of its own playback. The voice need not be the load-time one: the worker fetches a voice it does not have on
   * first use (which needs the network).
   */
  synthesize(text: string, options: SynthesisOptions): SynthesisJob {
    const id = this.nextId++;
    const requestedAt = now();
    const result = this.isLoaded
      ? this.request<SynthesizedEvent>({ type: 'synthesize', id, text, voice: options.voice, speed: options.speed }).then(
          (event): SynthesisResult => ({
            audio: event.audio,
            sampleRate: event.sampleRate,
            requestedAt,
            generationStart: event.generationStart,
            generatedAt: event.generatedAt,
            inferences: event.inferences,
            maxTokens: event.maxTokens,
            overflowSplits: event.overflowSplits,
            truncated: event.truncated,
            firstProblem: event.firstProblem,
            retries: event.retries,
            failed: event.failed,
            skipped: event.skipped,
          }),
        )
      : Promise.reject(new Error('The voice model is not loaded; load it first.'));
    return { id, result, cancel: () => this.post({ type: 'cancel', id }) };
  }

  /**
   * The playback AudioContext, created if needed and resumed. Call unlockAudio() inside the user gesture first;
   * rejects if the browser keeps audio output blocked.
   */
  outputContext(): Promise<AudioContext> {
    return this.runningContext();
  }

  /** Stop generation and playback immediately. The pending speak() rejects with an AbortError. */
  stop(): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    this.post({ type: 'cancel', id: run.id });
    run.fail(new DOMException('TTS playback was stopped.', 'AbortError'));
  }

  /** fetch() calls the TTS worker has made since it started (privacy check). */
  async networkRequestCount(): Promise<number> {
    if (!this.worker) return 0;
    return this.request<number>({ type: 'requestCount', id: this.nextId++ }, REQUEST_COUNT_TIMEOUT_MS);
  }

  /** Stops playback and terminates the worker. The engine stays usable: load() and unlockAudio() start over. */
  dispose(): void {
    this.loadToken++;
    this.inflight = null;
    this.progressSink = null;
    this.run?.fail(new DOMException('The TTS engine was disposed.', 'AbortError'));
    this.run = null;
    this.teardownWorker('The TTS engine was disposed.');
    this.instance = null;
    // unlockAudio() creates a fresh context, so it never touches the one being closed here.
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  private async loadFresh(opts: TtsLoadOptions, key: string, loadStart: number): Promise<ModelLoadRecord> {
    const token = ++this.loadToken;
    this.run?.fail(new Error('TTS run interrupted: the voice model is being reloaded.'));
    this.run = null;
    this.teardownWorker('Superseded by a newer TtsEngine.load() call.');
    this.instance = null;
    const emit = (p: Omit<LoadProgress, 'model'>) => safeCall(() => opts.onProgress?.({ model: 'kokoro', ...p }));
    this.progressSink = (p) => safeCall(() => opts.onProgress?.(p));

    try {
      let fallbackReason: string | null = null;
      let attempt: Attempt;
      if (opts.backend !== 'auto') {
        // Forced backends fail loudly: no fallback.
        attempt = await this.attempt(opts.backend, opts, token);
      } else if (!opts.environment.webgpu.adapterAvailable) {
        fallbackReason = `WebGPU unavailable: ${opts.environment.webgpu.error ?? 'no WebGPU adapter'}`;
        attempt = await this.attempt('wasm', opts, token);
      } else {
        try {
          attempt = await this.attempt('webgpu', opts, token);
        } catch (e) {
          if (token !== this.loadToken) throw e;
          fallbackReason = errorMessage(e);
          emit({ phase: 'download', message: `WebGPU failed, falling back to WASM: ${fallbackReason}` });
          attempt = await this.attempt('wasm', opts, token);
        }
      }
      const record = buildLoadRecord(opts, loadStart, attempt, fallbackReason);
      this.instance = { key, record, settings: { ...opts.settings } };
      return record;
    } catch (e) {
      const error = e instanceof Error ? e : new Error(errorMessage(e));
      if (token === this.loadToken) {
        this.teardownWorker(`Loading the voice model failed: ${error.message}`);
        emit({ phase: 'error', message: error.message });
      }
      throw error;
    } finally {
      if (token === this.loadToken) this.progressSink = null;
    }
  }

  /** One load on one backend, in a fresh worker (a failed WebGPU init can leave ORT unusable in its worker). */
  private async attempt(device: ResolvedBackend, opts: TtsLoadOptions, token: number): Promise<Attempt> {
    this.teardownWorker(`Replaced by a new ${device} load attempt.`);
    this.spawnWorker();
    const dtype = resolveDtype(opts.settings.dtype, device);
    let result: WorkerLoadResult;
    try {
      result = await this.request<WorkerLoadResult>({
        type: 'load',
        id: this.nextId++,
        timeOrigin: mainTimeOriginForWorkers(),
        source: { ...opts.source },
        pinnedRevisions: { [KOKORO_MODEL.repo]: KOKORO_MODEL.revision },
        device,
        dtype,
        wasmThreads: opts.settings.wasmThreads,
        voice: opts.settings.voice,
        // Resolved here: relative URLs in the worker would resolve against the worker script, not the page.
        runtimeUrl: new URL(opts.runtimeUrl ?? KOKORO_RUNTIME.wasmPaths, globalThis.location?.href).href,
      });
    } catch (e) {
      if (token !== this.loadToken) throw e;
      throw new Error(`The voice model failed to load on ${device} (${dtype}): ${errorMessage(e)}`);
    }
    if (token !== this.loadToken) throw new DOMException('Superseded by a newer TtsEngine.load() call.', 'AbortError');
    return { device, dtype, result };
  }

  // -------------------------------------------------------------------------
  // Worker plumbing
  // -------------------------------------------------------------------------

  private spawnWorker(): void {
    const worker = new Worker(new URL('./tts.worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<TtsWorkerEvent>) => {
      if (worker === this.worker) this.onWorkerEvent(event.data);
    });
    // Fires when the worker script fails to load or evaluate (failures inside it arrive as 'error' messages).
    worker.addEventListener('error', (event: ErrorEvent) => {
      if (worker !== this.worker) return;
      this.instance = null;
      this.teardownWorker(`The speech synthesis worker crashed: ${describeWorkerError(event)}`);
    });
    worker.addEventListener('messageerror', () => {
      if (worker === this.worker) this.failAll(new Error('A message from the speech synthesis worker could not be decoded.'));
    });
    this.worker = worker;
  }

  private onWorkerEvent(msg: TtsWorkerEvent): void {
    switch (msg.type) {
      case 'progress':
        this.progressSink?.(msg.progress);
        return;
      case 'loaded':
        this.settlePending(msg.id, { value: msg.result });
        return;
      case 'requestCount':
        this.settlePending(msg.id, { value: msg.count });
        return;
      case 'chunk':
        if (this.run?.id === msg.id) this.run.onChunk(msg);
        return;
      case 'done':
        if (this.run?.id === msg.id) this.run.onDone(msg);
        return;
      case 'synthesized':
        this.settlePending(msg.id, { value: msg });
        return;
      case 'error': {
        const error = new Error(msg.message);
        if (msg.id === null) this.failAll(error);
        else if (this.run?.id === msg.id) this.run.fail(error);
        else this.settlePending(msg.id, { error });
        return;
      }
    }
  }

  private post(msg: TtsWorkerRequest): void {
    this.worker?.postMessage(msg);
  }

  private request<T>(msg: TtsWorkerRequest, timeoutMs?: number): Promise<T> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('The speech synthesis worker is not running.'));
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? null
          : setTimeout(
              () => this.settlePending(msg.id, { error: new Error(`The TTS worker did not answer "${msg.type}" within ${timeoutMs} ms.`) }),
              timeoutMs,
            );
      this.pending.set(msg.id, { resolve: (value) => resolve(value as T), reject, timer });
      worker.postMessage(msg);
    });
  }

  private settlePending(id: number, outcome: { value: unknown } | { error: Error }): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer !== null) clearTimeout(pending.timer);
    if ('error' in outcome) pending.reject(outcome.error);
    else pending.resolve(outcome.value);
  }

  /** Rejects every pending request and the active run, so nothing waits on a worker that failed. */
  private failAll(error: Error): void {
    this.run?.fail(error);
    for (const id of [...this.pending.keys()]) this.settlePending(id, { error });
  }

  private teardownWorker(reason: string): void {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    worker.terminate();
    this.failAll(new Error(reason));
  }

  private async runningContext(): Promise<AudioContext> {
    if (typeof AudioContext === 'undefined') throw new Error('Web Audio (AudioContext) is not available in this browser.');
    if (!this.ctx || this.ctx.state === 'closed') this.ctx = new AudioContext({ latencyHint: 'interactive' });
    const ctx = this.ctx;
    if (!isRunning(ctx)) {
      // resume() stays pending (rather than rejecting) while autoplay policy blocks it.
      await Promise.race([ctx.resume().catch(() => undefined), delay(RESUME_TIMEOUT_MS)]);
    }
    if (!isRunning(ctx)) {
      throw new Error(
        `Audio output is blocked (AudioContext is "${ctx.state}"). Call unlockAudio() inside a user gesture, e.g. the Record click, before speak().`,
      );
    }
    return ctx;
  }
}

/**
 * 'auto' → fp16 on WASM, fp32 on WebGPU (kokoro-js recommends it). Measured in Edge on WASM: q8 generates at
 * ~1.0× real time (its int8 path is the bottleneck), fp16 at ~0.45× with half fp32's download.
 */
function resolveDtype(dtype: TtsSettings['dtype'], device: ResolvedBackend): KokoroDtype {
  if (dtype !== 'auto') return dtype;
  return device === 'webgpu' ? 'fp32' : 'fp16';
}

/** Everything that makes a loaded instance reusable; any difference means a new worker and a fresh load. */
function loadKey({ backend, source, settings, runtimeUrl }: TtsLoadOptions): string {
  return JSON.stringify([backend, source.kind, source.baseUrl, settings.dtype, settings.wasmThreads, settings.voice, runtimeUrl ?? null]);
}

function buildLoadRecord(
  opts: TtsLoadOptions,
  loadStart: number,
  { device, dtype, result }: Attempt,
  fallbackReason: string | null,
): ModelLoadRecord {
  return {
    model: 'kokoro',
    displayName: KOKORO_MODEL.displayName,
    repo: KOKORO_MODEL.repo,
    revision: KOKORO_MODEL.revision,
    quantization: { model: dtype },
    requestedBackend: opts.backend,
    resolvedBackend: device,
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
    versions: {
      phonemizer: KOKORO_LIBRARY_VERSIONS.phonemizer,
      'onnxruntime-web': KOKORO_RUNTIME.version,
    },
  };
}

function sessionRecord(instance: ModelLoadRecord, at: number): ModelLoadRecord {
  return {
    ...instance,
    loadKind: 'session',
    loadStart: at,
    download: emptyDownload(instance.download.expectedFiles),
    initializationStart: at,
    modelReady: at,
    initializationMs: 0,
    totalColdStartMs: 0,
    warmupMs: null,
  };
}

function emptyDownload(expectedFiles: string[]): DownloadMetrics {
  return {
    expectedFiles: [...expectedFiles],
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
}

function describeWorkerError(event: ErrorEvent): string {
  if (!event.message) return 'the worker script failed to load or start (details in the browser console)';
  return event.filename ? `${event.message} (${event.filename}:${event.lineno})` : event.message;
}

function isRunning(ctx: AudioContext): boolean {
  return ctx.state === 'running';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeCall(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    console.error('TTS progress callback threw', error);
  }
}

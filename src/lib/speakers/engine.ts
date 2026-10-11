/**
 * Speaker identification for the meeting mode. OWNER: speakers agent.
 *
 * A small speaker-embedding model runs in its own Web Worker. Each finalized transcript segment is embedded
 * and assigned to a speaker by online clustering; recluster() revisits every segment with an offline
 * algorithm once more audio is available. Clusters never mix sources: microphone and call audio sound
 * different enough that the same person would not match across them anyway, and keeping them apart makes
 * "mic-1" vs "system-2" meaningful.
 *
 * Model: 3D-Speaker CAM++ (29.6 MB, SPEAKER_MODEL in @/lib/config; choice and input pipeline in ./model.ts),
 * on onnxruntime-web 1.24.1 with the runtime files the ASR already uses. Worker: ./speaker.worker.ts
 * (protocol ./protocol.ts). Clustering, thresholds and id rules: ./clustering.ts.
 *
 * Backend: always WASM, one thread by default. The model is small (RTF ≈ 0.04 on one desktop core in Edge,
 * roughly 0.05–0.1 expected on a laptop core) while the ASR runs on the GPU or on most CPU cores at the same time; one
 * thread keeps the speaker model from competing with it and needs no cross-origin isolation. WebGPU is not an
 * option: onnxruntime-web 1.24.1's WebGPU backend rejects CAM++'s ceil-mode AveragePool ("using ceil() in shape
 * computation is not yet supported"), and it would compete with the Parakeet encoder for the GPU anyway. So
 * 'auto' resolves to WASM, and 'webgpu' (the app-wide "Force WebGPU" setting, meant for the benchmark models)
 * also runs on WASM, with the reason in the load record's fallbackReason, rather than failing the meeting.
 */
import { mainTimeOriginForWorkers, now } from '@localspeech/core';
import { ORT_ASSETS, SPEAKER_MODEL } from '../config';
import type {
  AudioSourceKind,
  BackendChoice,
  DownloadMetrics,
  EnvironmentInfo,
  LoadProgress,
  ModelLoadRecord,
  ModelSource,
} from '../types';
import { DEFAULT_CLUSTERING, SpeakerClusterer, type ClusteringOptions } from './clustering';
import { SPEAKER_PREPARE } from './model';
import {
  errorMessage,
  type EmbedResult,
  type SpeakerWorkerEvent,
  type SpeakerWorkerRequest,
  type WorkerLoadResult,
} from './protocol';

export interface SpeakerLoadOptions {
  backend: BackendChoice;
  source: ModelSource;
  environment: EnvironmentInfo;
  /** Progress events use model: 'speaker'. */
  onProgress?: (p: LoadProgress) => void;
  /** ORT WASM threads. Default 1 (see above); more need a cross-origin isolated page. */
  wasmThreads?: number;
}

export interface SpeakerSegmentInput {
  segmentId: string;
  source: AudioSourceKind;
  /** 16 kHz mono PCM; ownership passes to the engine (it is transferred to the worker). */
  audio: Float32Array;
  startMs: number;
  endMs: number;
}

export interface SpeakerAssignment {
  segmentId: string;
  /**
   * e.g. 'mic-1', 'system-2'. null when the segment is too short to identify reliably: under 1 s of speech, or
   * (online only) it matches no known speaker and has under 3 s of speech, too little to start a new one;
   * recluster() places those.
   */
  speakerId: string | null;
  /**
   * 0..1 cosine similarity between the segment and its speaker: the centroid of the speaker's other segments
   * (for assign(), as the speaker stood when the segment arrived). 1 for a speaker's only segment. null when
   * speakerId is null.
   */
  confidence: number | null;
}

export interface SpeakerSession {
  /** Embed a finalized segment and assign it a speaker. Calls are processed in order. */
  assign(segment: SpeakerSegmentInput): Promise<SpeakerAssignment>;
  /**
   * Re-cluster every segment seen so far (offline clustering per source), optionally with a known speaker
   * count per source. Speaker ids are kept stable where clusters still match. Returns all assignments.
   * A count also caps later online assignments for that source; a call without one returns the source to
   * threshold mode. Cheap (milliseconds for a few hundred segments): calling it on Stop gives the saved
   * transcript the best labels.
   */
  recluster(opts?: { speakersPerSource?: Partial<Record<AudioSourceKind, number>> }): Promise<SpeakerAssignment[]>;
  /** Embedding compute time so far. */
  readonly computeMs: number;
  dispose(): void;
}

export interface SpeakerSessionOptions {
  /**
   * Cosine similarity a segment with 6 s or more of speech needs to its speaker's centroid to join it (default
   * 0.5; lower merges more readily, higher splits more readily). The thresholds tied to it — shorter segments,
   * merging speakers, recluster() — move by the same amount.
   */
  threshold?: number;
  /** Full control over the clustering (applied after `threshold`). */
  clustering?: Partial<ClusteringOptions>;
}

/** A worker that has requests outstanding and has not answered anything for this long is considered stuck. */
const STALL_TIMEOUT_MS = 90_000;
/** A busy worker answers between inferences; anything slower than this means it is stuck. */
const REQUEST_COUNT_TIMEOUT_MS = 10_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  postedAt: number;
}

export class SpeakerEngine {
  private worker: Worker | null = null;
  private instance: { key: string; record: ModelLoadRecord } | null = null;
  private inflight: { key: string; promise: Promise<ModelLoadRecord> } | null = null;
  /** Bumped by every fresh load and by dispose(), so a superseded load does not commit. */
  private loadToken = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private progressSink: ((p: LoadProgress) => void) | null = null;
  private lastAnswerAt = 0;
  private stallTimer: ReturnType<typeof setInterval> | null = null;

  get isLoaded(): boolean {
    return this.instance !== null && this.worker !== null;
  }

  /**
   * Record of the load that produced the current model instance (cold / warm). load() calls that reuse the
   * instance return separate 'session' records and do not replace this one.
   */
  get loadRecord(): ModelLoadRecord | null {
    return this.instance?.record ?? null;
  }

  /**
   * Same semantics as AsrEngine.load (session reuse for the same configuration), except that every backend
   * choice runs on WASM (see above).
   */
  async load(opts: SpeakerLoadOptions): Promise<ModelLoadRecord> {
    const loadStart = now();
    const key = loadKey(opts);
    const instance = this.instance;
    if (this.worker && instance?.key === key) {
      safeCall(() => opts.onProgress?.({ model: 'speaker', phase: 'ready', message: 'Already loaded in this session' }));
      return sessionRecord({ ...instance.record, ...backendFields(opts) }, loadStart);
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

  /** One clustering session per meeting. */
  createSession(opts: SpeakerSessionOptions = {}): SpeakerSession {
    return new ClusteringSession((audio, minSpeechMs) => this.embed(audio, minSpeechMs), clusteringOptions(opts));
  }

  /** fetch() calls the speaker worker has made since it started (privacy check). */
  async networkRequestCount(): Promise<number> {
    if (!this.worker) return 0;
    return this.request<number>({ type: 'requestCount', id: this.nextId++ }, REQUEST_COUNT_TIMEOUT_MS);
  }

  /** Terminates the worker and rejects everything pending. The engine stays usable: load() starts over. */
  dispose(): void {
    this.loadToken++;
    this.inflight = null;
    this.progressSink = null;
    this.teardownWorker('The speaker engine was disposed.');
    this.instance = null;
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  private async loadFresh(opts: SpeakerLoadOptions, key: string, loadStart: number): Promise<ModelLoadRecord> {
    const token = ++this.loadToken;
    this.teardownWorker('Superseded by a newer SpeakerEngine.load() call.');
    this.instance = null;
    const emit = (p: Omit<LoadProgress, 'model'>) => safeCall(() => opts.onProgress?.({ model: 'speaker', ...p }));
    this.progressSink = (p) => safeCall(() => opts.onProgress?.(p));
    const wasmThreads = threadsOf(opts);
    try {
      if (opts.environment.wasm && !opts.environment.wasm.available) {
        throw new Error(
          'WebAssembly is not available in this browser (for example Edge enhanced security mode, or a policy that blocks the JavaScript JIT), so the speaker model cannot run.',
        );
      }
      this.spawnWorker();
      let result: WorkerLoadResult;
      try {
        result = await this.request<WorkerLoadResult>({
          type: 'load',
          id: this.nextId++,
          timeOrigin: mainTimeOriginForWorkers(),
          source: { ...opts.source },
          pinnedRevisions: { [SPEAKER_MODEL.repo]: SPEAKER_MODEL.revision },
          wasmThreads,
        });
      } catch (e) {
        if (token !== this.loadToken) throw e;
        throw new Error(`The speaker model failed to load: ${errorMessage(e)}`);
      }
      if (token !== this.loadToken) throw new DOMException('Superseded by a newer SpeakerEngine.load() call.', 'AbortError');
      const record = buildLoadRecord(opts, loadStart, result);
      this.instance = { key, record };
      return record;
    } catch (e) {
      const error = e instanceof Error ? e : new Error(errorMessage(e));
      if (token === this.loadToken) {
        this.teardownWorker(`Speaker model load failed: ${error.message}`);
        emit({ phase: 'error', message: error.message });
      }
      throw error;
    } finally {
      if (token === this.loadToken) this.progressSink = null;
    }
  }

  // -------------------------------------------------------------------------
  // Embedding
  // -------------------------------------------------------------------------

  private embed(audio: Float32Array, minSpeechMs: number): Promise<EmbedResult> {
    if (!this.isLoaded) return Promise.reject(new Error('The speaker model is not loaded.'));
    const samples = ownedSamples(audio);
    return this.request<EmbedResult>({ type: 'embed', id: this.nextId++, audio: samples, minSpeechMs }, undefined, [samples.buffer]);
  }

  // -------------------------------------------------------------------------
  // Worker plumbing
  // -------------------------------------------------------------------------

  private spawnWorker(): void {
    const worker = new Worker(new URL('./speaker.worker.ts', import.meta.url), { type: 'module', name: 'speaker-embeddings' });
    worker.addEventListener('message', (event: MessageEvent<SpeakerWorkerEvent>) => {
      if (worker === this.worker) this.onWorkerEvent(event.data);
    });
    // Fires when the worker script fails to load or evaluate (failures inside it arrive as 'error' messages).
    worker.addEventListener('error', (event: ErrorEvent) => {
      if (worker !== this.worker) return;
      this.instance = null;
      this.teardownWorker(`The speaker worker crashed: ${describeWorkerError(event)}`);
    });
    worker.addEventListener('messageerror', () => {
      if (worker === this.worker) this.failAll(new Error('A message from the speaker worker could not be decoded.'));
    });
    this.worker = worker;
    this.lastAnswerAt = now();
  }

  private onWorkerEvent(msg: SpeakerWorkerEvent): void {
    this.lastAnswerAt = now();
    switch (msg.type) {
      case 'progress':
        this.progressSink?.(msg.progress);
        return;
      case 'loaded':
        this.settlePending(msg.id, { value: msg.result });
        return;
      case 'embedded':
      case 'requestCount':
        this.settlePending(msg.id, { value: msg.type === 'embedded' ? msg.result : msg.count });
        return;
      case 'error': {
        const error = new Error(msg.message);
        if (msg.id !== null) {
          this.settlePending(msg.id, { error });
        } else {
          // An uncaught failure can leave ONNX Runtime unusable: drop the worker so nothing waits on it.
          this.instance = null;
          this.teardownWorker(msg.message);
        }
        return;
      }
    }
  }

  private request<T>(msg: SpeakerWorkerRequest, timeoutMs?: number, transfer: Transferable[] = []): Promise<T> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('The speaker worker is not running.'));
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? null
          : setTimeout(
              () => this.settlePending(msg.id, { error: new Error(`The speaker worker did not answer "${msg.type}" within ${timeoutMs} ms.`) }),
              timeoutMs,
            );
      this.pending.set(msg.id, { resolve: (value) => resolve(value as T), reject, timer, postedAt: now() });
      try {
        worker.postMessage(msg, transfer);
      } catch (e) {
        // e.g. DataCloneError for audio whose buffer was already transferred.
        this.settlePending(msg.id, { error: new Error(`Could not send "${msg.type}" to the speaker worker: ${errorMessage(e)}`) });
        return;
      }
      this.watchForStall();
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

  /** Rejects every pending request, so nothing waits on a worker that failed. */
  private failAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.settlePending(id, { error });
  }

  private teardownWorker(reason: string): void {
    const worker = this.worker;
    if (this.stallTimer !== null) clearInterval(this.stallTimer);
    this.stallTimer = null;
    if (!worker) return;
    this.worker = null;
    worker.terminate();
    this.failAll(new Error(reason));
  }

  /**
   * A worker that has been sent requests but has answered nothing for STALL_TIMEOUT_MS (a hung GPU device, a
   * deadlocked runtime) is torn down, which rejects its requests. Downloads count as answers (progress).
   */
  private watchForStall(): void {
    if (this.stallTimer !== null) return;
    this.stallTimer = setInterval(() => {
      if (this.pending.size === 0) {
        if (this.stallTimer !== null) clearInterval(this.stallTimer);
        this.stallTimer = null;
        return;
      }
      const oldest = Math.min(...[...this.pending.values()].map((p) => p.postedAt));
      if (now() - Math.max(this.lastAnswerAt, oldest) > STALL_TIMEOUT_MS) {
        this.instance = null;
        this.teardownWorker(`The speaker worker stopped responding (no answer for ${STALL_TIMEOUT_MS / 1000} s).`);
      }
    }, 5_000);
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

type Embed = (audio: Float32Array, minSpeechMs: number) => Promise<EmbedResult>;

class ClusteringSession implements SpeakerSession {
  private readonly clusterer: SpeakerClusterer;
  /** assign() and recluster() steps run in call order. */
  private order: Promise<unknown> = Promise.resolve();
  private compute = 0;
  private disposed = false;
  private readonly waiting = new Set<(error: Error) => void>();

  constructor(
    private readonly embed: Embed,
    options: ClusteringOptions,
  ) {
    this.clusterer = new SpeakerClusterer(options);
  }

  get computeMs(): number {
    return this.compute;
  }

  assign(segment: SpeakerSegmentInput): Promise<SpeakerAssignment> {
    if (this.disposed) return Promise.reject(disposedError());
    const { segmentId, source } = segment;
    // Sent now: the worker queues it behind earlier segments, so embedding overlaps waiting for the order.
    const embedded = this.embed(segment.audio, this.clusterer.options.minSpeechMs);
    embedded.catch(() => undefined); // observed below
    return this.enqueue(async () => {
      const result = await embedded;
      if (this.disposed) throw disposedError();
      this.compute += result.computeMs;
      const assignment = this.clusterer.add({ segmentId, source, embedding: result.embedding, speechMs: result.speechMs });
      return { ...assignment };
    });
  }

  recluster(opts: { speakersPerSource?: Partial<Record<AudioSourceKind, number>> } = {}): Promise<SpeakerAssignment[]> {
    if (this.disposed) return Promise.reject(disposedError());
    return this.enqueue(async () => {
      if (this.disposed) throw disposedError();
      return this.clusterer.recluster(opts.speakersPerSource ?? {}).map((a) => ({ ...a }));
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const reject of this.waiting) reject(disposedError());
    this.waiting.clear();
  }

  /** Runs `step` after every earlier step; the returned promise also rejects as soon as the session is disposed. */
  private enqueue<T>(step: () => Promise<T>): Promise<T> {
    const result = this.order.then(step);
    this.order = result.catch(() => undefined);
    return new Promise<T>((resolve, reject) => {
      this.waiting.add(reject);
      result.then(resolve, reject).finally(() => this.waiting.delete(reject));
    });
  }
}

function disposedError(): Error {
  return new Error('The speaker session was disposed.');
}

/** Defaults, shifted by `threshold`, then explicit overrides. */
function clusteringOptions(opts: SpeakerSessionOptions): ClusteringOptions {
  const options = { ...DEFAULT_CLUSTERING, minSpeechMs: SPEAKER_PREPARE.minSpeechMs };
  if (opts.threshold !== undefined && Number.isFinite(opts.threshold)) {
    const shift = opts.threshold - DEFAULT_CLUSTERING.threshold;
    options.threshold = opts.threshold;
    options.shortThreshold = DEFAULT_CLUSTERING.shortThreshold + shift;
    options.reclusterThreshold = DEFAULT_CLUSTERING.reclusterThreshold + shift;
    options.mergeThreshold = Math.min(0.95, DEFAULT_CLUSTERING.mergeThreshold + shift);
  }
  return { ...options, ...opts.clustering };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function threadsOf(opts: SpeakerLoadOptions): number {
  const threads = opts.wasmThreads;
  return threads !== undefined && Number.isFinite(threads) && threads >= 1 ? Math.floor(threads) : 1;
}

/**
 * Everything that makes a loaded instance reusable; any difference means a new worker and a fresh load. The
 * backend choice is not part of it: every choice runs on WASM, so switching it reuses the instance.
 */
function loadKey(opts: SpeakerLoadOptions): string {
  return JSON.stringify([opts.source.kind, opts.source.baseUrl, threadsOf(opts)]);
}

const WEBGPU_UNSUPPORTED =
  "WebGPU was requested, but the speaker model runs on WASM: the runtime's WebGPU backend cannot run it (ceil-mode AveragePool is not supported).";

function backendFields(opts: SpeakerLoadOptions): Pick<ModelLoadRecord, 'requestedBackend' | 'resolvedBackend' | 'fallbackReason'> {
  return { requestedBackend: opts.backend, resolvedBackend: 'wasm', fallbackReason: opts.backend === 'webgpu' ? WEBGPU_UNSUPPORTED : null };
}

function buildLoadRecord(opts: SpeakerLoadOptions, loadStart: number, result: WorkerLoadResult): ModelLoadRecord {
  return {
    model: 'speaker',
    displayName: SPEAKER_MODEL.displayName,
    repo: SPEAKER_MODEL.repo,
    revision: SPEAKER_MODEL.revision,
    quantization: { model: 'fp32' },
    ...backendFields(opts),
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
    versions: { 'onnxruntime-web': ORT_ASSETS.parakeet.version },
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

/** The PCM in a Float32Array that owns its whole (non-shared) buffer, so the buffer can be transferred. */
function ownedSamples(samples: Float32Array): Float32Array<ArrayBuffer> {
  const { buffer } = samples;
  if (buffer instanceof ArrayBuffer && samples.byteOffset === 0 && samples.byteLength === buffer.byteLength) {
    return samples as Float32Array<ArrayBuffer>;
  }
  return new Float32Array(samples);
}

function describeWorkerError(event: ErrorEvent): string {
  if (!event.message) return 'the worker script failed to load or start (details in the browser console)';
  return event.filename ? `${event.message} (${event.filename}:${event.lineno})` : event.message;
}

function safeCall(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    console.error('Speaker progress callback threw', error);
  }
}

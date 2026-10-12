/**
 * The package's main API: one object that owns the transcription model (download, cache, worker) and turns speech into
 * text with it, entirely in the browser.
 *
 *   const stt = createSpeechToText();                       // nothing is downloaded yet
 *   await stt.load();                                       // optional: dictate() / transcribe() load on first use
 *   const d = stt.dictate({ onFinal: (text) => … });        // microphone → live text
 *   const text = await d.stop();                            // finalizes what was being said
 *   const { text } = await stt.transcribe(file);            // an audio file or recording
 *
 * Configuration is plain data (SpeechToTextConfig), so a host app can keep it in build-time env or fetch it from its
 * backend. One dictation at a time: starting another cancels the previous one.
 */
import {
  HUGGING_FACE_BASE_URL,
  MODEL_CACHE_NAME,
  canonicalModelUrl,
  detectWebGpuSupport,
  modelSourceFor,
  type BackendChoice,
  type DownloadProgress,
  type LoadProgress,
  type ResolvedBackend,
} from '@localspeech/core';

export type { DownloadProgress } from '@localspeech/core';
import { AsrEngine } from './engine.js';
import { expectedFileList, parakeetFiles, resolveEncoderQuant, type AsrEnvironment } from './model-files.js';
import { DEFAULT_ASR_SETTINGS, PARAKEET_MODEL, PARAKEET_RUNTIME } from './models.js';
import { ASR_SAMPLE_RATE } from './protocol.js';
import { SegmentTexts } from './segment-texts.js';
import type { SessionCallbacks, SessionOptions, TranscriptionSession } from './session.js';
import type { AsrSettings, ParakeetQuant } from './types.js';

export interface SpeechToTextConfig {
  /**
   * Where model files are downloaded from: Hugging Face (default) or a mirror with the same layout
   * ({base}/{repo}/resolve/{revision}/{file}; the localspeech-models CLI creates one). May be a path on this site,
   * e.g. '/models'.
   */
  modelBaseUrl?: string;
  /**
   * URL of the folder serving ONNX Runtime's ort-wasm-simd-threaded.jsep.{mjs,wasm} (copied there by the
   * localspeech-assets CLI). Default `/localspeech/onnxruntime-web-<version>/`.
   */
  runtimeUrl?: string;
  /** 'auto' (default) uses WebGPU when available and falls back to WASM. */
  backend?: BackendChoice;
  /** Encoder precision; 'auto' (default) = int8 on WASM, fp16 (or fp32 without shader-f16) on WebGPU. */
  precision?: 'auto' | ParakeetQuant;
  /** WASM threads; 0 (default) = automatic. */
  wasmThreads?: number;
  /** How speech is cut into segments (defaults: 800 ms live-text interval, 600 ms of silence ends a segment, 20 s max). */
  segmentation?: Partial<Pick<AsrSettings, 'partialIntervalMs' | 'minSilenceMs' | 'maxSegmentMs'>>;
}

export type SpeechToTextStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface SpeechToTextState {
  status: SpeechToTextStatus;
  progress: DownloadProgress | null;
  error: string | null;
  backend: ResolvedBackend | null;
  precision: ParakeetQuant | null;
}

/** loading → starting (opening the microphone) → listening → stopping → ended | cancelled | error. */
export type DictationStatus = 'loading' | 'starting' | 'listening' | 'stopping' | 'ended' | 'cancelled' | 'error';

export interface DictationState {
  status: DictationStatus;
  /** Everything heard so far: finished segments plus the live text of the one being spoken. */
  text: string;
  /** The finished segments only. */
  finalText: string;
  error: string | null;
}

export interface DictationOptions {
  /** Audio to transcribe instead of the default microphone (e.g. a chosen device). The dictation stops its tracks. */
  stream?: MediaStream;
  /** The live text of the segment being spoken (replaces the previous partial of that segment). */
  onPartial?: (text: string, segmentId: string) => void;
  /** A segment's final text (it may be empty when the segment held no words). */
  onFinal?: (text: string, segmentId: string) => void;
}

export interface Dictation {
  getSnapshot(): DictationState;
  subscribe(listener: () => void): () => void;
  /** Stops listening, finalizes what was being said, and resolves with the final text. */
  stop(): Promise<string>;
  /** Stops at once and discards the segment being spoken. */
  cancel(): void;
  /** Resolves with the final text when the dictation ends (stop) or is cancelled; rejects on failure. */
  readonly done: Promise<string>;
}

export interface TranscriptionResult {
  text: string;
  durationSec: number;
  computeMs: number;
}

/** What transcribe() accepts: an encoded audio file (any format the browser can decode) or decoded audio. */
export type AudioInput = Blob | ArrayBuffer | AudioBuffer | { samples: Float32Array; sampleRate: number };

export function createSpeechToText(config: SpeechToTextConfig = {}): SpeechToText {
  return new SpeechToText(config);
}

const IDLE: SpeechToTextState = { status: 'idle', progress: null, error: null, backend: null, precision: null };

export class SpeechToText {
  readonly config: Readonly<Required<Omit<SpeechToTextConfig, 'segmentation'>>> & { segmentation: SpeechToTextConfig['segmentation'] };
  private readonly engine = new AsrEngine();
  private state: SpeechToTextState = IDLE;
  private readonly listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private webGpu: Promise<AsrEnvironment> | null = null;
  private current: DictationSession | null = null;

  constructor(config: SpeechToTextConfig = {}) {
    this.config = {
      modelBaseUrl: (config.modelBaseUrl ?? HUGGING_FACE_BASE_URL).replace(/\/+$/, ''),
      runtimeUrl: config.runtimeUrl ?? `/localspeech/onnxruntime-web-${PARAKEET_RUNTIME.version}/`,
      backend: config.backend ?? 'auto',
      precision: config.precision ?? DEFAULT_ASR_SETTINGS.encoderQuant,
      wasmThreads: config.wasmThreads ?? DEFAULT_ASR_SETTINGS.wasmThreads,
      segmentation: config.segmentation,
    };
  }

  readonly getSnapshot = (): SpeechToTextState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Downloads (first time) and initialises the transcription model. Concurrent calls share one load. */
  load(): Promise<void> {
    if (this.state.status === 'ready' && this.engine.isLoaded) return Promise.resolve();
    this.loading ??= this.loadNow().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** Whether the model files for the current configuration are already in browser storage. A UI hint. */
  async isCached(): Promise<boolean> {
    if (typeof caches === 'undefined') return false;
    try {
      if (!(await caches.has(MODEL_CACHE_NAME))) return false;
      const environment = await this.environment();
      const backend: ResolvedBackend = this.config.backend === 'auto' ? (environment.webgpu.adapterAvailable ? 'webgpu' : 'wasm') : this.config.backend;
      const quant = resolveEncoderQuant(backend, this.config.precision, environment);
      const cache = await caches.open(MODEL_CACHE_NAME);
      for (const file of expectedFileList(parakeetFiles(quant))) {
        if (!(await cache.match(canonicalModelUrl(PARAKEET_MODEL.repo, PARAKEET_MODEL.revision, file)))) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Starts transcribing the microphone (or `options.stream`). Returns at once; the dictation loads the model and
   * opens the microphone itself (the browser asks for permission the first time).
   */
  dictate(options: DictationOptions = {}): Dictation {
    this.current?.cancel();
    const dictation = new DictationSession(this, this.engine, options, this.config.segmentation);
    this.current = dictation;
    void dictation.done
      .catch(() => undefined)
      .finally(() => {
        if (this.current === dictation) this.current = null;
      });
    return dictation;
  }

  /** Transcribes a recording in one pass (loads the model first if needed). */
  async transcribe(input: AudioInput): Promise<TranscriptionResult> {
    const samples = await toMono16k(input);
    await this.load();
    const { text, computeMs } = await this.engine.transcribe(samples);
    return { text, durationSec: samples.length / ASR_SAMPLE_RATE, computeMs };
  }

  /**
   * Advanced: continuous multi-source transcription with per-segment events (microphone plus shared call audio; see
   * requestSystemAudio()). Loads the model first. Cannot run while a dictation is active.
   */
  async startSession(options: SessionOptions, callbacks: SessionCallbacks): Promise<TranscriptionSession> {
    await this.load();
    return this.engine.startSession(options, callbacks);
  }

  /** Stops any dictation and releases the model and the worker. The object stays usable: load() starts over. */
  dispose(): void {
    this.current?.cancel();
    this.current = null;
    this.loading = null;
    this.engine.dispose();
    this.set(IDLE);
  }

  // -------------------------------------------------------------------------

  private async loadNow(): Promise<void> {
    this.set({ ...IDLE, status: 'loading', progress: { phase: 'download', loadedBytes: 0, totalBytes: null, fraction: null } });
    const files = new Map<string, { loaded: number; total: number | null }>();
    try {
      const source = modelSourceFor(this.config.modelBaseUrl);
      const record = await this.engine.load({
        backend: this.config.backend,
        source,
        settings: {
          ...DEFAULT_ASR_SETTINGS,
          ...this.config.segmentation,
          encoderQuant: this.config.precision,
          wasmThreads: this.config.wasmThreads,
        },
        environment: await this.environment(),
        runtimeUrl: this.config.runtimeUrl,
        onProgress: (p) => this.onProgress(p, files),
      });
      this.set({
        status: 'ready',
        progress: null,
        error: null,
        backend: record.resolvedBackend,
        precision: (record.quantization.encoder ?? null) as ParakeetQuant | null,
      });
    } catch (e) {
      this.set({ ...IDLE, status: 'error', error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  private onProgress(p: LoadProgress, files: Map<string, { loaded: number; total: number | null }>): void {
    if (this.state.status !== 'loading' || p.phase === 'ready' || p.phase === 'error') return;
    if (p.file && p.loadedBytes !== undefined) files.set(p.file, { loaded: p.loadedBytes, total: p.totalBytes ?? null });
    let loaded = 0;
    let total = 0;
    let unknown = false;
    for (const f of files.values()) {
      loaded += f.loaded;
      if (f.total === null) unknown = true;
      else total += f.total;
    }
    const totalBytes = unknown || total === 0 ? null : total;
    this.set({ ...this.state, progress: { phase: p.phase, loadedBytes: loaded, totalBytes, fraction: totalBytes ? Math.min(1, loaded / totalBytes) : null } });
  }

  private environment(): Promise<AsrEnvironment> {
    this.webGpu ??= (
      this.config.backend === 'wasm'
        ? Promise.resolve({ apiPresent: false, adapterAvailable: false, error: null, shaderF16: false })
        : detectWebGpuSupport()
    ).then((info) => ({ webgpu: { apiPresent: info.apiPresent, adapterAvailable: info.adapterAvailable, error: info.error, shaderF16: info.shaderF16 } }));
    return this.webGpu;
  }

  private set(state: SpeechToTextState): void {
    this.state = state;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error('SpeechToText listener threw', error);
      }
    }
  }
}

/** One dictate(): waits for the model, runs a single-microphone session and keeps the segment texts. */
class DictationSession implements Dictation {
  readonly done: Promise<string>;
  private state: DictationState;
  private readonly listeners = new Set<() => void>();
  private readonly texts = new SegmentTexts();
  private session: TranscriptionSession | null = null;
  private stopping: Promise<string> | null = null;
  private settled = false;
  private resolve!: (text: string) => void;
  private reject!: (error: Error) => void;

  constructor(
    private readonly stt: SpeechToText,
    private readonly engine: AsrEngine,
    private readonly options: DictationOptions,
    private readonly segmentation: SpeechToTextConfig['segmentation'],
  ) {
    this.state = { status: stt.getSnapshot().status === 'ready' ? 'starting' : 'loading', text: '', finalText: '', error: null };
    this.done = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.done.catch(() => undefined);
    void this.run();
  }

  readonly getSnapshot = (): DictationState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  stop(): Promise<string> {
    if (this.settled) return this.done.catch(() => this.state.finalText);
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.update({ status: 'stopping' });
      // Not started yet (still loading or opening the microphone): nothing was heard.
      const session = this.session;
      if (session) await session.stop();
      this.settle('ended', null);
      return this.state.finalText;
    })().catch((e: unknown) => {
      this.settle('error', e instanceof Error ? e.message : String(e));
      return this.state.finalText;
    });
    return this.stopping;
  }

  cancel(): void {
    if (this.settled) return;
    this.settle('cancelled', null);
    this.session?.abort('The dictation was cancelled.');
  }

  private async run(): Promise<void> {
    try {
      await this.stt.load();
      if (this.settled || this.stopping) {
        if (this.stopping) this.settle('ended', null);
        this.options.stream?.getTracks().forEach((t) => t.stop());
        return;
      }
      this.update({ status: 'starting' });
      const session = await this.engine.startSession(
        { sources: [{ kind: 'mic', stream: this.options.stream }], segmentation: this.segmentation },
        {
          onSegmentStart: (e) => this.texts.start(e.segmentId),
          onPartial: (e) => {
            this.texts.partial(e.segmentId, e.text);
            this.safe(() => this.options.onPartial?.(e.text, e.segmentId));
            this.update({ text: this.texts.visible });
          },
          onFinal: (e) => {
            this.texts.final(e.segmentId, e.text);
            this.safe(() => this.options.onFinal?.(e.text, e.segmentId));
            this.update({ text: this.texts.visible, finalText: this.texts.finals });
          },
          onError: (message) => console.warn(`[stt] ${message}`),
        },
      );
      if (this.settled) {
        session.abort('The dictation was cancelled.');
        return;
      }
      this.session = session;
      if (this.stopping) {
        // stop() was called while the microphone was opening.
        await session.stop();
        this.settle('ended', null);
        return;
      }
      this.update({ status: 'listening' });
    } catch (e) {
      this.settle('error', e instanceof Error ? e.message : String(e));
    }
  }

  private update(patch: Partial<DictationState>): void {
    if (this.settled) return;
    this.state = { ...this.state, ...patch };
    this.notify();
  }

  private settle(status: 'ended' | 'cancelled' | 'error', error: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.state = { ...this.state, status, error, text: status === 'ended' ? this.texts.finals : this.state.text };
    this.notify();
    if (status === 'error') this.reject(new Error(error ?? 'Transcription failed.'));
    else this.resolve(this.state.finalText);
  }

  private notify(): void {
    for (const listener of this.listeners) this.safe(listener);
  }

  private safe(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      console.error('Dictation listener threw', error);
    }
  }
}

/** Any supported input → 16 kHz mono PCM. Encoded files are decoded by the browser, which also resamples. */
async function toMono16k(input: AudioInput): Promise<Float32Array> {
  if ('samples' in input) return resampleLinear(input.samples, input.sampleRate);
  let buffer: AudioBuffer;
  if (typeof AudioBuffer !== 'undefined' && input instanceof AudioBuffer) {
    buffer = input;
  } else {
    const bytes = input instanceof Blob ? await input.arrayBuffer() : (input as ArrayBuffer);
    // decodeAudioData resamples to the context's rate, so a 16 kHz context yields model-ready audio.
    const ctx = new OfflineAudioContext(1, 1, ASR_SAMPLE_RATE);
    buffer = await ctx.decodeAudioData(bytes.slice(0));
  }
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }
  return buffer.sampleRate === ASR_SAMPLE_RATE ? mono : resampleLinear(mono, buffer.sampleRate);
}

/** Linear interpolation; only for raw sample input at another rate (decoded files arrive at 16 kHz already). */
function resampleLinear(samples: Float32Array, rate: number): Float32Array {
  if (rate === ASR_SAMPLE_RATE) return samples;
  const out = new Float32Array(Math.floor((samples.length * ASR_SAMPLE_RATE) / rate));
  const step = rate / ASR_SAMPLE_RATE;
  for (let i = 0; i < out.length; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = (samples[j] ?? 0) * (1 - f) + (samples[j + 1] ?? samples[j] ?? 0) * f;
  }
  return out;
}

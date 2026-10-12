/**
 * The package's main API: one object that owns the voice model (download, cache, worker) and speaks text with it.
 *
 *   const tts = createTextToSpeech({ voice: 'af_heart' });   // nothing is downloaded yet
 *   await tts.load();                                         // optional: speak() loads on first use
 *   tts.speak('Hello there.');                                // static text
 *   const live = tts.stream(); live.push(delta); … live.end(); // text that is still arriving (an LLM reply)
 *   const { samples, sampleRate, toWav } = await tts.synthesize('Some text');   // audio back, no playback
 *
 * Configuration is plain data (TextToSpeechConfig), so a host app can keep it in build-time env or fetch it from its
 * backend. Call speak() / stream() from a user gesture the first time: browsers only start audio output after one.
 * One playback at a time: starting a new one cancels the previous.
 */
import {
  HUGGING_FACE_BASE_URL,
  MODEL_CACHE_NAME,
  canonicalModelUrl,
  detectWebGpuSupport,
  type BackendChoice,
  type LoadProgress,
  type ModelSource,
  type ResolvedBackend,
} from '@localspeech/core';
import { parseDocument, type DocFormat } from './document.js';
import { TtsEngine, type TtsEnvironment } from './engine.js';
import { DEFAULT_TTS_SETTINGS, KOKORO_MODEL, KOKORO_RUNTIME } from './models.js';
import { applySpeechLoudness } from './output.js';
import { planReading, type SplitMode } from './pieces.js';
import { DEFAULT_READ_AHEAD_SEC, ReadAloudSession, type ReaderPiece } from './reader.js';
import { StreamingTextPlanner } from './streaming-text.js';
import type { KokoroDtype } from './types.js';
import { encodeWav, floatToInt16 } from './wav.js';

export interface TextToSpeechConfig {
  /** Where model files are downloaded from: Hugging Face (default) or a mirror with the same layout. */
  modelBaseUrl?: string;
  /**
   * URL of the folder serving ONNX Runtime's ort-wasm-simd-threaded.jsep.{mjs,wasm} (copied there by the
   * localspeech-assets CLI). Default `/localspeech/onnxruntime-web-<version>/`.
   */
  runtimeUrl?: string;
  /** 'auto' (default) uses WebGPU when available and falls back to WASM. */
  backend?: BackendChoice;
  /** Model precision; 'auto' (default) = fp16 on WASM, fp32 on WebGPU. */
  precision?: 'auto' | KokoroDtype;
  /** Default voice id (e.g. 'af_heart', 'am_michael'); downloaded with the model. */
  voice?: string;
  /** Default speaking rate, 0.5–2 (default 1). */
  speed?: number;
  /** WASM threads; 0 (default) = automatic. */
  wasmThreads?: number;
  /** 'sentence' (default) or 'clause' (also splits at , ; : for earlier audio on slow machines). */
  split?: SplitMode;
  /** Generation stops this far ahead of playback, in seconds (default 30). */
  readAheadSec?: number;
}

export type TextToSpeechStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface DownloadProgress {
  phase: LoadProgress['phase'];
  loadedBytes: number;
  /** Null while the sizes are not known yet. */
  totalBytes: number | null;
  /** 0…1 of the known download size; null while unknown. */
  fraction: number | null;
}

export interface TextToSpeechState {
  status: TextToSpeechStatus;
  progress: DownloadProgress | null;
  error: string | null;
  /** Set once loaded. */
  backend: ResolvedBackend | null;
  precision: KokoroDtype | null;
}

/**
 * loading → the model is still loading; starting → generating the first audio; playing / paused; then one of
 * ended (everything was spoken), cancelled, error.
 */
export type PlaybackStatus = 'loading' | 'starting' | 'playing' | 'paused' | 'ended' | 'cancelled' | 'error';

export interface PlaybackState {
  status: PlaybackStatus;
  error: string | null;
}

export interface Playback {
  getSnapshot(): PlaybackState;
  subscribe(listener: () => void): () => void;
  pause(): void;
  /** Call from a user gesture: the browser may require one to restart audio. */
  resume(): void;
  cancel(): void;
  /** Resolves 'finished' or 'cancelled'; rejects if the model fails to load or synthesis fails. */
  readonly done: Promise<'finished' | 'cancelled'>;
}

export interface StreamingPlayback extends Playback {
  /** Appends text (e.g. the tokens just received). Complete sentences start speaking as soon as they arrive. */
  push(delta: string): void;
  /** The text is complete: the rest is spoken, then the playback ends. */
  end(): void;
}

export interface SpeakOptions {
  voice?: string;
  speed?: number;
  /** 'markdown' (default) reads markdown as a listener would expect (no symbols, code announced); 'plain' as is. */
  format?: DocFormat;
}

export interface SynthesizedAudio {
  /** Mono PCM. */
  samples: Float32Array;
  sampleRate: number;
  /** 16-bit PCM WAV file of the audio. */
  toWav(): Blob;
}

export function createTextToSpeech(config: TextToSpeechConfig = {}): TextToSpeech {
  return new TextToSpeech(config);
}

const IDLE: TextToSpeechState = { status: 'idle', progress: null, error: null, backend: null, precision: null };

export class TextToSpeech {
  readonly config: Readonly<Required<TextToSpeechConfig>>;
  private readonly engine = new TtsEngine();
  private state: TextToSpeechState = IDLE;
  private readonly listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private webGpu: Promise<TtsEnvironment> | null = null;
  private current: PlaybackSession | null = null;

  constructor(config: TextToSpeechConfig = {}) {
    this.config = {
      modelBaseUrl: (config.modelBaseUrl ?? HUGGING_FACE_BASE_URL).replace(/\/+$/, ''),
      runtimeUrl: config.runtimeUrl ?? `/localspeech/onnxruntime-web-${KOKORO_RUNTIME.version}/`,
      backend: config.backend ?? 'auto',
      precision: config.precision ?? DEFAULT_TTS_SETTINGS.dtype,
      voice: config.voice ?? DEFAULT_TTS_SETTINGS.voice,
      speed: config.speed ?? DEFAULT_TTS_SETTINGS.speed,
      wasmThreads: config.wasmThreads ?? DEFAULT_TTS_SETTINGS.wasmThreads,
      split: config.split ?? DEFAULT_TTS_SETTINGS.split,
      readAheadSec: config.readAheadSec ?? DEFAULT_READ_AHEAD_SEC,
    };
  }

  /** For React's useSyncExternalStore and similar: the current state object (replaced on every change). */
  readonly getSnapshot = (): TextToSpeechState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Downloads (first time) and initialises the voice model. Safe to call repeatedly; concurrent calls share one load. */
  load(): Promise<void> {
    if (this.state.status === 'ready' && this.engine.isLoaded) return Promise.resolve();
    this.loading ??= this.loadNow().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /**
   * Whether the model files for the current configuration are already in browser storage (so load() needs no
   * download). A hint for the UI ("Download voice (163 MB)" vs instant); false when storage can't be read.
   */
  async isCached(): Promise<boolean> {
    if (typeof caches === 'undefined') return false;
    try {
      const backend = this.config.backend === 'auto' ? ((await this.environment()).webgpu.adapterAvailable ? 'webgpu' : 'wasm') : this.config.backend;
      const files = [KOKORO_MODEL.tokenizerFile, KOKORO_MODEL.dtypeFiles[this.dtypeFor(backend)], KOKORO_MODEL.voiceFile(this.config.voice)];
      const stores = [MODEL_CACHE_NAME, 'transformers-cache', 'kokoro-voices'];
      const open = await Promise.all(stores.map(async (name) => ((await caches.has(name)) ? caches.open(name) : null)));
      for (const file of files) {
        const keys = [canonicalModelUrl(KOKORO_MODEL.repo, KOKORO_MODEL.revision, file), `${HUGGING_FACE_BASE_URL}/${KOKORO_MODEL.repo}/resolve/main/${file}`];
        let found = false;
        for (const cache of open) {
          for (const key of keys) if (cache && (await cache.match(key))) found = true;
        }
        if (!found) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Starts (or resumes) audio output. speak() and stream() call it themselves; call it from a click yourself when
   * playback will start later without one (e.g. reading replies aloud automatically once they arrive).
   */
  unlockAudio(): void {
    this.engine.unlockAudio();
  }

  /** Speaks a complete text. */
  speak(text: string, options: SpeakOptions = {}): Playback {
    const playback = this.stream(options);
    playback.push(text);
    playback.end();
    return playback;
  }

  /** Speaks text that is still arriving: push() deltas as they come, end() when the text is complete. */
  stream(options: SpeakOptions = {}): StreamingPlayback {
    this.current?.cancel();
    // Synchronously, so a call from a click handler counts as the user gesture that allows audio output.
    this.engine.unlockAudio();
    const playback = new PlaybackSession(this, this.engine, {
      voice: options.voice ?? this.config.voice,
      speed: options.speed ?? this.config.speed,
      format: options.format ?? 'markdown',
      split: this.config.split,
      readAheadSec: this.config.readAheadSec,
    });
    this.current = playback;
    void playback.done.catch(() => undefined).finally(() => {
      if (this.current === playback) this.current = null;
    });
    return playback;
  }

  /** Stops the current playback, if any. */
  cancel(): void {
    this.current?.cancel();
  }

  /** Generates the audio for a text without playing it (markdown is cleaned up as for speak()). */
  async synthesize(text: string, options: SpeakOptions = {}): Promise<SynthesizedAudio> {
    await this.load();
    const voice = options.voice ?? this.config.voice;
    const speed = options.speed ?? this.config.speed;
    const plan = planReading(parseDocument(text, options.format ?? 'markdown').blocks, { split: this.config.split });
    const parts: Float32Array[] = [];
    let sampleRate = 24_000;
    for (const piece of plan.pieces) {
      const result = await this.engine.synthesize(piece.text, { voice, speed }).result;
      if (result.failed || result.skipped || result.audio.length === 0) continue;
      applySpeechLoudness(result.audio, result.sampleRate);
      parts.push(result.audio);
      sampleRate = result.sampleRate;
    }
    const samples = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      samples.set(part, offset);
      offset += part.length;
    }
    return { samples, sampleRate, toWav: () => encodeWav([floatToInt16(samples)], sampleRate) };
  }

  /** Stops playback and releases the model and the worker. The object stays usable: load() starts over. */
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
      const source: ModelSource =
        this.config.modelBaseUrl === HUGGING_FACE_BASE_URL
          ? { kind: 'huggingface', baseUrl: HUGGING_FACE_BASE_URL }
          : { kind: 'mirror', baseUrl: this.config.modelBaseUrl };
      const record = await this.engine.load({
        backend: this.config.backend,
        source,
        settings: {
          dtype: this.config.precision,
          voice: this.config.voice,
          speed: this.config.speed,
          split: this.config.split,
          wasmThreads: this.config.wasmThreads,
        },
        environment: await this.environment(),
        runtimeUrl: this.config.runtimeUrl,
        onProgress: (p) => this.onProgress(p, files),
      });
      this.set({ status: 'ready', progress: null, error: null, backend: record.resolvedBackend, precision: (record.quantization.model ?? null) as KokoroDtype | null });
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

  private environment(): Promise<TtsEnvironment> {
    if (this.config.backend !== 'auto') {
      return Promise.resolve({ webgpu: { adapterAvailable: this.config.backend === 'webgpu', error: null } });
    }
    this.webGpu ??= detectWebGpuSupport().then((info) => ({ webgpu: { adapterAvailable: info.adapterAvailable, error: info.error } }));
    return this.webGpu;
  }

  private dtypeFor(backend: ResolvedBackend): KokoroDtype {
    if (this.config.precision !== 'auto') return this.config.precision;
    return backend === 'webgpu' ? 'fp32' : 'fp16';
  }

  private set(state: TextToSpeechState): void {
    this.state = state;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error('TextToSpeech listener threw', error);
      }
    }
  }
}

interface PlaybackOptions {
  voice: string;
  speed: number;
  format: DocFormat;
  split: SplitMode;
  readAheadSec: number;
}

/** One speak() / stream(): text planning, model load wait, then a read-aloud session that pieces are appended to. */
class PlaybackSession implements StreamingPlayback {
  readonly done: Promise<'finished' | 'cancelled'>;
  private state: PlaybackState;
  private readonly listeners = new Set<() => void>();
  private readonly planner: StreamingTextPlanner;
  private session: ReadAloudSession | null = null;
  private pending: ReaderPiece[] = [];
  private inputEnded = false;
  private settled = false;
  private resolve!: (value: 'finished' | 'cancelled') => void;
  private reject!: (error: Error) => void;

  constructor(
    private readonly tts: TextToSpeech,
    private readonly engine: TtsEngine,
    private readonly options: PlaybackOptions,
  ) {
    this.state = { status: tts.getSnapshot().status === 'ready' ? 'starting' : 'loading', error: null };
    this.done = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // Unobserved rejections stay out of the console; awaiting `done` still sees them.
    this.done.catch(() => undefined);
    this.planner = new StreamingTextPlanner({
      format: options.format,
      split: options.split,
      onPieces: (pieces) => {
        if (this.session) this.session.append(pieces);
        else this.pending.push(...pieces);
      },
    });
    void this.run();
  }

  readonly getSnapshot = (): PlaybackState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  push(delta: string): void {
    if (this.settled || this.inputEnded) return;
    this.planner.push(delta);
  }

  end(): void {
    if (this.settled || this.inputEnded) return;
    this.planner.end();
    this.inputEnded = true;
    this.session?.endInput();
  }

  pause(): void {
    this.session?.pause();
  }

  resume(): void {
    this.session?.resume();
  }

  cancel(): void {
    if (this.settled) return;
    this.settle('cancelled', null);
    this.session?.stop();
  }

  private async run(): Promise<void> {
    try {
      await this.tts.load();
      if (this.settled) return;
      this.update('starting');
      const ctx = await this.engine.outputContext();
      if (this.settled) return;
      const session = new ReadAloudSession({
        ctx,
        backend: this.engine,
        pieces: this.pending,
        inputEnded: this.inputEnded,
        voice: this.options.voice,
        speed: this.options.speed,
        readAheadSec: this.options.readAheadSec,
      });
      this.pending = [];
      this.session = session;
      session.subscribe(() => this.onSession(session));
      void session.done.then((status) => {
        if (status === 'ended') this.settle('ended', null);
        else if (status === 'error') this.settle('error', session.getSnapshot().error ?? 'Speech synthesis failed.');
        else this.settle('cancelled', null);
      });
      session.start();
    } catch (e) {
      this.settle('error', e instanceof Error ? e.message : String(e));
    }
  }

  private onSession(session: ReadAloudSession): void {
    if (this.settled) return;
    const snapshot = session.getSnapshot();
    if (snapshot.status === 'paused') this.update('paused');
    else if (snapshot.status === 'playing') this.update(snapshot.metrics.firstSoundAt === null ? 'starting' : 'playing');
  }

  private update(status: PlaybackStatus): void {
    if (this.settled || this.state.status === status) return;
    this.state = { status, error: null };
    this.notify();
  }

  private settle(status: 'ended' | 'cancelled' | 'error', error: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.state = { status, error };
    this.notify();
    if (status === 'error') this.reject(new Error(error ?? 'Speech synthesis failed.'));
    else this.resolve(status === 'ended' ? 'finished' : 'cancelled');
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error('Playback listener threw', error);
      }
    }
  }
}

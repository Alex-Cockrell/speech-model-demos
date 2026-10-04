/**
 * Read-aloud playback: streams a long text through Kokoro piece by piece, with bounded read-ahead, pause/resume,
 * seeking and continuity measurements. Main thread only. It needs a ReaderBackend (TtsEngine implements it) and
 * a running AudioContext, so it can be tested with fakes.
 *
 * Flow control. Generation is pull-based: the session requests one piece at a time (TtsEngine.synthesize) and only
 * while less than `readAheadSec` of audio is scheduled ahead of the playhead. With pieces of ≤ ~12 s, at most
 * ~42 s of PCM is scheduled whatever the document length, and the worker idles once it is that far ahead instead
 * of synthesising a 30-minute document up front. When generation is slower than real time the buffer never
 * fills: requests run back to back and playback stalls between pieces (measured below).
 *
 * Pause suspends the AudioContext: scheduled audio freezes in place and resume continues seamlessly. No new
 * requests are made while paused; an inference already running finishes and its audio is scheduled.
 *
 * Seeking flushes the scheduled audio and restarts at the target piece. Pieces generated earlier with the current
 * voice and speed come from a 16-bit archive without regenerating them. A superseded request still running in
 * the worker cannot be interrupted, so its result is archived rather than dropped. A voice or speed change keeps
 * the piece being played and regenerates everything after it (applied 300 ms after the last change, so dragging
 * the speed slider does not discard work on every step).
 *
 * Continuity, in context-clock seconds (the clock stops while paused, so paused time never counts):
 *   stall    a piece arrived after the scheduled audio had run out, during continuous playback. The first piece
 *            after start or a seek is not a stall: that wait is the start or seek latency.
 *   silence  the gap inserted before a stalled piece (what the listener heard as a pause).
 *   buffered scheduled audio ahead of the playhead when a piece arrived (min/max exclude segment starts).
 */
import { now } from '../clock';
import type { SynthesisJob, SynthesisOptions, SynthesisResult } from './engine';
import { applySpeechLoudness, speechOutput } from './output';
import { SAFETY_LEAD_SEC, contextTimeToMainClock } from './playback';
import { encodeWav, floatToInt16, int16ToFloat } from './wav';

export interface ReaderBackend {
  synthesize(text: string, options: SynthesisOptions): SynthesisJob;
}

export interface ReaderPiece {
  /** Text sent to Kokoro. */
  text: string;
  /** Displayed characters, for the time estimates. */
  chars: number;
}

export type ReaderStatus = 'playing' | 'paused' | 'ended' | 'stopped' | 'error';

export interface PieceGeneration {
  piece: number;
  voice: string;
  speed: number;
  requestedAt: number;
  generationStart: number;
  generatedAt: number;
  /** Inference time in the worker. */
  computeMs: number;
  /** Time waiting in the worker queue (behind a superseded request) before generation started. */
  queueMs: number;
  audioSec: number;
  /** computeMs / audio duration; < 1 is faster than real time. */
  rtf: number | null;
  inferences: number;
  overflowSplits: number;
  truncated: boolean;
  /** Superseded by a seek or a voice/speed change before it arrived (archived, not played). */
  superseded: boolean;
}

export interface ReaderMetrics {
  /** start() — after the model was loaded and audio unlocked. */
  startedAt: number;
  /** First generated piece arrived. */
  firstAudioGeneratedAt: number | null;
  /** First audio reached the speakers (scheduled start, output latency included where the browser reports it). */
  firstSoundAt: number | null;
  timeToFirstAudioMs: number | null;
  timeToFirstSoundMs: number | null;
  /** The latest seek (or voice/speed restart): when it was requested and when the new position was heard. */
  lastSeek: { at: number; piece: number; soundAt: number | null; latencyMs: number | null } | null;
  piecesGenerated: number;
  /** Generations whose piece had been superseded before they arrived. */
  supersededGenerations: number;
  inferences: number;
  overflowSplits: number;
  truncatedPieces: number;
  generationComputeMs: number;
  generatedAudioSec: number;
  /** generationComputeMs / generated audio over the whole session. */
  rtf: number | null;
  /** RTF over the last few generations: what decides whether playback keeps up now. */
  recentRtf: number | null;
  stalls: number;
  stallSilenceSec: number;
  longestStallSec: number;
  minBufferedSec: number | null;
  maxBufferedSec: number | null;
  archive: { pieces: number; seconds: number; bytes: number; evicted: number };
}

export interface ReaderSnapshot {
  status: ReaderStatus;
  /** 'audio-suspended': the browser suspended audio output; Resume (a user gesture) restarts it. */
  pausedReason: 'user' | 'audio-suspended' | null;
  error: string | null;
  voice: string;
  speed: number;
  metrics: ReaderMetrics;
  /** Most recent generations, newest last. */
  recent: PieceGeneration[];
}

export interface ReaderPosition {
  /** Piece being played, or the one playback is waiting for; null when nothing is left. */
  piece: number | null;
  /** 0…1 through the current piece's audio. */
  pieceProgress: number;
  /** Nothing has played since start or the last seek yet. */
  starting: boolean;
  /** Seconds of silence so far in a stall in progress; null when not stalled. */
  stalledSec: number | null;
  /** Scheduled audio ahead of the playhead. */
  bufferedSec: number;
  /** The request playback is waiting on (or reading ahead with). */
  generating: { piece: number; elapsedMs: number } | null;
  /** Audio actually played in this session (excludes pauses, stalls and skipped parts). */
  playedSec: number;
  /** Estimated listening time left from the current position at the current speed. */
  remainingSec: number;
}

export interface Timers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ReaderInit {
  ctx: AudioContext;
  backend: ReaderBackend;
  pieces: readonly ReaderPiece[];
  startPiece?: number;
  voice: string;
  speed: number;
  /** Generation stops once this much audio is scheduled ahead of the playhead (default 30 s). */
  readAheadSec?: number;
  /** Generated audio kept as 16-bit PCM for seeking back and the WAV download (default 30 min, ≈ 86 MB). */
  archiveLimitSec?: number;
  timers?: Timers;
}

export const DEFAULT_READ_AHEAD_SEC = 30;
export const DEFAULT_ARCHIVE_LIMIT_SEC = 30 * 60;
/** Characters per second of Kokoro speech at speed 1, used until the session has measured its own. */
const DEFAULT_CHARS_PER_SEC = 14;
const TICK_MS = 250;
const SETTINGS_DEBOUNCE_MS = 300;
/** Ticks (× TICK_MS) with a context the browser keeps suspended before playback is shown as paused. */
const SUSPENDED_TICKS = 8;
const RECENT_GENERATIONS = 5;
const KEPT_GENERATIONS = 50;

interface Scheduled {
  piece: number;
  start: number;
  end: number;
  source: AudioBufferSourceNode;
}

interface Request {
  piece: number;
  voice: string;
  speed: number;
  job: SynthesisJob;
  requestedAt: number;
}

interface Archived {
  samples: Int16Array;
  sampleRate: number;
  voice: string;
  speed: number;
}

const defaultTimers: Timers = {
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class ReadAloudSession {
  private readonly ctx: AudioContext;
  private readonly backend: ReaderBackend;
  private readonly pieces: readonly ReaderPiece[];
  private readonly readAheadSec: number;
  private readonly archiveLimitSec: number;
  private readonly listeners = new Set<() => void>();
  private readonly timers: Timers;
  private readonly output: GainNode;
  /** charsAfter[i] = displayed characters of pieces i … n-1. */
  private readonly charsAfter: Float64Array;

  private status: ReaderStatus = 'playing';
  private pausedReason: ReaderSnapshot['pausedReason'] = null;
  private error: string | null = null;
  private voice: string;
  private speed: number;
  private pendingSettings: { voice: string; speed: number } | null = null;
  private settingsTimer: unknown = null;
  private tick: unknown = null;
  private suspendedTicks = 0;
  /** We suspended the context (pause), so finishing must resume it for other users of the shared context. */
  private suspendedByUs = false;

  private timeline: Scheduled[] = [];
  /** Context time at which the scheduled audio runs out. */
  private queueEnd = 0;
  /** Next piece to schedule; `active` (if any) is generating exactly this piece with the current settings. */
  private nextIndex: number;
  private active: Request | null = null;
  private readonly superseded = new Set<Request>();
  /** Audio has been scheduled since start or the last seek (so a late piece is a stall, not a start). */
  private continuing = false;
  private playedSec = 0;

  private readonly archive = new Map<number, Archived>();
  private archivedSamples = 0;
  private archiveRate = 24_000;
  private evicted = 0;

  private readonly generations: PieceGeneration[] = [];
  private totals = { pieces: 0, superseded: 0, inferences: 0, overflowSplits: 0, truncated: 0, computeMs: 0, audioSec: 0 };
  /** Measured speaking rate: displayed characters per second of audio, normalised to speed 1. */
  private rate = { chars: 0, sec: 0 };
  private metrics: Omit<ReaderMetrics, 'piecesGenerated' | 'supersededGenerations' | 'inferences' | 'overflowSplits' | 'truncatedPieces' | 'generationComputeMs' | 'generatedAudioSec' | 'rtf' | 'recentRtf' | 'archive'>;
  private snapshot: ReaderSnapshot;

  constructor(init: ReaderInit) {
    this.ctx = init.ctx;
    this.backend = init.backend;
    this.pieces = init.pieces;
    this.readAheadSec = init.readAheadSec ?? DEFAULT_READ_AHEAD_SEC;
    this.archiveLimitSec = init.archiveLimitSec ?? DEFAULT_ARCHIVE_LIMIT_SEC;
    this.timers = init.timers ?? defaultTimers;
    this.voice = init.voice;
    this.speed = init.speed;
    this.nextIndex = clamp(init.startPiece ?? 0, 0, Math.max(0, init.pieces.length - 1));
    this.output = init.ctx.createGain();
    this.output.connect(speechOutput(init.ctx));
    this.charsAfter = new Float64Array(init.pieces.length + 1);
    for (let i = init.pieces.length - 1; i >= 0; i--) this.charsAfter[i] = this.charsAfter[i + 1] + init.pieces[i].chars;
    this.metrics = {
      startedAt: now(),
      firstAudioGeneratedAt: null,
      firstSoundAt: null,
      timeToFirstAudioMs: null,
      timeToFirstSoundMs: null,
      lastSeek: null,
      stalls: 0,
      stallSilenceSec: 0,
      longestStallSec: 0,
      minBufferedSec: null,
      maxBufferedSec: null,
    };
    this.snapshot = this.buildSnapshot();
  }

  /** Begin generating and playing from the start piece. */
  start(): void {
    if (this.tick !== null || this.isFinished()) return;
    if (this.pieces.length === 0) {
      this.finish('ended');
      return;
    }
    this.metrics.startedAt = now();
    this.queueEnd = this.ctx.currentTime;
    this.tick = this.timers.setInterval(() => this.pump(), TICK_MS);
    this.pump();
    this.changed();
  }

  readonly getSnapshot = (): ReaderSnapshot => this.snapshot;

  /** Snapshot changes (status, metrics); the live position is polled with position(). */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get pieceCount(): number {
    return this.pieces.length;
  }

  /** Live position from the audio clock; cheap enough to poll every frame. */
  position(): ReaderPosition {
    const t = this.ctx.currentTime;
    const playing = this.timeline.find((e) => e.start <= t && t < e.end) ?? null;
    let piece: number | null;
    let progress = 0;
    if (playing) {
      piece = playing.piece;
      progress = (t - playing.start) / Math.max(1e-6, playing.end - playing.start);
    } else {
      const upcoming = this.timeline.find((e) => e.start > t);
      if (upcoming) piece = upcoming.piece;
      else if (this.nextIndex < this.pieces.length) piece = this.nextIndex;
      else piece = this.status === 'ended' ? null : this.pieces.length - 1;
    }
    const live = this.status === 'playing' || this.status === 'paused';
    const drained = t >= this.queueEnd;
    // Not while paused: the context clock is stopped, so the silence is not growing.
    const stalled = this.status === 'playing' && this.continuing && drained && this.nextIndex < this.pieces.length;
    let played = this.playedSec;
    for (const e of this.timeline) played += clamp(t - e.start, 0, e.end - e.start);
    const charsLeft = piece === null ? 0 : this.charsAfter[piece + 1] + (1 - progress) * (this.pieces[piece]?.chars ?? 0);
    return {
      piece,
      pieceProgress: clamp(progress, 0, 1),
      starting: live && !this.continuing,
      stalledSec: stalled ? t - this.queueEnd : null,
      bufferedSec: Math.max(0, this.queueEnd - t),
      generating: this.active ? { piece: this.active.piece, elapsedMs: now() - this.active.requestedAt } : null,
      playedSec: played,
      remainingSec: charsLeft / (this.charsPerSecond() * this.speed),
    };
  }

  /** Suspend audio output and generation read-ahead. */
  pause(): void {
    if (this.status !== 'playing') return;
    this.status = 'paused';
    this.pausedReason = 'user';
    this.suspendedByUs = true;
    this.ctx.suspend().catch(() => undefined);
    this.changed();
  }

  /** Resume after pause(); call from a user gesture (the browser may require one to restart audio). */
  resume(): void {
    if (this.status !== 'paused') return;
    this.status = 'playing';
    this.pausedReason = null;
    this.suspendedTicks = 0;
    this.suspendedByUs = false;
    this.ctx.resume().catch(() => undefined);
    this.pump();
    this.changed();
  }

  /** Jump to a piece (normally the first piece of a sentence) and play from there. */
  seek(piece: number): void {
    if (this.isFinished() || this.pieces.length === 0) return;
    const target = clamp(Math.round(piece), 0, this.pieces.length - 1);
    this.flush(this.ctx.currentTime);
    if (this.active && this.active.piece !== target) this.supersede();
    this.nextIndex = target;
    this.continuing = false;
    this.metrics.lastSeek = { at: now(), piece: target, soundAt: null, latencyMs: null };
    if (this.status === 'paused') this.resume();
    else {
      this.pump();
      this.changed();
    }
  }

  /** Voice / speed for the pieces after the one playing now; applied once the value stops changing. */
  setVoiceAndSpeed(voice: string, speed: number): void {
    if (this.isFinished()) return;
    this.pendingSettings = { voice, speed };
    if (this.settingsTimer !== null) this.timers.clearTimeout(this.settingsTimer);
    this.settingsTimer = this.timers.setTimeout(() => {
      this.settingsTimer = null;
      this.applySettings();
    }, SETTINGS_DEBOUNCE_MS);
  }

  stop(): void {
    if (!this.isFinished()) this.finish('stopped');
  }

  /** Pieces with archived audio (for the WAV download), in document order. */
  archivedPieces(): number[] {
    return [...this.archive.keys()].sort((a, b) => a - b);
  }

  /** Everything generated so far (the archived pieces, in document order) as a 16-bit WAV file. */
  exportWav(): Blob | null {
    const order = this.archivedPieces();
    if (order.length === 0) return null;
    return encodeWav(
      order.map((i) => (this.archive.get(i) as Archived).samples),
      this.archiveRate,
    );
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  private pump(): void {
    if (this.isFinished()) return;
    const ctx = this.ctx;
    if (ctx.state === 'closed') {
      this.fail(new Error('The audio output was closed (the TTS engine was reset or disposed).'));
      return;
    }
    const t = ctx.currentTime;
    this.prune(t);
    if (this.status === 'paused') return;
    if (ctx.state !== 'running') {
      // Suspended by the browser (device change, autoplay policy), not by pause().
      ctx.resume().catch(() => undefined);
      if (++this.suspendedTicks >= SUSPENDED_TICKS) {
        this.status = 'paused';
        this.pausedReason = 'audio-suspended';
        this.changed();
      }
      return;
    }
    this.suspendedTicks = 0;

    // Archived audio first (seeking back, or a superseded request that finished anyway).
    while (!this.active && this.nextIndex < this.pieces.length && this.aheadSec(t) < this.readAheadSec) {
      const archived = this.archived(this.nextIndex);
      if (!archived) break;
      this.schedule(this.nextIndex, int16ToFloat(archived.samples), archived.sampleRate);
      this.nextIndex++;
    }
    if (!this.active && this.nextIndex < this.pieces.length && this.aheadSec(t) < this.readAheadSec) this.request(this.nextIndex);
    if (!this.active && this.nextIndex >= this.pieces.length && this.timeline.length === 0 && t >= this.queueEnd) this.finish('ended');
  }

  private aheadSec(t: number): number {
    return Math.max(0, this.queueEnd - t);
  }

  /** Drops finished entries from the timeline, counting them as played. */
  private prune(t: number): void {
    if (this.timeline.length === 0 || this.timeline[0].end > t) return;
    const keep: Scheduled[] = [];
    for (const e of this.timeline) {
      if (e.end <= t) {
        this.playedSec += e.end - e.start;
        e.source.disconnect();
      } else keep.push(e);
    }
    this.timeline = keep;
  }

  /** Stops all scheduled audio (seek, stop). */
  private flush(t: number): void {
    for (const e of this.timeline) {
      this.playedSec += clamp(t - e.start, 0, e.end - e.start);
      stopSource(e.source);
    }
    this.timeline = [];
    this.queueEnd = t;
  }

  private schedule(piece: number, samples: Float32Array, sampleRate: number): void {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const m = this.metrics;
    if (this.continuing) {
      const buffered = Math.max(0, this.queueEnd - t);
      m.minBufferedSec = m.minBufferedSec === null ? buffered : Math.min(m.minBufferedSec, buffered);
      m.maxBufferedSec = m.maxBufferedSec === null ? buffered : Math.max(m.maxBufferedSec, buffered);
    }
    if (samples.length === 0) return; // nothing to play (e.g. a piece of punctuation only)
    const when = Math.max(this.continuing ? this.queueEnd : t, t + SAFETY_LEAD_SEC);
    if (this.continuing && t >= this.queueEnd) {
      const gap = when - this.queueEnd;
      m.stalls++;
      m.stallSilenceSec += gap;
      m.longestStallSec = Math.max(m.longestStallSec, gap);
    }
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);
    source.start(when);
    const end = when + samples.length / sampleRate;
    this.timeline.push({ piece, start: when, end, source });
    this.queueEnd = end;
    if (!this.continuing) {
      const soundAt = contextTimeToMainClock(ctx, when);
      if (m.firstSoundAt === null) {
        m.firstSoundAt = soundAt;
        m.timeToFirstSoundMs = soundAt - m.startedAt;
      }
      if (m.lastSeek && m.lastSeek.soundAt === null) m.lastSeek = { ...m.lastSeek, soundAt, latencyMs: soundAt - m.lastSeek.at };
    }
    this.continuing = true;
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  private request(piece: number): void {
    let job: SynthesisJob;
    try {
      job = this.backend.synthesize(this.pieces[piece].text, { voice: this.voice, speed: this.speed });
    } catch (e) {
      this.fail(e);
      return;
    }
    const request: Request = { piece, voice: this.voice, speed: this.speed, job, requestedAt: now() };
    this.active = request;
    job.result.then(
      (result) => this.onResult(request, result),
      (error: unknown) => this.onError(request, error),
    );
    this.changed();
  }

  /** The active request is no longer wanted: skip it if it has not started, archive its audio if it has. */
  private supersede(): void {
    const request = this.active;
    if (!request) return;
    this.active = null;
    this.superseded.add(request);
    request.job.cancel();
  }

  private onResult(request: Request, result: SynthesisResult): void {
    const wasActive = this.active === request;
    if (wasActive) this.active = null;
    else this.superseded.delete(request);
    if (this.isFinished()) return;
    if (!result.skipped) {
      applySpeechLoudness(result.audio, result.sampleRate);
      this.record(request, result, !wasActive);
      this.store(request, result);
      if (wasActive && request.piece === this.nextIndex && request.voice === this.voice && request.speed === this.speed) {
        this.schedule(request.piece, result.audio, result.sampleRate);
        this.nextIndex++;
      }
    }
    this.pump();
    this.changed();
  }

  private onError(request: Request, error: unknown): void {
    if (this.active !== request) {
      this.superseded.delete(request); // a superseded request failing changes nothing
      return;
    }
    this.active = null;
    this.fail(error);
  }

  private record(request: Request, result: SynthesisResult, superseded: boolean): void {
    const audioSec = result.audio.length / result.sampleRate;
    const start = result.generationStart ?? result.requestedAt;
    const computeMs = result.generatedAt - start;
    const generation: PieceGeneration = {
      piece: request.piece,
      voice: request.voice,
      speed: request.speed,
      requestedAt: result.requestedAt,
      generationStart: start,
      generatedAt: result.generatedAt,
      computeMs,
      queueMs: start - result.requestedAt,
      audioSec,
      rtf: audioSec > 0 ? computeMs / 1000 / audioSec : null,
      inferences: result.inferences,
      overflowSplits: result.overflowSplits,
      truncated: result.truncated,
      superseded,
    };
    this.generations.push(generation);
    if (this.generations.length > KEPT_GENERATIONS) this.generations.shift();
    const totals = this.totals;
    totals.pieces++;
    if (superseded) totals.superseded++;
    totals.inferences += result.inferences;
    totals.overflowSplits += result.overflowSplits;
    if (result.truncated) totals.truncated++;
    totals.computeMs += computeMs;
    totals.audioSec += audioSec;
    if (audioSec > 0) {
      this.rate.chars += this.pieces[request.piece].chars;
      this.rate.sec += audioSec * request.speed;
    }
    const m = this.metrics;
    if (m.firstAudioGeneratedAt === null && !superseded) {
      m.firstAudioGeneratedAt = result.generatedAt;
      m.timeToFirstAudioMs = result.generatedAt - m.startedAt;
    }
  }

  private charsPerSecond(): number {
    return this.rate.sec > 5 ? this.rate.chars / this.rate.sec : DEFAULT_CHARS_PER_SEC;
  }

  // -------------------------------------------------------------------------
  // Archive
  // -------------------------------------------------------------------------

  private store(request: Request, result: SynthesisResult): void {
    if (this.archiveLimitSec <= 0 || result.audio.length === 0) return;
    const previous = this.archive.get(request.piece);
    if (previous) this.archivedSamples -= previous.samples.length;
    const samples = floatToInt16(result.audio);
    this.archive.set(request.piece, { samples, sampleRate: result.sampleRate, voice: request.voice, speed: request.speed });
    this.archivedSamples += samples.length;
    this.archiveRate = result.sampleRate;
    const limit = this.archiveLimitSec * result.sampleRate;
    while (this.archivedSamples > limit && this.archive.size > 1) {
      const victim = this.evictionCandidate(request.piece);
      const entry = this.archive.get(victim) as Archived;
      this.archive.delete(victim);
      this.archivedSamples -= entry.samples.length;
      this.evicted++;
    }
  }

  /** The archived piece farthest from the current position, preferring pieces already behind it. */
  private evictionCandidate(keep: number): number {
    const current = this.position().piece ?? this.nextIndex;
    let victim = -1;
    let worst = -Infinity;
    for (const index of this.archive.keys()) {
      if (index === keep) continue;
      const distance = index < current ? (current - index) * 2 : index - current;
      if (distance > worst) {
        worst = distance;
        victim = index;
      }
    }
    return victim;
  }

  private archived(piece: number): Archived | null {
    const entry = this.archive.get(piece);
    return entry && entry.voice === this.voice && entry.speed === this.speed ? entry : null;
  }

  // -------------------------------------------------------------------------
  // Settings, end, errors
  // -------------------------------------------------------------------------

  private applySettings(): void {
    const next = this.pendingSettings;
    this.pendingSettings = null;
    if (!next || this.isFinished() || (next.voice === this.voice && next.speed === this.speed)) return;
    this.voice = next.voice;
    this.speed = next.speed;
    const t = this.ctx.currentTime;
    this.prune(t);
    // Keep what is playing now; regenerate everything scheduled after it.
    const keep = this.timeline.filter((e) => e.start <= t);
    const drop = this.timeline.filter((e) => e.start > t);
    for (const e of drop) stopSource(e.source);
    this.timeline = keep;
    if (drop.length > 0) {
      this.nextIndex = drop[0].piece;
      this.queueEnd = keep.length > 0 ? keep[keep.length - 1].end : t;
    }
    if (this.active && (this.active.voice !== this.voice || this.active.speed !== this.speed)) this.supersede();
    this.pump();
    this.changed();
  }

  private isFinished(): boolean {
    return this.status === 'ended' || this.status === 'stopped' || this.status === 'error';
  }

  private fail(error: unknown): void {
    if (this.isFinished()) return;
    this.error = error instanceof Error ? error.message || error.name : String(error);
    this.finish('error');
  }

  private finish(status: 'ended' | 'stopped' | 'error'): void {
    if (this.tick !== null) this.timers.clearInterval(this.tick);
    if (this.settingsTimer !== null) this.timers.clearTimeout(this.settingsTimer);
    this.tick = null;
    this.settingsTimer = null;
    this.status = status;
    this.pausedReason = null;
    const t = this.ctx.state === 'closed' ? this.queueEnd : this.ctx.currentTime;
    this.flush(t);
    this.output.disconnect();
    this.active?.job.cancel();
    for (const request of this.superseded) request.job.cancel();
    this.active = null;
    this.superseded.clear();
    // The context is shared with the benchmark: do not leave it suspended by our pause.
    if (this.suspendedByUs && this.ctx.state === 'suspended') this.ctx.resume().catch(() => undefined);
    this.suspendedByUs = false;
    this.changed();
  }

  private changed(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error('Read-aloud listener threw', error);
      }
    }
  }

  private buildSnapshot(): ReaderSnapshot {
    const totals = this.totals;
    const recent = this.generations.filter((g) => !g.superseded && g.audioSec > 0).slice(-RECENT_GENERATIONS);
    const recentAudio = recent.reduce((s, g) => s + g.audioSec, 0);
    const recentCompute = recent.reduce((s, g) => s + g.computeMs, 0);
    return {
      status: this.status,
      pausedReason: this.pausedReason,
      error: this.error,
      voice: this.voice,
      speed: this.speed,
      metrics: {
        ...this.metrics,
        piecesGenerated: totals.pieces,
        supersededGenerations: totals.superseded,
        inferences: totals.inferences,
        overflowSplits: totals.overflowSplits,
        truncatedPieces: totals.truncated,
        generationComputeMs: totals.computeMs,
        generatedAudioSec: totals.audioSec,
        rtf: totals.audioSec > 0 ? totals.computeMs / 1000 / totals.audioSec : null,
        recentRtf: recentAudio > 0 ? recentCompute / 1000 / recentAudio : null,
        archive: {
          pieces: this.archive.size,
          seconds: this.archivedSamples / this.archiveRate,
          bytes: this.archivedSamples * 2,
          evicted: this.evicted,
        },
      },
      recent: this.generations.slice(-RECENT_GENERATIONS),
    };
  }
}

function stopSource(source: AudioBufferSourceNode): void {
  source.onended = null;
  try {
    source.stop();
  } catch {
    // Never started or already stopped; dropped either way.
  }
  source.disconnect();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

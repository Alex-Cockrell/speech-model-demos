/**
 * TranscriptionSession implementation (contract: ./session.ts): capture of every source on one AudioContext,
 * the shared LiveTranscriber, per-source levels, live stats, pause/resume, sources ending on their own.
 *
 * Stats and levels are driven by the audio callbacks (plus a 1 s timer for when no audio flows), not by timers
 * alone: Chrome throttles timers in background tabs, and the meeting tab usually is one while the call runs.
 */
import { now } from '@/lib/clock';
import { summarize } from '@/lib/stats';
import type { AsrSettings, AudioSourceKind, SessionStats } from '@/lib/types';
import { AudioCapture, openMicrophone, stopStreams, type CaptureInput } from './capture';
import { meanSquare } from './pcm';
import { ASR_SAMPLE_RATE } from './protocol';
import type { LiveSessionStats, SessionCallbacks, SessionSourceInput, TranscriptionSession } from './session';
import { LiveTranscriber, type PassRunner, type TranscriberLog, type TranscriberStats } from './transcriber';

const LEVEL_INTERVAL_SAMPLES = ASR_SAMPLE_RATE / 20;
const STATS_INTERVAL_MS = 1000;
const STATS_LOG_INTERVAL_MS = 30_000;

export type Segmentation = Pick<AsrSettings, 'partialIntervalMs' | 'minSilenceMs' | 'maxSegmentMs'>;

export interface LiveSessionParams {
  sources: readonly SessionSourceInput[];
  segmentation: Segmentation;
  runner: PassRunner;
  runTag: string;
  callbacks: SessionCallbacks;
  log: TranscriberLog;
  /** Called once when the session has stopped (or was aborted), so the engine accepts new work. */
  onClosed: () => void;
}

interface SourceState {
  kind: AudioSourceKind;
  stream: MediaStream;
  input: CaptureInput | null;
  /** Samples delivered by the capture so far, paused or not: the absolute position of the next sample. */
  delivered: number;
  ended: boolean;
  levelSum: number;
  levelCount: number;
}

const ENDED_REASON: Record<AudioSourceKind, string> = {
  mic: 'The microphone stopped (unplugged or disabled, or its permission was revoked).',
  system: 'Sharing stopped (from the browser’s sharing bar, or the shared tab or window was closed).',
};

export class LiveSession implements TranscriptionSession {
  readonly startedAt: number;
  readonly sources: readonly AudioSourceKind[];
  private readonly states = new Map<AudioSourceKind, SourceState>();
  private readonly core: LiveTranscriber;
  private capture: AudioCapture | null = null;
  private isPaused = false;
  /** Audio is still being taken in (false once stop() has flushed the capture). */
  private listening = true;
  private stopping: Promise<SessionStats> | null = null;
  private closed = false;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private lastStatsAt = -Infinity;
  private lastLogAt: number;

  /** Opens what is needed and starts listening. Owns the given streams: stops them when it ends or fails to start. */
  static async start(params: LiveSessionParams): Promise<LiveSession> {
    const streams: MediaStream[] = [];
    const opened: MediaStream[] = [];
    try {
      for (const source of params.sources) {
        let stream = source.stream;
        if (!stream) {
          stream = await openMicrophone();
          opened.push(stream);
        }
        if (source.kind === 'system') checkSystemStream(stream);
        streams.push(stream);
      }
      return await new LiveSession(params, streams).listen();
    } catch (err) {
      stopStreams([...params.sources.flatMap((source) => (source.stream ? [source.stream] : [])), ...opened]);
      throw err;
    }
  }

  private constructor(
    private readonly params: LiveSessionParams,
    streams: readonly MediaStream[],
  ) {
    this.sources = params.sources.map((source) => source.kind);
    this.startedAt = now();
    this.lastLogAt = this.startedAt;
    this.core = new LiveTranscriber(
      { sampleRate: ASR_SAMPLE_RATE, ...params.segmentation, origin: this.startedAt, runTag: params.runTag, now, log: params.log },
      params.runner,
      {
        onSegmentStart: (e) => this.params.callbacks.onSegmentStart?.({ segmentId: e.segmentId, source: e.source, startMs: e.startMs, at: e.at }),
        onPartial: (e) => this.params.callbacks.onPartial?.(e),
        onFinal: (e) => this.params.callbacks.onFinal?.(e),
        onError: (message) => this.params.callbacks.onError?.(message),
      },
    );
    params.sources.forEach((source, i) => {
      const state: SourceState = { kind: source.kind, stream: streams[i], input: null, delivered: 0, ended: false, levelSum: 0, levelCount: 0 };
      this.states.set(source.kind, state);
      this.core.addSource(source.kind, { timeAtSample: (index) => state.input?.timeAtSample(index) ?? now() });
    });
  }

  get paused(): boolean {
    return this.isPaused;
  }

  pause(): void {
    if (this.isPaused || this.stopping) return;
    this.isPaused = true;
    this.core.flushAll();
    for (const state of this.states.values()) {
      if (!state.ended) this.notify(() => this.params.callbacks.onLevel?.(state.kind, 0));
    }
    this.params.log.info('session paused');
  }

  resume(): void {
    if (!this.isPaused || this.stopping) return;
    this.isPaused = false;
    for (const state of this.states.values()) {
      if (!state.ended) this.core.restartSource(state.kind, state.delivered);
    }
    this.params.log.info('session resumed');
  }

  stop(): Promise<SessionStats> {
    this.stopping ??= this.finish();
    return this.stopping;
  }

  /** Ends the session at once (engine disposed): no more events, devices released. */
  abort(reason: string): void {
    if (this.closed) return;
    this.core.abandon();
    this.release();
    this.notify(() => this.params.callbacks.onError?.(reason));
    this.stopping ??= Promise.resolve(this.sessionStats(this.core.stats));
    this.close();
  }

  private async listen(): Promise<LiveSession> {
    const states = [...this.states.values()];
    this.capture = await AudioCapture.start(
      states.map((state) => state.stream),
      states.map((state) => (samples, input) => this.onAudio(state, samples, input)),
    );
    for (const state of states) {
      state.stream.getAudioTracks()[0]?.addEventListener('ended', () => this.sourceEnded(state));
    }
    this.statsTimer = setInterval(() => this.maybeStats(), STATS_INTERVAL_MS);
    const described = states.map((state) => `${state.kind} (${state.stream.getAudioTracks()[0]?.label || 'unnamed'})`).join(', ');
    const { partialIntervalMs, minSilenceMs, maxSegmentMs } = this.params.segmentation;
    this.params.log.info(
      `session started: ${described}; capture at ${this.capture.sampleRate} Hz; partial every ${partialIntervalMs} ms,` +
        ` pause ${minSilenceMs} ms ends a segment, max segment ${maxSegmentMs / 1000} s`,
    );
    return this;
  }

  private onAudio(state: SourceState, samples: Float32Array, input: CaptureInput): void {
    state.input ??= input;
    state.delivered += samples.length;
    if (this.isPaused || !this.listening || state.ended) return;
    this.core.push(state.kind, samples);

    state.levelSum += meanSquare(samples) * samples.length;
    state.levelCount += samples.length;
    if (state.levelCount >= LEVEL_INTERVAL_SAMPLES) {
      const rms = Math.min(1, Math.sqrt(state.levelSum / state.levelCount));
      state.levelSum = 0;
      state.levelCount = 0;
      this.notify(() => this.params.callbacks.onLevel?.(state.kind, rms));
    }
    this.maybeStats();
  }

  private sourceEnded(state: SourceState): void {
    if (state.ended || this.stopping) return;
    state.ended = true;
    state.input?.disconnect();
    this.core.removeSource(state.kind);
    stopStreams([state.stream]);
    this.params.log.warn(`${state.kind} source ended`);
    this.notify(() => this.params.callbacks.onLevel?.(state.kind, 0));
    this.notify(() => this.params.callbacks.onSourceEnded?.(state.kind, ENDED_REASON[state.kind]));
  }

  private async finish(): Promise<SessionStats> {
    try {
      try {
        // Delivers the audio still inside the worklets (pushed unless paused), then releases the devices.
        await this.capture?.flush();
      } catch (err) {
        console.warn('[asr] flushing the capture failed', err);
      }
      this.listening = false;
      this.release();
      this.core.flushAll();
      await this.core.drain();
      const stats = this.sessionStats(this.core.stats);
      this.params.log.info(`session stopped: ${describeStats(this.core.stats)}`);
      return stats;
    } finally {
      this.close();
    }
  }

  private release(): void {
    this.listening = false;
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.capture?.close();
    stopStreams([...this.states.values()].map((state) => state.stream));
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.params.onClosed();
  }

  private maybeStats(): void {
    const at = now();
    if (this.closed || at - this.lastStatsAt < STATS_INTERVAL_MS * 0.95) return;
    this.lastStatsAt = at;
    const s = this.core.stats;
    const live: LiveSessionStats = {
      at,
      elapsedMs: at - this.startedAt,
      audioMs: s.audioMs,
      asrComputeMs: s.computeMs,
      rtf: rtfOf(s),
      backlogMs: s.backlogMs,
      queueDepth: s.queueDepth,
      skippedPartials: s.skippedPartials,
      segments: s.segments,
    };
    this.notify(() => this.params.callbacks.onStats?.(live));
    if (at - this.lastLogAt >= STATS_LOG_INTERVAL_MS) {
      this.lastLogAt = at;
      this.params.log.info(`session ${Math.round(live.elapsedMs / 1000)} s: ${describeStats(s)}`);
    }
  }

  private sessionStats(s: TranscriberStats): SessionStats {
    return {
      audioMs: s.audioMs,
      asrComputeMs: s.computeMs,
      rtf: rtfOf(s),
      finalLatency: summarize(s.finalLatencies),
      maxBacklogMs: s.maxBacklogMs,
      skippedPartials: s.skippedPartials,
      segments: s.segments,
      speakerComputeMs: null,
    };
  }

  private notify(callback: () => void): void {
    try {
      callback();
    } catch (err) {
      console.error('[asr] session callback threw', err);
    }
  }
}

function checkSystemStream(stream: MediaStream): void {
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('The shared stream has no audio; share again with audio turned on.');
  if (track.readyState === 'ended') throw new Error('The shared audio has already ended; share again.');
}

function rtfOf(s: TranscriberStats): number | null {
  const audioMs = Object.values(s.audioMs).reduce((sum, ms) => sum + (ms ?? 0), 0);
  return audioMs > 0 ? s.computeMs / audioMs : null;
}

function describeStats(s: TranscriberStats): string {
  const audio = Object.entries(s.audioMs)
    .map(([kind, ms]) => `${kind} ${Math.round((ms ?? 0) / 1000)} s`)
    .join(', ');
  const rtf = rtfOf(s);
  const latency = summarize(s.finalLatencies);
  return (
    `audio ${audio || 'none'}; ASR ${Math.round(s.computeMs / 1000)} s (rtf ${rtf === null ? '–' : rtf.toFixed(3)}, ` +
    `${s.partialPasses} partial + ${s.passes - s.partialPasses} final passes); ${s.segments} segments, final latency median ` +
    `${latency.medianMs === null ? '–' : Math.round(latency.medianMs)} ms / max ${latency.maxMs === null ? '–' : Math.round(latency.maxMs)} ms; ` +
    `backlog ${Math.round(s.backlogMs)} ms (max ${Math.round(s.maxBacklogMs)}), queue ${s.queueDepth}, skipped partials ${s.skippedPartials}`
  );
}

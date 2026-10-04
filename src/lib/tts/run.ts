/**
 * One speak() run on the main thread: plays worker chunks as they arrive and assembles TtsRunMetrics.
 */
import { now, span } from '../clock';
import { intervalStats } from '../stats';
import type { TtsChunkRecord, TtsRunMetrics, TtsSettings } from '../types';
import type { TtsSpeakCallbacks } from './engine';
import { PlaybackQueue, audioOutputInfo, contextTimeToMainClock } from './playback';
import type { ChunkEvent, DoneEvent } from './protocol';

const WATCHDOG_INTERVAL_MS = 1000;
/** Consecutive watchdog ticks with a non-running AudioContext before the run fails instead of waiting forever. */
const MAX_STALLED_TICKS = 5;
/** Grace period after the last chunk should have finished before 'ended' is considered lost. */
const ENDED_GRACE_SEC = 1;

export interface SpeakRunInit {
  id: number;
  ctx: AudioContext;
  text: string;
  settings: TtsSettings;
  callbacks: TtsSpeakCallbacks;
}

export class SpeakRun {
  readonly id: number;
  /** Settles once: resolves after playback completes, rejects on failure or stop. */
  readonly result: Promise<TtsRunMetrics>;
  private readonly ctx: AudioContext;
  private readonly text: string;
  private readonly settings: TtsSettings;
  private readonly callbacks: TtsSpeakCallbacks;
  private readonly queue: PlaybackQueue;
  private readonly chunks: TtsChunkRecord[] = [];
  private ttsStart = 0;
  private firstPlaybackStartAt: number | null = null;
  private generationCompleteAt: number | null = null;
  private generationDone = false;
  private settled = false;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private stalledTicks = 0;
  private resolveResult!: (metrics: TtsRunMetrics) => void;
  private rejectResult!: (error: Error) => void;

  constructor(init: SpeakRunInit) {
    this.id = init.id;
    this.ctx = init.ctx;
    this.text = init.text;
    this.settings = init.settings;
    this.callbacks = init.callbacks;
    this.result = new Promise<TtsRunMetrics>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    this.queue = new PlaybackQueue(init.ctx);
    this.queue.onIdle = () => {
      if (this.generationDone) this.complete();
    };
  }

  /** Records ttsStart. Call immediately before posting the text to the worker. */
  begin(): void {
    this.watchdog = setInterval(() => this.checkPlayback(), WATCHDOG_INTERVAL_MS);
    this.ttsStart = now();
  }

  onChunk(event: ChunkEvent): void {
    if (this.settled) return;
    const record = this.queue.enqueue({
      index: event.index,
      text: event.text,
      generationStart: event.generationStart,
      generatedAt: event.generatedAt,
      samples: event.audio,
      sampleRate: event.sampleRate,
    });
    this.chunks.push(record);
    if (this.firstPlaybackStartAt === null && record.audioDurationMs > 0) {
      const at = record.scheduledPlaybackAt;
      this.firstPlaybackStartAt = at;
      this.startTimer = setTimeout(() => this.firePlaybackStart(), Math.max(0, at - now()));
    }
    notify(() => this.callbacks.onChunk?.(record));
  }

  onDone(event: DoneEvent): void {
    if (this.settled) return;
    this.generationCompleteAt = event.generationCompleteAt;
    this.generationDone = true;
    if (this.queue.scheduledCount === 0) this.fail(new Error('Kokoro produced no audio for this text.'));
    else if (this.queue.playingCount === 0) this.complete();
  }

  /** Stops playback and rejects the run. No-op once settled. */
  fail(error: Error): void {
    if (!this.settle()) return;
    this.rejectResult(error);
  }

  private complete(): void {
    if (this.settled) return;
    // Fire a pending onPlaybackStart first so callers always see it before the run resolves.
    if (this.startTimer !== null) this.firePlaybackStart();
    // The audible end of the last chunk, mapped like the start times; 'ended' only signals that it happened.
    const playbackCompleteAt = contextTimeToMainClock(this.ctx, this.queue.endTime);
    this.settle();
    this.resolveResult(
      buildRunMetrics({
        ttsStart: this.ttsStart,
        chunks: this.chunks,
        firstPlaybackStartAt: this.firstPlaybackStartAt,
        generationCompleteAt: this.generationCompleteAt,
        playbackCompleteAt,
        audioOutput: audioOutputInfo(this.ctx),
        text: this.text,
        settings: this.settings,
      }),
    );
  }

  private settle(): boolean {
    if (this.settled) return false;
    this.settled = true;
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.startTimer = null;
    this.watchdog = null;
    this.queue.stop();
    return true;
  }

  private firePlaybackStart(): void {
    if (this.startTimer !== null) clearTimeout(this.startTimer);
    this.startTimer = null;
    const at = this.firstPlaybackStartAt;
    if (at !== null) notify(() => this.callbacks.onPlaybackStart?.(at));
  }

  /** Guards against waiting forever on audio that cannot play (suspended/closed context, lost 'ended'). */
  private checkPlayback(): void {
    const state = this.ctx.state;
    if (state === 'closed') {
      this.fail(new Error('The AudioContext was closed during TTS playback.'));
      return;
    }
    if (state !== 'running') {
      this.ctx.resume().catch(() => undefined);
      if (++this.stalledTicks >= MAX_STALLED_TICKS) {
        this.fail(
          new Error(`TTS playback stalled: the AudioContext is "${state}". Call unlockAudio() from a user gesture and retry.`),
        );
      }
      return;
    }
    this.stalledTicks = 0;
    if (this.generationDone && this.ctx.currentTime > this.queue.endTime + ENDED_GRACE_SEC) this.complete();
  }
}

interface RunMetricsInput {
  ttsStart: number;
  chunks: TtsChunkRecord[];
  firstPlaybackStartAt: number | null;
  generationCompleteAt: number | null;
  playbackCompleteAt: number | null;
  audioOutput: TtsRunMetrics['audioOutput'];
  text: string;
  settings: TtsSettings;
}

export function buildRunMetrics(input: RunMetricsInput): TtsRunMetrics {
  const { chunks, ttsStart, firstPlaybackStartAt } = input;
  const first = chunks.find((c) => c.audioDurationMs > 0) ?? chunks[0] ?? null;
  // minBufferedMs / maxBufferedMs: over every chunk after the first audible one, the audio still queued ahead
  // of the playhead when that chunk arrived (before it was appended). The minimum is how close playback came
  // to running dry (0 = it did); the maximum is how far generation got ahead of playback. null with < 2 chunks.
  const levels = first ? chunks.filter((c) => c.index > first.index).map((c) => c.bufferedAheadMs) : [];
  const generationComputeMs = sum(chunks.map((c) => c.generationMs));
  const generatedAudioMs = sum(chunks.map((c) => c.audioDurationMs));
  return {
    ttsStart,
    firstAudioGeneratedAt: first?.generatedAt ?? null,
    firstPlaybackStartAt,
    generationCompleteAt: input.generationCompleteAt,
    playbackCompleteAt: input.playbackCompleteAt,
    timeToFirstAudioMs: span(ttsStart, first?.generatedAt),
    timeToFirstSpeechMs: span(ttsStart, firstPlaybackStartAt),
    chunks,
    chunkIntervals: intervalStats(chunks.map((c) => c.generatedAt)),
    bufferUnderruns: chunks.filter((c) => c.underrun).length,
    audiblePauseMs: sum(chunks.map((c) => c.gapMs)),
    minBufferedMs: levels.length > 0 ? Math.min(...levels) : null,
    maxBufferedMs: levels.length > 0 ? Math.max(...levels) : null,
    generationComputeMs,
    generatedAudioMs,
    generationRtf: generatedAudioMs > 0 ? generationComputeMs / generatedAudioMs : null,
    audioOutput: input.audioOutput,
    text: input.text,
    settings: input.settings,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

/** UI callbacks must not break playback bookkeeping. */
function notify(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    console.error('TTS callback threw', error);
  }
}

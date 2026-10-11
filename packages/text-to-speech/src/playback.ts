/**
 * Gapless Web Audio playback of streamed PCM chunks, with per-chunk continuity measurements (spec §10).
 * Main thread only.
 */
import { now } from '@local-speech/core';
import type { TtsChunkRecord, TtsRunMetrics } from './types.js';
import { applySpeechLoudness, speechOutput } from './output.js';

/**
 * Lead used when a chunk has to start "now" (the first chunk, or after the queue drained). start() takes effect
 * at a render-quantum boundary and the audio thread may already be one OS callback (~10 ms) past the
 * currentTime the main thread sees, so starting sooner could begin late and make scheduledPlaybackAt optimistic.
 */
export const SAFETY_LEAD_SEC = 0.02;

export interface PcmChunk {
  index: number;
  text: string;
  generationStart: number;
  generatedAt: number;
  samples: Float32Array;
  sampleRate: number;
}

/**
 * Schedules chunks back to back on one AudioContext and records how continuous playback was.
 *
 * Definitions, in context-clock seconds (records hold milliseconds). "Previous" means a chunk with audio
 * was already scheduled in this run, i.e. index > 0 in practice:
 *   queueEnd       context time at which the audio queued so far runs out
 *   bufferedAhead  max(0, queueEnd − currentTime) when a chunk arrives, before it is appended (0 for the first)
 *   underrun       a previous chunk exists and currentTime ≥ queueEnd on arrival: playback had drained
 *   when           max(queueEnd, currentTime + SAFETY_LEAD_SEC); just currentTime + lead for the first chunk
 *   gap            when − queueEnd, the silence inserted before the chunk (0 for the first). Positive on an
 *                  underrun, and also (below SAFETY_LEAD_SEC, without an underrun) when the chunk arrived
 *                  just before the queue would have drained.
 */
export class PlaybackQueue {
  private readonly ctx: AudioContext;
  private readonly output: GainNode;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private queueEnd = 0;
  private audibleChunks = 0;
  /** Called whenever the last scheduled source has finished — also between chunks after an underrun. */
  onIdle: (() => void) | null = null;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.connect(speechOutput(ctx));
  }

  /** Chunks with audio scheduled so far. */
  get scheduledCount(): number {
    return this.audibleChunks;
  }

  /** Sources scheduled or still playing. */
  get playingCount(): number {
    return this.sources.size;
  }

  /** Context time at which all scheduled audio has played. */
  get endTime(): number {
    return this.queueEnd;
  }

  enqueue(chunk: PcmChunk): TtsChunkRecord {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const hasPrevious = this.audibleChunks > 0;
    const durationSec = chunk.samples.length / chunk.sampleRate;
    const base = {
      index: chunk.index,
      text: chunk.text,
      generationStart: chunk.generationStart,
      generatedAt: chunk.generatedAt,
      generationMs: chunk.generatedAt - chunk.generationStart,
      audioDurationMs: durationSec * 1000,
      bufferedAheadMs: hasPrevious ? Math.max(0, this.queueEnd - t) * 1000 : 0,
    };
    if (chunk.samples.length === 0) {
      // Nothing to play, so nothing can be late; the record only keeps the chunk timings.
      const at = hasPrevious ? Math.max(this.queueEnd, t) : t;
      return { ...base, scheduledPlaybackAt: contextTimeToMainClock(ctx, at), underrun: false, gapMs: 0 };
    }

    const when = Math.max(hasPrevious ? this.queueEnd : t, t + SAFETY_LEAD_SEC);
    const record: TtsChunkRecord = {
      ...base,
      scheduledPlaybackAt: contextTimeToMainClock(ctx, when),
      underrun: hasPrevious && t >= this.queueEnd,
      gapMs: hasPrevious ? (when - this.queueEnd) * 1000 : 0,
    };

    applySpeechLoudness(chunk.samples, chunk.sampleRate);
    const buffer = ctx.createBuffer(1, chunk.samples.length, chunk.sampleRate);
    buffer.getChannelData(0).set(chunk.samples);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      if (this.sources.size === 0) this.onIdle?.();
    };
    source.start(when);
    this.sources.add(source);
    this.queueEnd = when + durationSec;
    this.audibleChunks++;
    return record;
  }

  /** Silences everything scheduled and releases the nodes. */
  stop(): void {
    this.onIdle = null;
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped; the source is dropped either way.
      }
    }
    this.sources.clear();
    this.output.disconnect();
  }
}

/**
 * Main-clock time (performance.now() timeline) at which context time `t` reaches the speakers.
 * getOutputTimestamp() pairs the device's output position with a performance.now() value, so output latency
 * is included. Before the context has produced output (or where unsupported) fall back to currentTime plus
 * the reported output latency.
 */
export function contextTimeToMainClock(ctx: AudioContext, t: number): number {
  const stamp = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
  if (stamp?.performanceTime && stamp.contextTime !== undefined) {
    return stamp.performanceTime + (t - stamp.contextTime) * 1000;
  }
  const latencySec = finite(ctx.outputLatency) ?? finite(ctx.baseLatency) ?? 0;
  return now() + (t - ctx.currentTime + latencySec) * 1000;
}

export function audioOutputInfo(ctx: AudioContext): TtsRunMetrics['audioOutput'] {
  const base = finite(ctx.baseLatency);
  const output = finite(ctx.outputLatency);
  return {
    contextSampleRate: ctx.sampleRate,
    baseLatencyMs: base === null ? null : base * 1000,
    outputLatencyMs: output === null ? null : output * 1000,
  };
}

/** baseLatency / outputLatency are missing in some browsers despite the DOM typings. */
function finite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

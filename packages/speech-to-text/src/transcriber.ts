/**
 * Live transcription core shared by the meeting session and the benchmark recording: one SpeechSegmenter per
 * source, at most one inference pass at a time on the shared ASR worker, and the stats. No browser APIs: audio
 * comes in through push(), passes go out through a PassRunner, results come back as session.ts events.
 *
 * Scheduling, re-evaluated whenever audio arrives or a pass completes:
 *  1. Finals first, oldest first across all sources: a final starts as soon as the worker is free, so it waits
 *     for at most one partial pass.
 *  2. Otherwise one partial pass: a segment that has no text yet goes first (first text matters most), then the
 *     one whose partial is most overdue (fair across sources). A partial is due when the segment commits and then
 *     partialIntervalMs after the previous one was started. It only runs when the segment has speech the previous
 *     partial did not hear, and not while that segment sits in a pause of ≥ 200 ms (its final is probably next).
 *     Nor does it start when another source's segment is pausing and would close before the partial (estimated
 *     from recent partial passes) could finish: that final would have to wait for it.
 *  3. After a partial pass that took d ms, no further partial starts for another d ms (a segment's first one
 *     excepted). Partials therefore take at most about half of the time on a machine that cannot keep up (CPU left
 *     for the call app); finals are never held back.
 * A partial whose segment ended while it ran is dropped. A due partial that cannot run counts as one skipped pass
 * per partialIntervalMs it waits.
 *
 * Errors: a failed partial is reported (onError) and the next one tries again; a failed final keeps the segment's
 * last partial text. A fatal error (the worker is gone) stops inference: every segment is then finalized with
 * whatever partial text it had.
 */
import type { AudioSourceKind, TranscriptWord } from './types.js';
import { describeError, type PassKind, type PassResult, type PassWord } from './protocol.js';
import { SpeechSegmenter, type ClosedSegment, type SegmentEvent } from './segmenter.js';
import type { SegmentFinalEvent, SegmentPartialEvent, SegmentStartEvent } from './session.js';

const PAUSE_HOLD_MS = 200;
/** Idle time after a partial pass, relative to its duration. */
const PARTIAL_COOLDOWN = 1;
/** Smoothing of the partial-pass cost estimate (ms of inference per ms of audio). */
const COST_SMOOTHING = 0.3;
const ERROR_REPEAT_MS = 10_000;

/** Runs one inference pass. Rejections with `fatal: true` mean no further pass can succeed. */
export interface PassRunner {
  run(kind: PassKind, audio: Float32Array<ArrayBuffer>, growKey: string | null): Promise<PassResult>;
}

export interface SourceClock {
  /** Main-clock time (now()) at which sample `index` of this source was captured. */
  timeAtSample(index: number): number;
}

export interface TranscriberOptions {
  sampleRate: number;
  partialIntervalMs: number;
  minSilenceMs: number;
  maxSegmentMs: number;
  /** Main-clock time that startMs / endMs are relative to. */
  origin: number;
  /** Unique per recording or session: namespaces the worker's mel-cache keys. */
  runTag: string;
  now: () => number;
  log?: TranscriberLog;
}

export interface TranscriberLog {
  info(message: string): void;
  debug(message: string): void;
  warn(message: string): void;
}

/** onSegmentStart plus the onset (benchmark speechStart). */
export interface CoreSegmentStart extends SegmentStartEvent {
  /** Main-clock time of the first speech frame (the segment's audio starts 300 ms earlier). */
  onsetAt: number;
}

export interface TranscriberEvents {
  onSegmentStart?: (e: CoreSegmentStart) => void;
  onPartial?: (e: SegmentPartialEvent) => void;
  onFinal?: (e: SegmentFinalEvent) => void;
  onError?: (message: string) => void;
}

export interface TranscriberStats {
  audioMs: Partial<Record<AudioSourceKind, number>>;
  /** All inference time (partials + finals). */
  computeMs: number;
  partialComputeMs: number;
  finalComputeMs: number;
  /** Passes started (partials + finals). */
  passes: number;
  partialPasses: number;
  firstPassAt: number | null;
  skippedPartials: number;
  /** Partial results dropped because their segment had ended. */
  stalePartials: number;
  /** Audio of ended segments waiting for (or in) their final pass. */
  backlogMs: number;
  maxBacklogMs: number;
  /** Finals waiting for or in inference. */
  queueDepth: number;
  /** Finals delivered. */
  segments: number;
  /** End of speech → final delivered, per segment. */
  finalLatencies: number[];
}

interface SourceState {
  kind: AudioSourceKind;
  clock: SourceClock;
  segmenter: SpeechSegmenter;
  segment: Segment | null;
}

interface Segment {
  id: string;
  source: SourceState;
  growKey: string;
  startSample: number;
  /** False once the segmenter has closed it. */
  open: boolean;
  partialDueAt: number;
  /** Audio length the latest partial was started on. */
  partialSamples: number;
  /** Latest partial text (also the fallback when the final fails). */
  partialText: string;
  closed: ClosedSegment | null;
  closedAt: number;
  /** Main-clock end of speech (latency reference). */
  speechEndAt: number;
}

interface Pass {
  kind: 'partial' | 'final';
  segment: Segment;
  startedAt: number;
  samples: number;
}

export class LiveTranscriber {
  private readonly sources = new Map<AudioSourceKind, SourceState>();
  private readonly audioSamples: Partial<Record<AudioSourceKind, number>> = {};
  private readonly finals: Segment[] = [];
  private inflight: Pass | null = null;
  private partialCooldownUntil = -Infinity;
  /** Recent partial passes: inference ms per audio ms (null until the first one). */
  private partialCost: number | null = null;
  private segmentNo = 0;
  private dead = false;
  private abandoned = false;
  private idleWaiters: (() => void)[] = [];
  private lastError: { message: string; at: number } | null = null;
  private readonly s = {
    computeMs: 0,
    partialComputeMs: 0,
    finalComputeMs: 0,
    passes: 0,
    partialPasses: 0,
    firstPassAt: null as number | null,
    skippedPartials: 0,
    stalePartials: 0,
    maxBacklogMs: 0,
    segments: 0,
    finalLatencies: [] as number[],
  };

  constructor(
    private readonly options: TranscriberOptions,
    private readonly runner: PassRunner,
    private readonly events: TranscriberEvents,
  ) {}

  addSource(kind: AudioSourceKind, clock: SourceClock, startSample = 0): void {
    if (this.sources.has(kind)) throw new Error(`The ${kind} source was added twice.`);
    const { sampleRate, minSilenceMs, maxSegmentMs } = this.options;
    this.sources.set(kind, { kind, clock, segmenter: new SpeechSegmenter({ sampleRate, minSilenceMs, maxSegmentMs }, startSample), segment: null });
    this.audioSamples[kind] ??= 0;
  }

  /** 16 kHz samples of `kind`, in order and without gaps (see restartSource for gaps). */
  push(kind: AudioSourceKind, samples: Float32Array): void {
    const source = this.sources.get(kind);
    if (!source || this.abandoned) return;
    this.audioSamples[kind] = (this.audioSamples[kind] ?? 0) + samples.length;
    this.handle(source, source.segmenter.push(samples));
    this.pump();
  }

  /** Ends the source's open segment now (its final is queued); the source keeps listening after a restart. */
  flushSource(kind: AudioSourceKind): void {
    const source = this.sources.get(kind);
    if (!source || this.abandoned) return;
    const closed = source.segmenter.end();
    if (closed) this.close(source, closed);
    this.pump();
  }

  /** After a gap (pause): forget the source's state and continue at absolute sample `position`. */
  restartSource(kind: AudioSourceKind, position: number): void {
    const source = this.sources.get(kind);
    if (!source) return;
    if (source.segment) this.flushSource(kind);
    source.segmenter.restart(position);
  }

  /** Flushes and forgets the source (its stream ended). */
  removeSource(kind: AudioSourceKind): void {
    this.flushSource(kind);
    this.sources.delete(kind);
  }

  flushAll(): void {
    for (const kind of [...this.sources.keys()]) this.flushSource(kind);
  }

  /** Resolves once every queued final has been delivered and no pass is running. */
  drain(): Promise<void> {
    if (this.idle) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Stop delivering anything (cancelled run); a running pass finishes in the worker and is ignored. */
  abandon(): void {
    this.abandoned = true;
    this.finals.length = 0;
    this.sources.clear();
    this.resolveIdle();
  }

  get stats(): TranscriberStats {
    const audioMs: Partial<Record<AudioSourceKind, number>> = {};
    for (const [kind, samples] of Object.entries(this.audioSamples) as [AudioSourceKind, number][]) {
      audioMs[kind] = this.ms(samples);
    }
    const s = this.s;
    return {
      audioMs,
      computeMs: s.computeMs,
      partialComputeMs: s.partialComputeMs,
      finalComputeMs: s.finalComputeMs,
      passes: s.passes,
      partialPasses: s.partialPasses,
      firstPassAt: s.firstPassAt,
      skippedPartials: s.skippedPartials,
      stalePartials: s.stalePartials,
      backlogMs: this.backlogMs(),
      maxBacklogMs: s.maxBacklogMs,
      queueDepth: this.finals.length + (this.inflight?.kind === 'final' ? 1 : 0),
      segments: s.segments,
      finalLatencies: [...s.finalLatencies],
    };
  }

  private get idle(): boolean {
    return this.abandoned || (this.inflight === null && this.finals.length === 0);
  }

  private get log(): TranscriberLog {
    return this.options.log ?? SILENT;
  }

  private ms(samples: number): number {
    return (samples / this.options.sampleRate) * 1000;
  }

  private sessionMs(source: SourceState, sample: number): number {
    return Math.max(0, Math.round(source.clock.timeAtSample(sample) - this.options.origin));
  }

  // ---------------------------------------------------------------------------
  // Segments
  // ---------------------------------------------------------------------------

  private handle(source: SourceState, events: SegmentEvent[]): void {
    for (const event of events) {
      if (event.type === 'start') this.open(source, event.startSample, event.onsetSample);
      else this.close(source, event.segment);
    }
  }

  private open(source: SourceState, startSample: number, onsetSample: number): void {
    const at = this.options.now();
    const id = `seg-${++this.segmentNo}`;
    const segment: Segment = {
      id,
      source,
      growKey: `${this.options.runTag}/${id}`,
      startSample,
      open: true,
      partialDueAt: at,
      partialSamples: 0,
      partialText: '',
      closed: null,
      closedAt: at,
      speechEndAt: at,
    };
    source.segment = segment;
    const startMs = this.sessionMs(source, startSample);
    const floor = source.segmenter.floorDb;
    this.log.info(
      `${source.kind} ${id} opened at ${seconds(startMs)} (speech from ${seconds(this.sessionMs(source, onsetSample))}` +
        `${floor === null ? '' : `, noise floor ${floor.toFixed(0)} dBFS`})`,
    );
    notify(() =>
      this.events.onSegmentStart?.({ segmentId: id, source: source.kind, startMs, at, onsetAt: source.clock.timeAtSample(onsetSample) }),
    );
  }

  private close(source: SourceState, closed: ClosedSegment): void {
    const segment = source.segment;
    if (!segment) return;
    source.segment = null;
    segment.open = false;
    segment.closed = closed;
    segment.closedAt = this.options.now();
    segment.speechEndAt = source.clock.timeAtSample(closed.speechEndSample);
    this.log.info(
      `${source.kind} ${segment.id} closed (${closed.reason}) at ${seconds(this.sessionMs(source, closed.startSample + closed.audio.length))}: ` +
        `${seconds(this.ms(closed.audio.length))} of audio, ${seconds(closed.speechMs)} of speech`,
    );
    if (this.dead) {
      this.deliverFinal(segment, segment.partialText, null, 0);
      return;
    }
    this.finals.push(segment);
    this.s.maxBacklogMs = Math.max(this.s.maxBacklogMs, this.backlogMs());
  }

  /**
   * Ended speech still waiting behind the pass in flight. The segment being finalized right now is not counted:
   * otherwise a single 20 s monologue would read as "20 s behind" while its 200 ms final pass runs, and the
   * meeting's can't-keep-up warning would fire on fast machines.
   */
  private backlogMs(): number {
    let samples = 0;
    for (const segment of this.finals) samples += segment.closed?.audio.length ?? 0;
    return this.ms(samples);
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  private pump(): void {
    if (this.abandoned) return;
    const at = this.options.now();
    this.holdIneligiblePartials(at);
    if (this.inflight || this.dead) {
      if (this.idle) this.resolveIdle();
      return;
    }
    const final = this.finals.shift();
    if (final?.closed) {
      // A copy goes to the worker; the original is handed to onFinal.
      this.start('final', final, final.closed.audio.slice(), at);
      return;
    }
    const partial = this.pickPartial(at);
    if (partial) {
      const { segment, audio } = partial;
      const interval = this.options.partialIntervalMs;
      this.s.skippedPartials += Math.max(0, Math.floor((at - segment.partialDueAt) / interval));
      segment.partialDueAt = at + interval;
      segment.partialSamples = audio.length;
      this.start('partial', segment, audio.slice(), at);
      return;
    }
    this.resolveIdle();
  }

  /** A partial held back by policy (nothing new to hear, or a pause) is not "skipped": restart its clock. */
  private holdIneligiblePartials(at: number): void {
    for (const source of this.sources.values()) {
      const segment = source.segment;
      if (segment && at >= segment.partialDueAt && !this.partialEligible(source, segment)) segment.partialDueAt = at;
    }
  }

  private partialEligible(source: SourceState, segment: Segment): boolean {
    const current = source.segmenter.current;
    if (!current) return false;
    const heard = segment.startSample + segment.partialSamples;
    return current.lastSpeechEnd > heard && current.trailingSilenceMs < PAUSE_HOLD_MS;
  }

  private pickPartial(at: number): { segment: Segment; audio: Float32Array<ArrayBuffer> } | null {
    // A segment's first partial (short, and the first text anyone sees of it) is exempt from the cooldown.
    const coolingDown = at < this.partialCooldownUntil;
    let best: { segment: Segment; audio: Float32Array<ArrayBuffer> } | null = null;
    for (const source of this.sources.values()) {
      const segment = source.segment;
      const current = source.segmenter.current;
      if (!segment || !current || at < segment.partialDueAt || !this.partialEligible(source, segment)) continue;
      if (coolingDown && segment.partialSamples > 0) continue;
      if (!best || partialOrder(segment, best.segment) < 0) best = { segment, audio: current.audio };
    }
    if (best && this.partialCost !== null && this.partialCost * this.ms(best.audio.length) > this.untilNextClose()) return null;
    return best;
  }

  /** How long until the earliest pausing segment closes if its pause goes on (Infinity when none is pausing). */
  private untilNextClose(): number {
    let soonest = Infinity;
    for (const source of this.sources.values()) {
      const current = source.segmenter.current;
      if (source.segment && current && current.trailingSilenceMs >= PAUSE_HOLD_MS) {
        soonest = Math.min(soonest, this.options.minSilenceMs - current.trailingSilenceMs);
      }
    }
    return soonest;
  }

  private start(kind: 'partial' | 'final', segment: Segment, audio: Float32Array<ArrayBuffer>, at: number): void {
    const pass: Pass = { kind, segment, startedAt: at, samples: audio.length };
    this.inflight = pass;
    this.s.passes++;
    if (kind === 'partial') this.s.partialPasses++;
    this.s.firstPassAt ??= at;
    let running: Promise<PassResult>;
    try {
      running = this.runner.run(kind, audio, segment.growKey);
    } catch (err) {
      running = Promise.reject(err);
    }
    running.then(
      (result) => this.completed(pass, result),
      (err: unknown) => this.failed(pass, err),
    );
  }

  private completed(pass: Pass, result: PassResult): void {
    if (this.abandoned || this.inflight !== pass) return;
    this.inflight = null;
    const at = this.options.now();
    const { segment } = pass;
    const audioMs = this.ms(pass.samples);
    const waitedMs = at - pass.startedAt - result.computeMs;
    this.s.computeMs += result.computeMs;
    const mel = result.melPrefixSamples > 0 ? `, mel reused ${seconds(this.ms(result.melPrefixSamples))}` : '';
    if (pass.kind === 'partial') {
      this.s.partialComputeMs += result.computeMs;
      this.partialCooldownUntil = at + result.computeMs * PARTIAL_COOLDOWN;
      const cost = result.computeMs / audioMs;
      this.partialCost = this.partialCost === null ? cost : this.partialCost + COST_SMOOTHING * (cost - this.partialCost);
      const stale = !segment.open;
      this.log.debug(
        `partial ${segment.id}: ${seconds(audioMs)} in ${Math.round(result.computeMs)} ms` +
          ` (rtf ${(result.computeMs / audioMs).toFixed(3)}${mel}, +${Math.round(waitedMs)} ms overhead)${stale ? ', dropped: its segment ended' : ''}`,
      );
      if (stale) {
        this.s.stalePartials++;
        segment.partialText = result.text;
      } else if (result.text !== segment.partialText) {
        segment.partialText = result.text;
        const event: SegmentPartialEvent = {
          segmentId: segment.id,
          source: segment.source.kind,
          startMs: this.sessionMs(segment.source, segment.startSample),
          text: result.text,
          at,
        };
        notify(() => this.events.onPartial?.(event));
      }
    } else {
      this.s.finalComputeMs += result.computeMs;
      const latency = at - segment.speechEndAt;
      this.log.info(
        `final ${segment.id}: ${seconds(audioMs)} in ${Math.round(result.computeMs)} ms (rtf ${(result.computeMs / audioMs).toFixed(3)}${mel}),` +
          ` waited ${Math.round(pass.startedAt - segment.closedAt)} ms for the worker, ${Math.round(latency)} ms after the end of speech: ${preview(result.text)}`,
      );
      this.deliverFinal(segment, result.text, result.words, result.computeMs);
    }
    this.pump();
  }

  private failed(pass: Pass, err: unknown): void {
    if (this.abandoned || this.inflight !== pass) return;
    this.inflight = null;
    const message = describeError(err);
    if (isFatal(err)) {
      if (pass.kind === 'final') this.deliverFinal(pass.segment, pass.segment.partialText, null, 0);
      this.die(message);
      this.resolveIdle();
      return;
    }
    if (pass.kind === 'final') {
      this.report(`Transcribing a segment failed (${message}); its live text was kept.`);
      this.deliverFinal(pass.segment, pass.segment.partialText, null, 0);
    } else {
      this.report(`Updating the live text failed: ${message}`);
    }
    this.pump();
  }

  private die(message: string): void {
    if (this.dead) return;
    this.dead = true;
    this.report(`Transcription stopped: ${message}`);
    for (const segment of this.finals.splice(0)) this.deliverFinal(segment, segment.partialText, null, 0);
  }

  private deliverFinal(segment: Segment, text: string, words: PassWord[] | null, computeMs: number): void {
    const closed = segment.closed;
    if (!closed) return;
    const at = this.options.now();
    const startMs = this.sessionMs(segment.source, closed.startSample);
    const latencyMs = at - segment.speechEndAt;
    this.s.segments++;
    this.s.finalLatencies.push(latencyMs);
    const event: SegmentFinalEvent = {
      segmentId: segment.id,
      source: segment.source.kind,
      startMs,
      endMs: Math.round(startMs + this.ms(closed.audio.length)),
      text,
      words: words ? words.map((word) => transcriptWord(word, startMs)) : null,
      audio: closed.audio,
      computeMs,
      latencyMs,
      at,
    };
    segment.closed = null;
    notify(() => this.events.onFinal?.(event));
  }

  private report(message: string): void {
    const at = this.options.now();
    const last = this.lastError;
    if (last && last.message === message && at - last.at < ERROR_REPEAT_MS) return;
    this.lastError = { message, at };
    this.log.warn(message);
    notify(() => this.events.onError?.(message));
  }

  private resolveIdle(): void {
    if (!this.idle) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

const SILENT: TranscriberLog = { info: () => undefined, debug: () => undefined, warn: () => undefined };

/** Negative when `a` should get the next partial pass before `b`. */
function partialOrder(a: Segment, b: Segment): number {
  const aFirst = a.partialSamples === 0;
  const bFirst = b.partialSamples === 0;
  if (aFirst !== bFirst) return aFirst ? -1 : 1;
  return a.partialDueAt - b.partialDueAt;
}

function isFatal(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { fatal?: unknown }).fatal === true;
}

function transcriptWord(word: PassWord, segmentStartMs: number): TranscriptWord {
  return {
    text: word.text,
    startMs: segmentStartMs + word.startMs,
    endMs: segmentStartMs + word.endMs,
    confidence: word.confidence,
  };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}

function preview(text: string): string {
  const trimmed = text.trim();
  return trimmed === '' ? '(empty)' : `"${trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed}"`;
}

/** Consumer callbacks must not break capture or scheduling. */
function notify(callback: () => void): void {
  try {
    callback();
  } catch (err) {
    console.error('[asr] transcription callback threw', err);
  }
}

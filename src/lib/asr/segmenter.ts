/**
 * Voice-activity segmentation of one audio source (16 kHz mono), for the meeting session and the benchmark.
 *
 * Energy VAD on 20 ms frames of high-passed audio (100 Hz, so rumble and DC do not count as voice), compared with
 * a noise floor that adapts during long sessions: the minimum over the last ~5 s of the energy averaged over 60 ms
 * ("minimum statistics"; the averaging keeps a single dropout frame of digital silence from pinning the floor). It
 * follows a quieter room at once and a louder one within 5 s, while speech, whose pauses and stop consonants dip
 * close to the floor every few seconds, barely lifts it.
 *
 *   idle → onset: 3 consecutive frames (60 ms) above floor + 10 dB (and above −60 dBFS). The segment starts
 *          300 ms before the onset (pre-roll from a 1 s ring buffer), so soft word beginnings are kept.
 *   tentative → committed: once it holds 250 ms of speech; shorter blips (clicks, a cough) are dropped silently,
 *          so nothing downstream ever sees them.
 *   open: a frame counts as speech above floor + 6 dB (hysteresis, −65 dBFS minimum), and only inside runs of at
 *          least 60 ms, so key clicks and knocks do not reset the pause timer (syllables last longer). A pause of
 *          minSilenceMs ends the segment; it keeps 300 ms after the last speech (capped at minSilenceMs) so the
 *          last word is not clipped.
 *   max length: at maxSegmentMs the segment is cut at the quietest 60 ms within its last 2 s; the rest becomes
 *          the start of the next segment (committed at once if it already holds 250 ms of speech).
 *
 * After start and every restart(), the first 400 ms only calibrate the floor; they are then classified with it,
 * so speech that is already going on when capture starts is still found.
 *
 * Memory stays flat: the ring buffer plus the open segment (≤ maxSegmentMs of audio).
 */
import { PcmBuffer, PcmRing } from './pcm';

const FRAME_MS = 20;
const PRE_ROLL_MS = 300;
const TRAIL_MS = 300;
/** Consecutive loud frames that make speech, both for an onset and inside a segment. */
const RUN_FRAMES = 3;
const MIN_SPEECH_MS = 250;
const ONSET_MARGIN_DB = 10;
const HOLD_MARGIN_DB = 6;
/** Never speech below these, however clean the floor (digital silence, noise suppression → −100 dBFS). */
const ONSET_MIN_DBFS = -60;
const HOLD_MIN_DBFS = -65;
const NOISE_WINDOW_MS = 5000;
const NOISE_BUCKETS = 10;
const CALIBRATION_MS = 400;
const CUT_SEARCH_MS = 2000;
const RING_MS = 1000;
const HIGH_PASS_HZ = 100;
const SILENCE_DB = -100;

export interface SegmenterConfig {
  sampleRate: number;
  minSilenceMs: number;
  maxSegmentMs: number;
}

export interface ClosedSegment {
  /** Absolute sample index (source timeline) of audio[0]. */
  startSample: number;
  /** First frame of the speech onset. */
  onsetSample: number;
  /** End of the last speech frame; the cut point for a max-length cut. */
  speechEndSample: number;
  audio: Float32Array<ArrayBuffer>;
  reason: 'pause' | 'max-length' | 'flush';
  speechMs: number;
}

export type SegmentEvent =
  | { type: 'start'; startSample: number; onsetSample: number }
  | { type: 'end'; segment: ClosedSegment };

/** The committed open segment, as the scheduler needs it. */
export interface OpenSegmentInfo {
  startSample: number;
  onsetSample: number;
  /** Audio so far; a view that stays valid until the next push(). */
  audio: Float32Array<ArrayBuffer>;
  /** End of the last speech frame. */
  lastSpeechEnd: number;
  /** Pause at the end of the segment so far. */
  trailingSilenceMs: number;
}

interface Open {
  startSample: number;
  onsetSample: number;
  audio: PcmBuffer;
  /** Per 20 ms frame since startSample: 1 = counted as speech. */
  speech: number[];
  speechFrames: number;
  loudRun: number;
  silenceFrames: number;
  lastSpeechEnd: number;
  committed: boolean;
}

export class SpeechSegmenter {
  private readonly frameSize: number;
  private readonly frame: Float32Array;
  private filled = 0;
  /** Absolute index of the next frame's first sample. */
  private next: number;
  private readonly ring: PcmRing;
  private readonly floor: NoiseFloor;
  private readonly calibrationFrames: number;
  private calibration: number[] | null = [];
  private onsetRun = 0;
  private onsetStart = 0;
  private open: Open | null = null;
  private readonly hpCoefficient: number;
  private hpPrevIn = 0;
  private hpPrevOut = 0;
  /** Power of the last frames, for the floor's 60 ms average. */
  private readonly recentPower: number[] = [];

  constructor(
    private readonly config: SegmenterConfig,
    startSample = 0,
  ) {
    this.frameSize = Math.round((config.sampleRate * FRAME_MS) / 1000);
    this.frame = new Float32Array(this.frameSize);
    this.ring = new PcmRing(this.frames(RING_MS) * this.frameSize);
    const bucketFrames = Math.max(1, Math.round(this.frames(NOISE_WINDOW_MS) / NOISE_BUCKETS));
    this.floor = new NoiseFloor(bucketFrames, NOISE_BUCKETS);
    this.calibrationFrames = this.frames(CALIBRATION_MS);
    this.hpCoefficient = 1 / (1 + (2 * Math.PI * HIGH_PASS_HZ) / config.sampleRate);
    this.next = startSample;
    this.ring.reset(startSample);
  }

  /** Absolute index of the next sample push() expects. */
  get position(): number {
    return this.next + this.filled;
  }

  /** Current noise floor estimate (dBFS); null while calibrating. */
  get floorDb(): number | null {
    return this.calibration ? null : this.floor.value;
  }

  get current(): OpenSegmentInfo | null {
    const open = this.open;
    if (!open?.committed) return null;
    return {
      startSample: open.startSample,
      onsetSample: open.onsetSample,
      audio: open.audio.view(),
      lastSpeechEnd: open.lastSpeechEnd,
      trailingSilenceMs: open.silenceFrames * FRAME_MS,
    };
  }

  push(samples: Float32Array): SegmentEvent[] {
    const events: SegmentEvent[] = [];
    for (let offset = 0; offset < samples.length; ) {
      const n = Math.min(samples.length - offset, this.frameSize - this.filled);
      this.frame.set(samples.subarray(offset, offset + n), this.filled);
      this.filled += n;
      offset += n;
      if (this.filled === this.frameSize) {
        this.filled = 0;
        this.onFrame(events);
      }
    }
    return events;
  }

  /**
   * Ends the open segment now, including audio not yet classified (stop, pause, source ended). Returns it when it
   * was committed; a tentative one is dropped. Afterwards the segmenter starts over (calibration included).
   */
  end(): ClosedSegment | null {
    const open = this.open;
    const tailEnd = this.next + this.filled;
    let closed: ClosedSegment | null = null;
    if (open?.committed) {
      open.audio.append(this.frame.subarray(0, this.filled));
      closed = {
        startSample: open.startSample,
        onsetSample: open.onsetSample,
        speechEndSample: open.silenceFrames === 0 ? tailEnd : open.lastSpeechEnd,
        audio: open.audio.copy(),
        reason: 'flush',
        speechMs: open.speechFrames * FRAME_MS,
      };
    }
    this.restart(tailEnd);
    return closed;
  }

  /** Drops all state and recalibrates, continuing at absolute sample `position` (e.g. after a pause). */
  restart(position: number): void {
    this.next = position;
    this.filled = 0;
    this.ring.reset(position);
    this.floor.reset();
    this.calibration = [];
    this.onsetRun = 0;
    this.open = null;
    this.hpPrevIn = 0;
    this.hpPrevOut = 0;
    this.recentPower.length = 0;
  }

  private frames(ms: number): number {
    return Math.round(ms / FRAME_MS);
  }

  private onFrame(events: SegmentEvent[]): void {
    const frameStart = this.next;
    this.next += this.frameSize;
    this.ring.write(this.frame);
    const power = this.framePower();
    const db = toDb(power);
    this.recentPower.push(power);
    if (this.recentPower.length > RUN_FRAMES) this.recentPower.shift();
    this.floor.push(toDb(this.recentPower.reduce((sum, p) => sum + p, 0) / this.recentPower.length));
    if (!this.calibration) {
      this.classify(frameStart, db, events);
      return;
    }
    this.calibration.push(db);
    if (this.calibration.length < this.calibrationFrames) return;
    // Classify the calibration frames with the floor they produced; their audio is still in the ring.
    const levels = this.calibration;
    this.calibration = null;
    const first = this.next - levels.length * this.frameSize;
    levels.forEach((level, i) => this.classify(first + i * this.frameSize, level, events));
  }

  /** Mean power of the current frame after a first-order 100 Hz high-pass. */
  private framePower(): number {
    const a = this.hpCoefficient;
    let prevIn = this.hpPrevIn;
    let prevOut = this.hpPrevOut;
    let sum = 0;
    for (let i = 0; i < this.frame.length; i++) {
      const x = this.frame[i];
      prevOut = a * (prevOut + x - prevIn);
      prevIn = x;
      sum += prevOut * prevOut;
    }
    this.hpPrevIn = prevIn;
    this.hpPrevOut = prevOut;
    return sum / this.frame.length;
  }

  private classify(frameStart: number, db: number, events: SegmentEvent[]): void {
    const floor = this.floor.value;
    const frameEnd = frameStart + this.frameSize;
    const open = this.open;
    if (!open) {
      if (db > Math.max(floor + ONSET_MARGIN_DB, ONSET_MIN_DBFS)) {
        if (this.onsetRun++ === 0) this.onsetStart = frameStart;
        if (this.onsetRun >= RUN_FRAMES) this.openAt(this.onsetStart, frameEnd);
      } else {
        this.onsetRun = 0;
      }
      return;
    }

    this.extend(open, frameEnd);
    const frameIndex = (frameStart - open.startSample) / this.frameSize;
    open.loudRun = db > Math.max(floor + HOLD_MARGIN_DB, HOLD_MIN_DBFS) ? open.loudRun + 1 : 0;
    if (open.loudRun >= RUN_FRAMES) {
      const first = open.loudRun === RUN_FRAMES ? frameIndex - RUN_FRAMES + 1 : frameIndex;
      for (let i = first; i <= frameIndex; i++) this.markSpeech(open, i);
      open.silenceFrames = 0;
      open.lastSpeechEnd = frameEnd;
    } else {
      open.silenceFrames++;
    }

    if (!open.committed && open.speechFrames * FRAME_MS >= MIN_SPEECH_MS) {
      open.committed = true;
      events.push({ type: 'start', startSample: open.startSample, onsetSample: open.onsetSample });
    }
    if (open.silenceFrames * FRAME_MS >= this.config.minSilenceMs) {
      this.closeOnPause(open, events);
    } else if (open.audio.length >= (this.config.maxSegmentMs / 1000) * this.config.sampleRate) {
      this.cut(open, events);
    }
  }

  private openAt(onsetStart: number, frameEnd: number): void {
    const preRoll = this.frames(PRE_ROLL_MS) * this.frameSize;
    const startSample = Math.max(onsetStart - preRoll, this.ring.start);
    const audio = new PcmBuffer(this.config.sampleRate * 4);
    this.ring.copyInto(audio, startSample, frameEnd);
    const frames = (frameEnd - startSample) / this.frameSize;
    const speech = new Array<number>(frames).fill(0);
    for (let i = frames - RUN_FRAMES; i < frames; i++) speech[i] = 1;
    this.open = {
      startSample,
      onsetSample: onsetStart,
      audio,
      speech,
      speechFrames: RUN_FRAMES,
      loudRun: RUN_FRAMES,
      silenceFrames: 0,
      lastSpeechEnd: frameEnd,
      committed: false,
    };
    this.onsetRun = 0;
  }

  /** Brings the open segment's audio up to `frameEnd` (from the ring, which also covers the calibration replay). */
  private extend(open: Open, frameEnd: number): void {
    const have = open.startSample + open.audio.length;
    if (frameEnd > have) this.ring.copyInto(open.audio, have, frameEnd);
  }

  private markSpeech(open: Open, frameIndex: number): void {
    while (open.speech.length <= frameIndex) open.speech.push(0);
    if (frameIndex >= 0 && open.speech[frameIndex] === 0) {
      open.speech[frameIndex] = 1;
      open.speechFrames++;
    }
  }

  private closeOnPause(open: Open, events: SegmentEvent[]): void {
    this.open = null;
    this.onsetRun = 0;
    if (!open.committed) return;
    const trail = this.frames(Math.min(TRAIL_MS, this.config.minSilenceMs)) * this.frameSize;
    const end = Math.min(open.lastSpeechEnd + trail, open.startSample + open.audio.length);
    events.push({
      type: 'end',
      segment: {
        startSample: open.startSample,
        onsetSample: open.onsetSample,
        speechEndSample: open.lastSpeechEnd,
        audio: open.audio.copy(0, end - open.startSample),
        reason: 'pause',
        speechMs: open.speechFrames * FRAME_MS,
      },
    });
  }

  private cut(open: Open, events: SegmentEvent[]): void {
    if (!open.committed) {
      // Cannot happen with the thresholds above (250 ms of speech commits long before), but never grow unbounded.
      this.open = null;
      return;
    }
    const cutFrame = this.quietestFrame(open);
    const cutSample = open.startSample + cutFrame * this.frameSize;
    const rest = new PcmBuffer(this.config.sampleRate * 4);
    rest.append(open.audio.view(cutSample - open.startSample));
    const speech = open.speech.slice(cutFrame);
    const speechFrames = speech.reduce((sum, flag) => sum + flag, 0);
    events.push({
      type: 'end',
      segment: {
        startSample: open.startSample,
        onsetSample: open.onsetSample,
        speechEndSample: cutSample,
        audio: open.audio.copy(0, cutSample - open.startSample),
        reason: 'max-length',
        speechMs: (open.speechFrames - speechFrames) * FRAME_MS,
      },
    });
    const committed = speechFrames * FRAME_MS >= MIN_SPEECH_MS;
    this.open = {
      startSample: cutSample,
      onsetSample: cutSample,
      audio: rest,
      speech,
      speechFrames,
      loudRun: open.loudRun,
      silenceFrames: open.silenceFrames,
      lastSpeechEnd: Math.max(open.lastSpeechEnd, cutSample),
      committed,
    };
    if (committed) events.push({ type: 'start', startSample: cutSample, onsetSample: cutSample });
  }

  /** Frame (index from the segment start) at the middle of the quietest 60 ms within the last CUT_SEARCH_MS. */
  private quietestFrame(open: Open): number {
    const total = Math.floor(open.audio.length / this.frameSize);
    const first = Math.max(1, total - this.frames(CUT_SEARCH_MS));
    const audio = open.audio.view();
    const energy = (frame: number): number => {
      let sum = 0;
      for (let i = frame * this.frameSize, end = i + this.frameSize; i < end; i++) sum += audio[i] * audio[i];
      return sum;
    };
    let best = total - 1;
    let bestEnergy = Infinity;
    let previous = energy(first - 1);
    let current = energy(first);
    for (let frame = first; frame < total; frame++) {
      const following = frame + 1 < total ? energy(frame + 1) : current;
      const smoothed = previous + current + following;
      if (smoothed < bestEnergy) {
        bestEnergy = smoothed;
        best = frame;
      }
      previous = current;
      current = following;
    }
    return best;
  }
}

function toDb(power: number): number {
  return power > 0 ? Math.max(SILENCE_DB, 10 * Math.log10(power)) : SILENCE_DB;
}

/** Sliding-window minimum of frame energies in fixed buckets: O(1) per frame. */
class NoiseFloor {
  private readonly buckets: number[];
  private index = 0;
  private count = 0;

  constructor(
    private readonly bucketFrames: number,
    bucketCount: number,
  ) {
    this.buckets = new Array<number>(bucketCount).fill(Infinity);
  }

  get value(): number {
    const min = Math.min(...this.buckets);
    return Number.isFinite(min) ? min : SILENCE_DB;
  }

  push(db: number): void {
    if (this.count === this.bucketFrames) {
      this.index = (this.index + 1) % this.buckets.length;
      this.buckets[this.index] = Infinity;
      this.count = 0;
    }
    this.buckets[this.index] = Math.min(this.buckets[this.index], db);
    this.count++;
  }

  reset(): void {
    this.buckets.fill(Infinity);
    this.index = 0;
    this.count = 0;
  }
}

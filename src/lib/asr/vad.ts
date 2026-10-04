import { meanSquare } from './pcm';

/**
 * Approximate speech-onset detector (spec §9 "Speech Start"): frame energy against a noise floor
 * calibrated from the first few hundred milliseconds of the recording.
 */
const FRAME_MS = 20;
const CALIBRATION_MS = 300;
/** Low percentile, so speech that starts inside the calibration window does not raise the floor much. */
const FLOOR_PERCENTILE = 0.2;
const MARGIN_DB = 12;
/** Never call anything quieter than this speech, however clean the noise floor (noise suppression → ~-90 dB). */
const MIN_SPEECH_DB = -60;
const RUN_FRAMES = 3;

export class EnergyVad {
  private readonly frameSize: number;
  private readonly calibrationFrames: number;
  private readonly frame: Float32Array;
  private filled = 0;
  private frames = 0;
  private calibration: number[] = [];
  private floorDb: number | null = null;
  private runStart = 0;
  private runLength = 0;
  /** Sample index (at the VAD's sample rate) of the first frame of the first voiced run. */
  speechStartSample: number | null = null;

  constructor(sampleRate: number) {
    this.frameSize = Math.round((sampleRate * FRAME_MS) / 1000);
    this.calibrationFrames = Math.round(CALIBRATION_MS / FRAME_MS);
    this.frame = new Float32Array(this.frameSize);
  }

  /** Returns the speech-start sample index if this call detected it, otherwise null. */
  push(samples: Float32Array): number | null {
    let offset = 0;
    while (this.speechStartSample === null && offset < samples.length) {
      const n = Math.min(samples.length - offset, this.frameSize - this.filled);
      this.frame.set(samples.subarray(offset, offset + n), this.filled);
      this.filled += n;
      offset += n;
      if (this.filled === this.frameSize) {
        this.filled = 0;
        const detected = this.onFrame(10 * Math.log10(meanSquare(this.frame) + 1e-12));
        if (detected !== null) return detected;
      }
    }
    return null;
  }

  private onFrame(db: number): number | null {
    const index = this.frames++;
    if (this.floorDb !== null) return this.classify(index, db);

    this.calibration.push(db);
    if (this.calibration.length < this.calibrationFrames) return null;
    const levels = this.calibration;
    this.calibration = [];
    this.floorDb = [...levels].sort((a, b) => a - b)[Math.floor(levels.length * FLOOR_PERCENTILE)];
    // Speech may already have started inside the calibration window: classify those frames too.
    for (let i = 0; i < levels.length; i++) {
      const detected = this.classify(i, levels[i]);
      if (detected !== null) return detected;
    }
    return null;
  }

  private classify(index: number, db: number): number | null {
    const floor = this.floorDb!;
    if (db > Math.max(floor + MARGIN_DB, MIN_SPEECH_DB)) {
      if (this.runLength++ === 0) this.runStart = index;
      if (this.runLength >= RUN_FRAMES) {
        this.speechStartSample = this.runStart * this.frameSize;
        return this.speechStartSample;
      }
    } else {
      this.runLength = 0;
      this.floorDb = Math.min(floor, db);
    }
    return null;
  }
}

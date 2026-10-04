/**
 * From a segment's audio to the model input and back to one speaker embedding. Pure TypeScript (no DOM, no
 * ONNX Runtime): the worker and the Node tests share it.
 *
 * 1. Fbank features for the whole segment (./fbank.ts).
 * 2. Speech duration: frames that pass an energy gate relative to the segment's own loud frames. Pauses,
 *    trailing silence and digital silence (muted call audio) do not count.
 * 3. Too little speech → no embedding (the session reports speakerId null).
 * 4. The model sees every frame: up to `maxWindowFrames` in one window; longer segments are cut into equal
 *    windows (between half and all of maxWindowFrames long), embedded in one batch and averaged.
 * 5. Each window gets cepstral mean normalisation (per-bin mean subtraction), as in training.
 */
import type { Fbank } from './fbank';

export interface SpeechGateOptions {
  /** Frames more than this many dB below the segment's reference level (95th percentile) are not speech. */
  dynamicRangeDb: number;
  /** Frames below this level (dB re full scale, mean square) are never speech: digital silence, muted inputs. */
  floorDb: number;
}

export interface PrepareOptions extends SpeechGateOptions {
  /** Less speech than this → no embedding. */
  minSpeechMs: number;
  /** Longest window the model sees; longer segments are split into equal windows. */
  maxWindowFrames: number;
}

export interface PreparedInput {
  /** Speech in the segment according to the energy gate. */
  speechMs: number;
  /** Model input [windows, frames, bins], or null when there is too little speech. */
  batch: { data: Float32Array; windows: number; frames: number; bins: number } | null;
  /** Feature extraction time. */
  featureMs: number;
}

/** Duration of one feature frame (10 ms). */
export function frameMs(fbank: Fbank): number {
  return (fbank.options.frameShift / fbank.options.sampleRate) * 1000;
}

export function prepareEmbeddingInput(fbank: Fbank, audio: Float32Array, opts: PrepareOptions, clock: () => number): PreparedInput {
  const started = clock();
  const { frames, features, energyDb } = fbank.compute(audio);
  const bins = fbank.options.numMelBins;
  const speechMs = countSpeechFrames(energyDb, opts) * frameMs(fbank);
  if (speechMs < opts.minSpeechMs || frames === 0) return { speechMs, batch: null, featureMs: clock() - started };

  const windows = Math.max(1, Math.ceil(frames / opts.maxWindowFrames));
  const length = Math.ceil(frames / windows);
  const data = new Float32Array(windows * length * bins);
  for (let w = 0; w < windows; w++) {
    // Equal lengths so one batched run covers every window; the last starts at frames - length, so windows
    // overlap by fewer than `windows` frames.
    const first = windows === 1 ? 0 : Math.round((w * (frames - length)) / (windows - 1));
    const window = data.subarray(w * length * bins, (w + 1) * length * bins);
    window.set(features.subarray(first * bins, (first + length) * bins));
    subtractMean(window, length, bins);
  }
  return { speechMs, batch: { data, windows, frames: length, bins }, featureMs: clock() - started };
}

/** Frames that pass the energy gate. */
export function countSpeechFrames(energyDb: Float32Array, { dynamicRangeDb, floorDb }: SpeechGateOptions): number {
  if (energyDb.length === 0) return 0;
  const sorted = Float32Array.from(energyDb).sort();
  const reference = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const threshold = Math.max(floorDb, reference - dynamicRangeDb);
  let count = 0;
  for (let i = 0; i < energyDb.length; i++) if (energyDb[i] >= threshold) count++;
  return count;
}

function subtractMean(rows: Float32Array, frames: number, bins: number): void {
  const mean = new Float64Array(bins);
  for (let f = 0; f < frames; f++) for (let b = 0; b < bins; b++) mean[b] += rows[f * bins + b];
  for (let b = 0; b < bins; b++) mean[b] /= frames;
  for (let f = 0; f < frames; f++) for (let b = 0; b < bins; b++) rows[f * bins + b] -= mean[b];
}

/** L2-normalised mean of the L2-normalised rows of a [windows, dim] model output. */
export function poolEmbeddings(output: Float32Array, windows: number, dim: number): Float32Array {
  const pooled = new Float32Array(dim);
  for (let w = 0; w < windows; w++) {
    const row = normalize(output.slice(w * dim, (w + 1) * dim));
    for (let d = 0; d < dim; d++) pooled[d] += row[d];
  }
  return normalize(pooled);
}

export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

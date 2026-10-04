/**
 * Kaldi-compatible log mel filterbank features ("fbank"), the input of the speaker-embedding model.
 *
 * Reproduces torchaudio.compliance.kaldi.fbank (and Kaldi's compute-fbank-feats) with dither 0, snip_edges,
 * use_energy false, the power spectrum and log mel energies floored at FLT_EPSILON — the features the model
 * was trained on. Checked against torchaudio and kaldi-native-fbank on speech, synthetic speech with digital
 * silence and far-field audio, for both Povey/[-1, 1] and Hamming/int16 settings: max difference 4e-4 (mean
 * 3e-6) in log-mel units, the same as theirs from each other (float32 rounding). Pure TypeScript without DOM
 * APIs, so the worker and Node tests run the same code.
 *
 * Per frame: remove the DC offset → pre-emphasis (x[i] -= 0.97·x[i-1], x[0] -= 0.97·x[0]) → window →
 * zero-pad to 512 → |FFT|² → triangular mel filters (Kaldi mel scale, 20 Hz … Nyquist) → log.
 */

export type FbankWindow = 'povey' | 'hamming' | 'hanning' | 'rectangular';

export interface FbankOptions {
  sampleRate: number;
  /** Samples per frame: 400 = 25 ms at 16 kHz. */
  frameLength: number;
  /** Samples between frame starts: 160 = 10 ms at 16 kHz. */
  frameShift: number;
  numMelBins: number;
  lowFreq: number;
  /** > 0: absolute; <= 0: offset from the Nyquist frequency (Kaldi convention, 0 = Nyquist). */
  highFreq: number;
  preemphasis: number;
  removeDcOffset: boolean;
  window: FbankWindow;
  /** Input samples are multiplied by this first: 32768 reproduces Kaldi's int16 range, 1 keeps [-1, 1] floats. */
  inputScale: number;
}

export interface FbankResult {
  frames: number;
  /** frames × numMelBins log mel energies, row-major (one row per 10 ms frame). */
  features: Float32Array;
  /** Per frame: 10·log10(mean square) of the DC-free input samples, in dB re full scale ([-1, 1] input). */
  energyDb: Float32Array;
}

/** Kaldi floors mel energies at the float32 machine epsilon before taking the log. */
const FLT_EPSILON = 1.1920928955078125e-7;

function melScale(hz: number): number {
  return 1127 * Math.log(1 + hz / 700);
}

export class Fbank {
  readonly options: Readonly<FbankOptions>;
  private readonly fftSize: number;
  private readonly window: Float64Array;
  /** Per mel bin: first FFT bin with a non-zero weight and the weights from there. */
  private readonly melFilters: { start: number; weights: Float64Array }[];
  private readonly fft: RealFft;
  private readonly frame: Float64Array;
  private readonly power: Float64Array;

  constructor(options: FbankOptions) {
    this.options = { ...options };
    const { frameLength, sampleRate, numMelBins, lowFreq } = options;
    this.fftSize = 1 << Math.ceil(Math.log2(frameLength)); // round_to_power_of_two
    this.window = windowFunction(options.window, frameLength);
    this.fft = new RealFft(this.fftSize);
    this.frame = new Float64Array(this.fftSize);
    this.power = new Float64Array(this.fftSize / 2 + 1);

    // Kaldi MelBanks: triangles equally spaced on the mel scale, evaluated at the FFT bin centre frequencies
    // (the Nyquist bin always gets weight 0).
    const nyquist = sampleRate / 2;
    const highFreq = options.highFreq > 0 ? options.highFreq : nyquist + options.highFreq;
    if (!(lowFreq >= 0 && lowFreq < highFreq && highFreq <= nyquist)) {
      throw new Error(`Invalid fbank frequency range ${lowFreq}–${highFreq} Hz.`);
    }
    const binWidth = sampleRate / this.fftSize;
    const melLow = melScale(lowFreq);
    const melDelta = (melScale(highFreq) - melLow) / (numMelBins + 1);
    this.melFilters = [];
    for (let bin = 0; bin < numMelBins; bin++) {
      const left = melLow + bin * melDelta;
      const center = left + melDelta;
      const right = center + melDelta;
      let start = -1;
      const weights: number[] = [];
      for (let i = 0; i < this.fftSize / 2; i++) {
        const mel = melScale(binWidth * i);
        if (mel > left && mel < right) {
          if (start < 0) start = i;
          weights.push(mel <= center ? (mel - left) / (center - left) : (right - mel) / (right - center));
        } else if (start >= 0) {
          break;
        }
      }
      this.melFilters.push({ start: Math.max(start, 0), weights: Float64Array.from(weights) });
    }
  }

  /** Frames produced for `samples` input samples (snip_edges: only whole frames). */
  numFrames(samples: number): number {
    const { frameLength, frameShift } = this.options;
    return samples < frameLength ? 0 : 1 + Math.floor((samples - frameLength) / frameShift);
  }

  compute(samples: Float32Array): FbankResult {
    const { frameLength, frameShift, numMelBins, preemphasis, removeDcOffset, inputScale } = this.options;
    const frames = this.numFrames(samples.length);
    const features = new Float32Array(frames * numMelBins);
    const energyDb = new Float32Array(frames);
    const { frame, power, window } = this;

    for (let f = 0; f < frames; f++) {
      const offset = f * frameShift;
      let mean = 0;
      if (removeDcOffset) {
        for (let i = 0; i < frameLength; i++) mean += samples[offset + i];
        mean /= frameLength;
      }
      let energy = 0;
      for (let i = 0; i < frameLength; i++) {
        const x = samples[offset + i] - mean;
        energy += x * x;
        frame[i] = x * inputScale;
      }
      energyDb[f] = 10 * Math.log10(energy / frameLength + 1e-20);
      if (preemphasis !== 0) {
        for (let i = frameLength - 1; i > 0; i--) frame[i] -= preemphasis * frame[i - 1];
        frame[0] -= preemphasis * frame[0];
      }
      for (let i = 0; i < frameLength; i++) frame[i] *= window[i];
      frame.fill(0, frameLength);

      this.fft.powerSpectrum(frame, power);
      const row = f * numMelBins;
      for (let m = 0; m < numMelBins; m++) {
        const { start, weights } = this.melFilters[m];
        let sum = 0;
        for (let k = 0; k < weights.length; k++) sum += weights[k] * power[start + k];
        features[row + m] = Math.log(Math.max(sum, FLT_EPSILON));
      }
    }
    return { frames, features, energyDb };
  }
}

function windowFunction(type: FbankWindow, length: number): Float64Array {
  const w = new Float64Array(length);
  const a = (2 * Math.PI) / (length - 1);
  for (let i = 0; i < length; i++) {
    const hann = 0.5 - 0.5 * Math.cos(a * i);
    switch (type) {
      case 'hanning':
        w[i] = hann;
        break;
      case 'hamming':
        w[i] = 0.54 - 0.46 * Math.cos(a * i);
        break;
      case 'povey':
        w[i] = Math.pow(hann, 0.85);
        break;
      case 'rectangular':
        w[i] = 1;
        break;
    }
  }
  return w;
}

/**
 * Power spectrum of a real signal of length n (a power of two) via one complex FFT of length n/2 on the
 * even/odd samples packed as real/imaginary parts.
 */
class RealFft {
  private readonly half: number;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly reverse: Uint32Array;
  /** exp(-2πik/half) for k < half/2. */
  private readonly cosHalf: Float64Array;
  private readonly sinHalf: Float64Array;
  /** exp(-2πik/n) for k <= half. */
  private readonly cosFull: Float64Array;
  private readonly sinFull: Float64Array;

  constructor(n: number) {
    if (n < 4 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two >= 4, got ${n}.`);
    const half = n / 2;
    this.half = half;
    this.re = new Float64Array(half);
    this.im = new Float64Array(half);
    this.reverse = new Uint32Array(half);
    const bits = Math.log2(half);
    for (let i = 0; i < half; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.reverse[i] = r;
    }
    this.cosHalf = new Float64Array(half / 2);
    this.sinHalf = new Float64Array(half / 2);
    for (let k = 0; k < half / 2; k++) {
      this.cosHalf[k] = Math.cos((2 * Math.PI * k) / half);
      this.sinHalf[k] = Math.sin((2 * Math.PI * k) / half);
    }
    this.cosFull = new Float64Array(half + 1);
    this.sinFull = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) {
      this.cosFull[k] = Math.cos((2 * Math.PI * k) / n);
      this.sinFull[k] = Math.sin((2 * Math.PI * k) / n);
    }
  }

  /** out[k] = |X[k]|² for k = 0 … n/2, where X = FFT(input) and input.length === n. */
  powerSpectrum(input: Float64Array, out: Float64Array): void {
    const { half, re, im, reverse, cosHalf, sinHalf, cosFull, sinFull } = this;
    for (let i = 0; i < half; i++) {
      const j = reverse[i];
      re[j] = input[2 * i];
      im[j] = input[2 * i + 1];
    }
    // Iterative radix-2 decimation-in-time FFT of z[m] = x[2m] + i·x[2m+1].
    for (let size = 2; size <= half; size <<= 1) {
      const span = size >> 1;
      const step = half / size;
      for (let start = 0; start < half; start += size) {
        for (let j = 0; j < span; j++) {
          const wr = cosHalf[j * step];
          const wi = -sinHalf[j * step];
          const a = start + j;
          const b = a + span;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    // Split Z into the spectra of the even (E) and odd (O) samples, then X[k] = E[k] + e^(-2πik/n)·O[k].
    for (let k = 0; k <= half; k++) {
      const k1 = k === half ? 0 : k;
      const k2 = k === 0 ? 0 : half - k;
      const ar = re[k1];
      const ai = im[k1];
      const br = re[k2];
      const bi = -im[k2]; // conj(Z[half - k])
      const er = (ar + br) / 2;
      const ei = (ai + bi) / 2;
      const or = (ai - bi) / 2; // (Z[k] - conj(Z[half-k])) / 2i
      const oi = -(ar - br) / 2;
      const c = cosFull[k];
      const s = sinFull[k];
      const xr = er + or * c + oi * s;
      const xi = ei + oi * c - or * s;
      out[k] = xr * xr + xi * xi;
    }
  }
}

/**
 * Streaming band-limited resampler (windowed-sinc interpolation, Blackman window).
 *
 * Only used when the browser will not give the microphone a 16 kHz AudioContext (Firefox refuses to
 * connect a mic to a context with a different rate). The low-pass cutoff sits at 90% of the output
 * Nyquist frequency, so downsampling 44.1/48 kHz → 16 kHz does not alias.
 */
const ZERO_CROSSINGS = 24; // per side; sets the transition band (~1.6 kHz at 48 kHz input)
const TABLE_STEPS = 64; // kernel table resolution per input sample (linearly interpolated)
const PASSBAND = 0.9;

export class StreamingResampler {
  /** Input samples advanced per output sample. */
  private readonly step: number;
  /** Kernel half-width in input samples. */
  private readonly halfWidth: number;
  private readonly kernel: Float32Array;
  /** Input history; history[0] is absolute input sample `base` (negative indices = leading silence). */
  private history: Float32Array;
  private base: number;
  private length: number;
  private received = 0;
  private produced = 0;

  constructor(inputRate: number, outputRate: number) {
    this.step = inputRate / outputRate;
    const cutoff = 0.5 * Math.min(1, outputRate / inputRate) * PASSBAND; // cycles per input sample
    this.halfWidth = ZERO_CROSSINGS / (2 * cutoff);
    this.kernel = new Float32Array(Math.ceil(this.halfWidth * TABLE_STEPS) + 2);
    for (let i = 0; i < this.kernel.length; i++) {
      const x = i / TABLE_STEPS;
      if (x >= this.halfWidth) break;
      const u = 2 * cutoff * x;
      const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
      const r = x / this.halfWidth;
      const window = 0.42 + 0.5 * Math.cos(Math.PI * r) + 0.08 * Math.cos(2 * Math.PI * r);
      this.kernel[i] = 2 * cutoff * sinc * window;
    }
    const lead = Math.ceil(this.halfWidth);
    this.history = new Float32Array(lead * 2 + 4096);
    this.base = -lead;
    this.length = lead;
  }

  process(input: Float32Array): Float32Array {
    this.append(input);
    this.received += input.length;
    return this.emit(Infinity);
  }

  /** Emits the remaining output for everything received so far (pads the look-ahead with silence). */
  flush(): Float32Array {
    this.append(new Float32Array(Math.ceil(this.halfWidth) + 1));
    return this.emit(this.received);
  }

  private emit(limit: number): Float32Array {
    const available = this.base + this.length;
    const capacity = Math.max(0, Math.ceil((available - this.produced * this.step) / this.step) + 1);
    const out = new Float32Array(capacity);
    let count = 0;
    while (count < capacity) {
      const t = this.produced * this.step;
      if (t >= limit) break;
      const last = Math.floor(t + this.halfWidth);
      if (last >= available) break;
      let acc = 0;
      for (let k = Math.ceil(t - this.halfWidth); k <= last; k++) {
        const d = Math.abs(t - k) * TABLE_STEPS;
        const i = d | 0;
        acc += this.history[k - this.base] * (this.kernel[i] + (d - i) * (this.kernel[i + 1] - this.kernel[i]));
      }
      out[count++] = acc;
      this.produced++;
    }
    this.discardBefore(Math.ceil(this.produced * this.step - this.halfWidth));
    return out.subarray(0, count);
  }

  private append(input: Float32Array): void {
    if (this.length + input.length > this.history.length) {
      const grown = new Float32Array((this.length + input.length) * 2);
      grown.set(this.history.subarray(0, this.length));
      this.history = grown;
    }
    this.history.set(input, this.length);
    this.length += input.length;
  }

  private discardBefore(index: number): void {
    const drop = Math.min(index - this.base, this.length);
    if (drop <= 0) return;
    this.history.copyWithin(0, drop, this.length);
    this.length -= drop;
    this.base += drop;
  }
}

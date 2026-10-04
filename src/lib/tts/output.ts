/**
 * Loudness for synthesized speech.
 *
 * The model's output averages about −21 dBFS RMS with peaks near full scale, so it plays much quieter than
 * other audio at the same system volume. Each generated chunk gets a fixed makeup gain (bringing speech to
 * about −14 dBFS RMS, typical for streamed spoken word) and a lookahead peak limiter that holds peaks at
 * −1 dBFS. Chunks are complete before they play, so this runs on the samples in place: exact and cheap
 * (~10 ms per 20 s of audio), unlike Web Audio's DynamicsCompressorNode, whose automatic makeup gain fights
 * the boost and still lets transients clip. A fixed gain, not per-chunk normalization, keeps the natural level
 * differences between sentences.
 */

const MAKEUP_GAIN_DB = 8;
const CEILING_DBFS = -1;
const LOOKAHEAD_MS = 3;
const RELEASE_MS = 60;

/** Apply makeup gain and peak limiting to one chunk, in place. */
export function applySpeechLoudness(samples: Float32Array, sampleRate: number): void {
  const n = samples.length;
  if (n === 0) return;
  const gain = 10 ** (MAKEUP_GAIN_DB / 20);
  const ceiling = 10 ** (CEILING_DBFS / 20);

  // Gain each sample needs so that |x · gain · need| ≤ ceiling.
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const level = Math.abs(samples[i]) * gain;
    need[i] = level > ceiling ? ceiling / level : 1;
  }

  // Lookahead: the envelope reaches the lowest requirement of the next few ms before the peak arrives
  // (sliding-window minimum with a monotonic deque, scanned right to left).
  const lookahead = Math.max(1, Math.round((sampleRate * LOOKAHEAD_MS) / 1000));
  const envelope = new Float32Array(n);
  const deque = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (tail > head && need[deque[tail - 1]] >= need[i]) tail--;
    deque[tail++] = i;
    while (deque[head] > i + lookahead) head++;
    envelope[i] = need[deque[head]];
  }

  // The gain drops at once (the lookahead already anticipated the peak) and recovers smoothly.
  const release = Math.exp(-1 / ((sampleRate * RELEASE_MS) / 1000));
  let current = 1;
  for (let i = 0; i < n; i++) {
    current = envelope[i] < current ? envelope[i] : envelope[i] + (current - envelope[i]) * release;
    samples[i] *= gain * current;
  }
}

/** The node synthesized speech connects to. */
export function speechOutput(ctx: BaseAudioContext): AudioNode {
  return ctx.destination;
}

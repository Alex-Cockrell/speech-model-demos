/** Growable FIFO of PCM samples (main thread batching into streaming chunks). */
export class PcmQueue {
  private buffer = new Float32Array(32768);
  private start = 0;
  private end = 0;

  get length(): number {
    return this.end - this.start;
  }

  push(samples: Float32Array): void {
    if (this.end + samples.length > this.buffer.length) {
      const length = this.length;
      if (length + samples.length > this.buffer.length) {
        const grown = new Float32Array(Math.max(length + samples.length, this.buffer.length * 2));
        grown.set(this.buffer.subarray(this.start, this.end));
        this.buffer = grown;
      } else {
        this.buffer.copyWithin(0, this.start, this.end);
      }
      this.start = 0;
      this.end = length;
    }
    this.buffer.set(samples, this.end);
    this.end += samples.length;
  }

  /** Removes and returns up to `count` samples as a standalone (transferable) array. */
  take(count: number): Float32Array<ArrayBuffer> {
    const n = Math.min(count, this.length);
    const out = this.buffer.slice(this.start, this.start + n);
    this.start += n;
    return out;
  }
}

export function concatPcm(parts: readonly Float32Array[]): Float32Array<ArrayBuffer> {
  const out = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Copy of `samples` with trailing zeros up to a multiple of `multiple` samples. */
export function padToMultiple(samples: Float32Array, multiple: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(Math.ceil(samples.length / multiple) * multiple);
  out.set(samples);
  return out;
}

export function meanSquare(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? sum / samples.length : 0;
}

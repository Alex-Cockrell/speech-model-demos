/** Append-only growable PCM buffer (an open segment, or a whole benchmark recording). */
export class PcmBuffer {
  private data: Float32Array<ArrayBuffer>;
  private size = 0;

  constructor(initialCapacity = 32768) {
    this.data = new Float32Array(Math.max(1, initialCapacity));
  }

  get length(): number {
    return this.size;
  }

  append(samples: Float32Array): void {
    if (this.size + samples.length > this.data.length) {
      const grown = new Float32Array(Math.max(this.size + samples.length, this.data.length * 2));
      grown.set(this.data.subarray(0, this.size));
      this.data = grown;
    }
    this.data.set(samples, this.size);
    this.size += samples.length;
  }

  /** View of [start, end); valid until the next append. */
  view(start = 0, end = this.size): Float32Array<ArrayBuffer> {
    return this.data.subarray(start, end);
  }

  /** Standalone (transferable) copy of [start, end). */
  copy(start = 0, end = this.size): Float32Array<ArrayBuffer> {
    return this.data.slice(start, end);
  }
}

/** The most recent `capacity` samples of a stream, addressed by absolute sample index (pre-roll before an onset). */
export class PcmRing {
  private readonly data: Float32Array;
  /** Absolute index just past the newest sample. */
  private end = 0;
  /** Nothing before this index was written since the last reset. */
  private validFrom = 0;

  constructor(readonly capacity: number) {
    this.data = new Float32Array(capacity);
  }

  /** Oldest absolute index still available. */
  get start(): number {
    return Math.max(this.validFrom, this.end - this.capacity);
  }

  reset(position: number): void {
    this.end = position;
    this.validFrom = position;
  }

  write(samples: Float32Array): void {
    const source = samples.length > this.capacity ? samples.subarray(samples.length - this.capacity) : samples;
    this.end += samples.length - source.length;
    const at = this.end % this.capacity;
    const first = Math.min(source.length, this.capacity - at);
    this.data.set(source.subarray(0, first), at);
    this.data.set(source.subarray(first), 0);
    this.end += source.length;
  }

  /** Appends absolute samples [from, to) to `target`. Throws when that range is no longer (or not yet) held. */
  copyInto(target: PcmBuffer, from: number, to: number): void {
    if (from < this.start || to > this.end || from > to) {
      throw new RangeError(`PcmRing holds [${this.start}, ${this.end}), not [${from}, ${to})`);
    }
    for (let at = from; at < to; ) {
      const offset = at % this.capacity;
      const n = Math.min(to - at, this.capacity - offset);
      target.append(this.data.subarray(offset, offset + n));
      at += n;
    }
  }
}

export function meanSquare(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? sum / samples.length : 0;
}

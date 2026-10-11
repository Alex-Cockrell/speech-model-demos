/** 16-bit PCM helpers for read aloud's audio archive and its WAV download. Pure. */

/** Float samples (−1…1) → 16-bit PCM, clamped. */
export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

export function int16ToFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] < 0 ? samples[i] / 0x8000 : samples[i] / 0x7fff;
  return out;
}

const HEADER_BYTES = 44;

/** RIFF/WAVE header for mono 16-bit PCM with `sampleCount` samples. */
export function wavHeader(sampleCount: number, sampleRate: number): ArrayBuffer {
  const dataBytes = sampleCount * 2;
  const header = new ArrayBuffer(HEADER_BYTES);
  const view = new DataView(header);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return header;
}

/** A WAV file from consecutive mono 16-bit chunks, built without copying them into one array. */
export function encodeWav(chunks: readonly Int16Array[], sampleRate: number): Blob {
  const sampleCount = chunks.reduce((n, c) => n + c.length, 0);
  const parts: BlobPart[] = [wavHeader(sampleCount, sampleRate)];
  for (const chunk of chunks) parts.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) as Uint8Array<ArrayBuffer>);
  return new Blob(parts, { type: 'audio/wav' });
}

/**
 * Guards against empty speech from the voice model. In fp16 the model can return a chunk made entirely of NaN
 * for some inputs (seen: the clause "generation runs continuously," — the same words ending in a period are
 * fine). Played as-is, that is silence while the player still counts through the chunk's duration.
 */

/** Whole-chunk RMS below this is not speech (normal output is around −23 dBFS). */
const SILENT_RMS_DB = -55;

export type SpeechProblem = 'empty' | 'invalid' | 'silent';

/** Why a generated chunk can't be played as speech, or null when it is fine. */
export function speechProblem(samples: Float32Array): SpeechProblem | null {
  if (samples.length === 0) return 'empty';
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (!Number.isFinite(v)) return 'invalid';
    sum += v * v;
  }
  return 10 * Math.log10(sum / samples.length + 1e-12) < SILENT_RMS_DB ? 'silent' : null;
}

/** Replace non-finite samples with silence (they would otherwise reach the speakers as NaN). */
export function scrubNonFinite(samples: Float32Array): void {
  for (let i = 0; i < samples.length; i++) if (!Number.isFinite(samples[i])) samples[i] = 0;
}

/**
 * Alternative wordings to retry a failed chunk with, in order: end the clause as a sentence, then drop the
 * trailing punctuation. Both change the phoneme sequence just enough to avoid the failing case while saying
 * the same words.
 */
export function retryTexts(text: string): string[] {
  const core = text.trim().replace(/[\s,;:—–-]+$/u, '');
  const variants = [/[.!?]$/.test(core) ? core : `${core}.`, core.replace(/[.!?]+$/, '')];
  return [...new Set(variants)].filter((v) => v !== '' && v !== text.trim());
}

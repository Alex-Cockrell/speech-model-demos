/** Display helpers for the meeting mode. */
import { resolveEncoderQuant } from '@local-speech/speech-to-text';
import type { AppSettings } from '@/lib/benchmark/settings';
import type { EnvironmentInfo, ParakeetQuant, ResolvedBackend } from '@/lib/types';
import { BACKEND_LABEL, DASH, fmtBytes } from '../format';

/** 0:42, 42:13, 1:02:05 (meeting lengths, talk time). */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return DASH;
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Local date and time, e.g. "4 Oct 2026, 14:30". */
export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? DASH : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Speakers 1–8 take the categorical palette slots in order; later ones stay neutral (colors are never cycled). */
export function speakerSlot(number: number | null | undefined): number {
  return number != null && number >= 1 && number <= 8 ? number : 0;
}

/**
 * Download sizes (MB = 1e6 bytes) for the expected-size hints. Parakeet (README "Model sizes"): encoder + int8
 * decoder + vocabulary per encoder precision. Speaker model: the fp32 CAM++ ONNX file (SPEAKER_MODEL in config).
 */
const PARAKEET_BYTES: Record<ParakeetQuant, number> = { int8: 670e6, fp16: 1.26e9, fp32: 2.49e9 };
const SPEAKER_MODEL_BYTES = 29.6e6;

export function parakeetEstimate(settings: AppSettings, env: EnvironmentInfo | null): string {
  const backend: ResolvedBackend =
    settings.backend === 'auto' ? (env?.webgpu.adapterAvailable ? 'webgpu' : 'wasm') : settings.backend;
  let quant: ParakeetQuant;
  try {
    quant = env ? resolveEncoderQuant(backend, settings.asr.encoderQuant, env) : 'int8';
  } catch {
    quant = backend === 'webgpu' ? 'fp16' : 'int8';
  }
  return `≈ ${fmtBytes(PARAKEET_BYTES[quant])} the first time (${BACKEND_LABEL[backend]}, ${quant} encoder)`;
}

export function speakerEstimate(): string {
  return `≈ ${fmtBytes(SPEAKER_MODEL_BYTES)} the first time`;
}

import { voiceName } from '@/lib/benchmark/settings';
import { KOKORO_MODEL, PARAKEET_MODEL, SPEAKER_MODEL } from '@/lib/config';
import type { BackendChoice, LoadKind } from '@/lib/types';

export const DASH = '—';

/** [value, unit] — milliseconds below 10 s, seconds above. */
export function msParts(ms: number | null | undefined): [string, string] {
  if (ms == null || !Number.isFinite(ms)) return [DASH, ''];
  const abs = Math.abs(ms);
  if (abs < 10) return [Number.isInteger(ms) ? String(ms === 0 ? 0 : ms) : ms.toFixed(1), 'ms']; // ms === 0 also folds -0
  if (abs < 10_000) return [String(Math.round(ms)), 'ms'];
  return [(ms / 1000).toFixed(abs < 100_000 ? 2 : 1), 's'];
}

export function fmtMs(ms: number | null | undefined): string {
  const [value, unit] = msParts(ms);
  return unit ? `${value} ${unit}` : value;
}

/** Signed offset for timelines, e.g. "+412 ms", "−1.24 s". */
export function fmtOffset(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return DASH;
  return `${ms < 0 ? '−' : '+'}${fmtMs(Math.abs(ms))}`;
}

/** Decimal units (MB = 1e6 bytes), matching DownloadMetrics.effectiveMBps. */
export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return DASH;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e8) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} kB`;
  return `${bytes} B`;
}

export function fmtRate(mbps: number | null | undefined): string {
  if (mbps == null || !Number.isFinite(mbps)) return DASH;
  return `${mbps.toFixed(mbps >= 100 ? 0 : mbps >= 10 ? 1 : 2)} MB/s`;
}

export function fmtRtf(rtf: number | null | undefined): string {
  if (rtf == null || !Number.isFinite(rtf)) return DASH;
  return rtf < 0.1 ? rtf.toFixed(3) : rtf.toFixed(2);
}

/** A 0..1 fraction as a percentage. */
export function fmtPct(fraction: number | null | undefined): string {
  if (fraction == null || !Number.isFinite(fraction)) return DASH;
  return `${(fraction * 100).toFixed(1)}%`;
}

export function fmtInt(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? DASH : String(Math.round(n));
}

export function fmtBool(b: boolean | null | undefined, yes = 'Yes', no = 'No'): string {
  return b == null ? DASH : b ? yes : no;
}

/** Local wall-clock time of an ISO timestamp; adds the date when it isn't today. */
export function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

export const BACKEND_LABEL: Record<BackendChoice, string> = { auto: 'Auto', webgpu: 'WebGPU', wasm: 'WASM' };

export const LOAD_KIND_LABEL: Record<LoadKind, string> = {
  cold: 'Cold',
  warm: 'Warm',
  partial: 'Partial',
  session: 'Session',
};

export const LOAD_KIND_DESCRIPTION: Record<LoadKind, string> = {
  cold: 'every model file came over the network',
  warm: 'every model file came from browser storage',
  partial: 'mix of network and browser storage',
  session: 'already initialized in this page session',
};

export function threadsLabel(n: number): string {
  return n === 0 ? 'auto' : String(n);
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : DASH;
}

/** Weight files by what they are; their real names identify the models. */
const WEIGHT_FILE_LABELS = new Map<string, string>([
  ...Object.entries(PARAKEET_MODEL.files.encoder).flatMap(([quant, files]) =>
    files.map((f, i): [string, string] => [f, `encoder weights (${quant}${i > 0 ? ', data' : ''})`]),
  ),
  [PARAKEET_MODEL.files.decoder, 'decoder weights (int8)'],
  ...Object.entries(KOKORO_MODEL.dtypeFiles).map(([dtype, f]): [string, string] => [f, `model weights (${dtype})`]),
  [SPEAKER_MODEL.files.model, 'model weights (fp32)'],
]);

/**
 * A model or runtime file as shown on screen. Records and the benchmark JSON keep the real names, which give away the
 * models, the runtime and the voice ids, so the UI says what each file is instead.
 */
export function fileLabel(file: string): string {
  const weights = WEIGHT_FILE_LABELS.get(file);
  if (weights) return weights;
  const voice = /^voices\/(.+)\.bin$/.exec(file);
  if (voice) return `voice (${voiceName(voice[1])})`;
  const name = file.slice(file.lastIndexOf('/') + 1);
  if (/\.onnx(?:\.data)?$/i.test(name)) return 'model weights';
  return name.replace(/^ort-/, 'runtime-');
}

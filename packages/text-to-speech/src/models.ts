import type { TtsSettings } from './types.js';

/** Pinned model artifacts (see modelFileUrl in @localspeech/core for the URL layout). */
export const KOKORO_MODEL = {
  displayName: 'Kokoro 82M v1.0 (ONNX)',
  upstream: 'hexgrad/Kokoro-82M',
  repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
  /** Precision → ONNX file inside the repo. */
  dtypeFiles: {
    fp32: 'onnx/model.onnx',
    fp16: 'onnx/model_fp16.onnx',
    q8: 'onnx/model_quantized.onnx',
    q4: 'onnx/model_q4.onnx',
    q4f16: 'onnx/model_q4f16.onnx',
  },
  /** The phoneme vocabulary (kokoro/tokenizer.ts). */
  tokenizerFile: 'tokenizer.json',
  voiceFile: (voice: string) => `voices/${voice}.bin`,
} as const;

/**
 * Self-hosted ONNX Runtime Web files the voice worker loads: the same onnxruntime-web build as speech-to-text, so one
 * copy serves both (copied into public/ort at build time).
 */
export const KOKORO_RUNTIME = { version: '1.24.1', wasmPaths: '/ort/onnxruntime-web-1.24.1/' } as const;

/** phonemizer runs eSpeak NG for the text → phoneme step (kokoro/phonemize.ts, a port of kokoro-js 1.2.1). */
export const KOKORO_LIBRARY_VERSIONS = { phonemizer: '1.2.1' } as const;

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  dtype: 'auto',
  voice: 'af_heart',
  speed: 1,
  split: 'sentence',
  wasmThreads: 0,
};

/** `id` is the voice setting value (the model's voice id); `name` and `label` are for display. */
export const VOICES: readonly { id: string; name: string; label: string }[] = [
  { id: 'af_heart', name: 'Heart', label: 'Heart · US female (default)' },
  { id: 'am_michael', name: 'Michael', label: 'Michael · US male' },
];

/** Display name for a voice id; an id outside VOICES (e.g. from an old record) shows its name part only. */
export function voiceName(id: string): string {
  const known = VOICES.find((v) => v.id === id);
  if (known) return known.name;
  const name = id.slice(id.indexOf('_') + 1);
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : id;
}

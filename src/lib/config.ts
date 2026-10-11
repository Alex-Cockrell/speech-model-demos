import { HUGGING_FACE_BASE_URL } from '@localspeech/core';
import { PARAKEET_LIBRARY_VERSIONS, PARAKEET_RUNTIME } from '@localspeech/speech-to-text';
import { KOKORO_LIBRARY_VERSIONS, KOKORO_RUNTIME } from '@localspeech/text-to-speech';
import type { ModelSource } from './types';

export { HUGGING_FACE_BASE_URL, modelFileUrl } from '@localspeech/core';
export { DEFAULT_ASR_SETTINGS, PARAKEET_MODEL } from '@localspeech/speech-to-text';
export { DEFAULT_TTS_SETTINGS, KOKORO_MODEL } from '@localspeech/text-to-speech';

/**
 * Speaker embeddings for the meeting mode's speaker labels: 3D-Speaker CAM++ trained on VoxCeleb2 (7.2M
 * parameters, 512-dim embeddings, EER 0.65–0.73 % on VoxCeleb1-O), in the ONNX export sherpa-onnx publishes.
 * fp32, 29.6 MB. Runs on onnxruntime-web (ORT_ASSETS.parakeet); details in src/lib/speakers/model.ts.
 */
export const SPEAKER_MODEL = {
  displayName: 'CAM++ speaker embeddings (3D-Speaker, VoxCeleb)',
  upstream: 'iic/speech_campplus_sv_en_voxceleb_16k',
  repo: 'csukuangfj/speaker-embedding-models',
  revision: '0743f301363dec56491a490f6d6cbc9d67f9a3bf',
  files: { model: '3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx' },
} as const;

/** Self-hosted ONNX Runtime Web assets (copied into public/ort at build time by scripts/copy-ort-assets.mjs). */
export const ORT_ASSETS = {
  /** onnxruntime-web used by parakeet.js and the speaker model */
  parakeet: PARAKEET_RUNTIME,
  /** onnxruntime-web bundled with @huggingface/transformers (used by kokoro-js) */
  kokoro: KOKORO_RUNTIME,
} as const;

export const LIBRARY_VERSIONS = { ...PARAKEET_LIBRARY_VERSIONS, ...KOKORO_LIBRARY_VERSIONS } as const;

/**
 * Production builds lock network access to this app and the build's model host (Content-Security-Policy from
 * scripts/network-lock.mjs). The model source is then fixed by the build: the in-app mirror setting is hidden and
 * ignored. `next dev` is unlocked; NETWORK_LOCK=off builds without the lock.
 */
export const NETWORK_LOCKED = process.env.NEXT_PUBLIC_NETWORK_LOCK === 'on';

/** Build-time default; unlocked builds let the UI override it at runtime (persisted per browser). */
export function defaultModelSource(): ModelSource {
  const mirror = process.env.NEXT_PUBLIC_MODEL_BASE_URL?.trim().replace(/\/+$/, '');
  return mirror ? { kind: 'mirror', baseUrl: mirror } : { kind: 'huggingface', baseUrl: HUGGING_FACE_BASE_URL };
}

export const APP_INFO = {
  version: process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0',
  commit: process.env.NEXT_PUBLIC_COMMIT_SHA || null,
  builtAt: process.env.NEXT_PUBLIC_BUILT_AT || null,
};

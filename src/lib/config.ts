import type { AsrSettings, ModelSource, TtsSettings } from './types';

/**
 * Pinned model artifacts. Revisions are commit SHAs so Hugging Face and an R2 mirror serve
 * byte-identical files. Mirror object keys use the same layout as Hugging Face:
 *   {baseUrl}/{repo}/resolve/{revision}/{file}
 */
export const PARAKEET_MODEL = {
  displayName: 'NVIDIA Parakeet TDT 0.6B v3',
  upstream: 'nvidia/parakeet-tdt-0.6b-v3',
  repo: 'ysdede/parakeet-tdt-0.6b-v3-onnx',
  revision: 'f88260fa0777fe0868dda6df85d1a98f012a4a7a',
  files: {
    encoder: {
      int8: ['encoder-model.int8.onnx'],
      fp16: ['encoder-model.fp16.onnx'],
      fp32: ['encoder-model.onnx', 'encoder-model.onnx.data'],
    },
    /** The decoder always runs on WASM in parakeet.js, so int8 is used for every backend. */
    decoder: 'decoder_joint-model.int8.onnx',
    tokenizer: 'vocab.txt',
  },
} as const;

export const KOKORO_MODEL = {
  displayName: 'Kokoro 82M v1.0 (ONNX)',
  upstream: 'hexgrad/Kokoro-82M',
  repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
  /** transformers.js dtype → ONNX file inside the repo. */
  dtypeFiles: {
    fp32: 'onnx/model.onnx',
    fp16: 'onnx/model_fp16.onnx',
    q8: 'onnx/model_quantized.onnx',
    q4: 'onnx/model_q4.onnx',
    q4f16: 'onnx/model_q4f16.onnx',
  },
  supportFiles: ['config.json', 'tokenizer.json', 'tokenizer_config.json'],
  /** kokoro-js fetches voices from this repo at revision 'main'; the fetch instrumentation pins it. */
  voiceFile: (voice: string) => `voices/${voice}.bin`,
} as const;

/** Self-hosted ONNX Runtime Web assets (copied into public/ort at build time). */
export const ORT_ASSETS = {
  /** onnxruntime-web used by parakeet.js */
  parakeet: { version: '1.24.1', wasmPaths: '/ort/onnxruntime-web-1.24.1/' },
  /** onnxruntime-web bundled with @huggingface/transformers (used by kokoro-js) */
  kokoro: { version: '1.22.0-dev.20250409-89f8206ba4', transformers: '3.8.1', wasmPaths: '/ort/transformers-3.8.1/' },
} as const;

export const LIBRARY_VERSIONS = {
  'parakeet.js': '1.4.4',
  'kokoro-js': '1.2.1',
  '@huggingface/transformers': '3.8.1',
} as const;

export const HUGGING_FACE_BASE_URL = 'https://huggingface.co';

/** Build-time default; the UI may override it at runtime (persisted per browser). */
export function defaultModelSource(): ModelSource {
  const mirror = process.env.NEXT_PUBLIC_MODEL_BASE_URL?.trim().replace(/\/+$/, '');
  return mirror ? { kind: 'mirror', baseUrl: mirror } : { kind: 'huggingface', baseUrl: HUGGING_FACE_BASE_URL };
}

export function modelFileUrl(source: ModelSource, repo: string, revision: string, file: string): string {
  return `${source.baseUrl}/${repo}/resolve/${revision}/${file}`;
}

export const DEFAULT_ASR_SETTINGS: AsrSettings = {
  encoderQuant: 'auto',
  chunkMs: 960,
  finalPass: 'full',
  wasmThreads: 0,
};

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  dtype: 'auto',
  voice: 'af_heart',
  speed: 1,
  split: 'sentence',
  wasmThreads: 0,
};

export const APP_INFO = {
  version: process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0',
  commit: process.env.NEXT_PUBLIC_COMMIT_SHA || null,
  builtAt: process.env.NEXT_PUBLIC_BUILT_AT || null,
};

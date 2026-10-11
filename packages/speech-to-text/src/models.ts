import type { AsrSettings } from './types.js';

/** Pinned model artifacts (see modelFileUrl in @local-speech/core for the URL layout). */
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

/** Self-hosted ONNX Runtime Web files for onnxruntime-web, which parakeet.js uses (copied into public/ort at build time). */
export const PARAKEET_RUNTIME = { version: '1.24.1', wasmPaths: '/ort/onnxruntime-web-1.24.1/' } as const;

export const PARAKEET_LIBRARY_VERSIONS = { 'parakeet.js': '1.4.4' } as const;

export const DEFAULT_ASR_SETTINGS: AsrSettings = {
  encoderQuant: 'auto',
  partialIntervalMs: 800,
  minSilenceMs: 600,
  maxSegmentMs: 20_000,
  finalPass: 'segments',
  wasmThreads: 0,
};

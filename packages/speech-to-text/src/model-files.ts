import { PARAKEET_MODEL } from './models.js';
import type { ResolvedBackend, WebGpuInfo } from '@localspeech/core';
import type { AsrSettings, ParakeetQuant } from './types.js';

/** What load() reads of the environment: WebGPU availability (for 'auto') and shader-f16 (for the encoder precision). */
export interface AsrEnvironment {
  webgpu: Pick<WebGpuInfo, 'apiPresent' | 'adapterAvailable' | 'error' | 'shaderF16'>;
}

/** parakeet.js always runs the decoder/joiner on WASM, so the int8 file is used for every backend. */
export const DECODER_QUANT = 'int8';

export interface ParakeetFiles {
  encoder: string;
  /** External weights next to the fp32 encoder graph; ORT maps them by this file name. */
  encoderData: string | null;
  decoder: string;
  tokenizer: string;
}

export function parakeetFiles(quant: ParakeetQuant): ParakeetFiles {
  const encoder: readonly string[] = PARAKEET_MODEL.files.encoder[quant];
  return {
    encoder: encoder[0],
    encoderData: encoder[1] ?? null,
    decoder: PARAKEET_MODEL.files.decoder,
    tokenizer: PARAKEET_MODEL.files.tokenizer,
  };
}

export function expectedFileList(files: ParakeetFiles): string[] {
  return [files.encoder, ...(files.encoderData ? [files.encoderData] : []), files.decoder, files.tokenizer];
}

/**
 * 'auto' → int8 on WASM; on WebGPU fp16 when the adapter has shader-f16, else fp32.
 * Throws for explicit choices that cannot work, so the caller can report (or fall back) clearly.
 */
export function resolveEncoderQuant(
  backend: ResolvedBackend,
  setting: AsrSettings['encoderQuant'],
  environment: AsrEnvironment,
): ParakeetQuant {
  if (backend === 'wasm') return setting === 'auto' ? 'int8' : setting;
  if (setting === 'auto') return environment.webgpu.shaderF16 ? 'fp16' : 'fp32';
  if (setting === 'int8') {
    throw new Error(
      'The int8 encoder cannot run on WebGPU (the runtime has no WebGPU kernels for it). ' +
        'Use fp16/fp32 on WebGPU, or int8 on WASM.',
    );
  }
  return setting;
}

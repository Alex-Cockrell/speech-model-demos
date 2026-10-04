// TEMPORARY bundling smoke test — the TTS agent replaces this file.
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';

self.onmessage = () => {
  self.postMessage({ worker: 'tts', kokoro: typeof KokoroTTS, ort: env.backends.onnx.versions ?? null });
};

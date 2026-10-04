// TEMPORARY bundling smoke test — the ASR agent replaces this file.
import * as ort from 'onnxruntime-web';
import { ParakeetModel } from 'parakeet.js';

self.onmessage = () => {
  self.postMessage({ worker: 'asr', parakeet: typeof ParakeetModel, ort: ort.env.versions });
};

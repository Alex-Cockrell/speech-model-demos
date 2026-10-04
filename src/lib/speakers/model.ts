/**
 * The speaker-embedding model and how its input is prepared. Pinned files: SPEAKER_MODEL in @/lib/config.
 *
 * Choice (phase 2 evaluation, numbers in the speakers report):
 *   3D-Speaker CAM++, VoxCeleb2-trained, 7.2M parameters, 512-dim embeddings, 29.6 MB fp32 ONNX.
 *   - Accuracy: EER 0.65–0.73 % on VoxCeleb1-O (3D-Speaker); measured here 0.8 % on 240 LibriSpeech
 *     test-clean utterances (40 speakers) and 3–15 % within AMI meetings for 1–8 s turns (pairwise, by length:
 *     11 % for 1–2 s, 7 % for 2–4 s, 3 % for 4–8 s, 0.2 % above 8 s).
 *   - Speed: ~3x faster than WeSpeaker ResNet34 / 3D-Speaker ERes2Net at similar accuracy (native ONNX Runtime,
 *     1 thread: 9 vs 27 ms per second of audio).
 *     Edge 154, onnxruntime-web WASM, 1 thread, desktop Ryzen 9: ≈ 40 ms per second of audio (5 s segment
 *     ≈ 170 ms, 12.7 s ≈ 470 ms); 2 threads ≈ 25 ms, 4 threads ≈ 20 ms.
 *   - Input: Kaldi fbank on [-1, 1] samples (Povey window, 80 bins) with mean normalisation — ./fbank.ts.
 *
 * ONNX Runtime ≤ 1.24 computes CAM++'s ceil-mode AveragePool differently from PyTorch; ./onnx-patch.ts
 * fixes the graph in memory after download (without it, embeddings are wrong — see that file).
 */
import type { FbankOptions } from './fbank';
import type { PrepareOptions } from './embed';

export const SPEAKER_SAMPLE_RATE = 16000;

export const SPEAKER_FBANK: FbankOptions = {
  sampleRate: SPEAKER_SAMPLE_RATE,
  frameLength: 400,
  frameShift: 160,
  numMelBins: 80,
  lowFreq: 20,
  highFreq: 0,
  preemphasis: 0.97,
  removeDcOffset: true,
  // torchaudio.compliance.kaldi.fbank defaults, as in 3D-Speaker's training code (speakerlab FBank, dither 0 at inference).
  window: 'povey',
  // 3D-Speaker feeds torchaudio's [-1, 1] floats (sherpa-onnx metadata: normalize_samples=1).
  inputScale: 1,
};

/** ONNX graph names: input [batch, frames, 80] → output [batch, 512]. */
export const SPEAKER_INPUT = 'x';
export const SPEAKER_OUTPUT = 'embedding';

export const SPEAKER_PREPARE: PrepareOptions = {
  // Below about a second of speech an embedding is mostly noise (pairwise EER 11 % at 1–2 s and rising fast).
  minSpeechMs: 1000,
  // Up to 8 s in one pass; longer speech is embedded in equal 4–8 s windows and averaged (as good as one pass on
  // AMI and LibriSpeech, and it keeps a single run bounded).
  maxWindowFrames: 800,
  // Speech = frames within 30 dB of the segment's loud frames (95th percentile) and above -60 dBFS. It only
  // measures how much speech a segment has: the model sees every frame (dropping pauses made EER worse).
  dynamicRangeDb: 30,
  floorDb: -60,
};

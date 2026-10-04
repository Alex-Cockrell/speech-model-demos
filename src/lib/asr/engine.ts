/**
 * ASR engine (main-thread facade). OWNER: ASR agent.
 *
 * Microphone → AudioWorklet PCM capture → 16 kHz mono → Web Worker running parakeet.js
 * (StatefulStreamingTranscriber) → partial transcripts → final transcript.
 *
 * This file currently holds the public interface only; the implementation replaces the bodies.
 */
import type {
  AsrRunMetrics,
  AsrSettings,
  BackendChoice,
  EnvironmentInfo,
  LoadProgress,
  ModelLoadRecord,
  ModelSource,
  PartialUpdate,
} from '../types';

export interface AsrLoadOptions {
  backend: BackendChoice;
  source: ModelSource;
  settings: AsrSettings;
  /** From detectEnvironment(); used to resolve 'auto' backend and quantization. */
  environment: EnvironmentInfo;
  onProgress?: (p: LoadProgress) => void;
}

export interface AsrRecordingCallbacks {
  onPartial?: (update: PartialUpdate) => void;
  onSpeechStart?: (at: number) => void;
  /** Microphone RMS level 0..1, roughly every 50 ms, for a level meter. */
  onLevel?: (rms: number) => void;
}

export class AsrEngine {
  get isLoaded(): boolean {
    return false;
  }

  get loadRecord(): ModelLoadRecord | null {
    return null;
  }

  /**
   * Load (or re-use) the Parakeet model. Same backend + settings + source as the current
   * instance → returns a record with loadKind 'session'. Different config → new worker.
   * backend 'auto' tries WebGPU and falls back to WASM, recording fallbackReason.
   */
  async load(_opts: AsrLoadOptions): Promise<ModelLoadRecord> {
    throw new Error('AsrEngine.load not implemented');
  }

  /** Opens the microphone and starts streaming transcription. Call from a user gesture. */
  async startRecording(_callbacks: AsrRecordingCallbacks): Promise<void> {
    throw new Error('AsrEngine.startRecording not implemented');
  }

  /** Stops the microphone, finalizes the transcript and returns the run's ASR metrics. */
  async stopRecording(): Promise<AsrRunMetrics> {
    throw new Error('AsrEngine.stopRecording not implemented');
  }

  /** Abort a recording without producing metrics. */
  async cancelRecording(): Promise<void> {}

  /** fetch() calls the ASR worker has made since it started (privacy check). */
  async networkRequestCount(): Promise<number> {
    return 0;
  }

  dispose(): void {}
}

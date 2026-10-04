/**
 * TTS engine (main-thread facade). OWNER: TTS agent.
 *
 * Text → Web Worker running kokoro-js stream() → Float32 audio chunks (24 kHz) →
 * Web Audio scheduled playback with underrun / buffer tracking.
 *
 * This file currently holds the public interface only; the implementation replaces the bodies.
 */
import type {
  BackendChoice,
  EnvironmentInfo,
  LoadProgress,
  ModelLoadRecord,
  ModelSource,
  TtsChunkRecord,
  TtsRunMetrics,
  TtsSettings,
} from '../types';

export interface TtsLoadOptions {
  backend: BackendChoice;
  source: ModelSource;
  /** Load-time fields: dtype, wasmThreads, voice (voice file is pre-fetched so offline runs work). */
  settings: TtsSettings;
  environment: EnvironmentInfo;
  onProgress?: (p: LoadProgress) => void;
}

export interface TtsSpeakCallbacks {
  onChunk?: (chunk: TtsChunkRecord) => void;
  onPlaybackStart?: (at: number) => void;
}

export class TtsEngine {
  get isLoaded(): boolean {
    return false;
  }

  get loadRecord(): ModelLoadRecord | null {
    return null;
  }

  /** Same semantics as AsrEngine.load (session reuse, auto fallback). */
  async load(_opts: TtsLoadOptions): Promise<ModelLoadRecord> {
    throw new Error('TtsEngine.load not implemented');
  }

  /**
   * Create/resume the playback AudioContext. Must be called synchronously inside a user-gesture
   * handler (e.g. the Record button click) so later playback is not blocked by autoplay policy.
   */
  unlockAudio(): void {}

  /** Synthesise with kokoro-js streaming and play chunks as they arrive. Resolves after playback completes. */
  async speak(_text: string, _settings: TtsSettings, _callbacks?: TtsSpeakCallbacks): Promise<TtsRunMetrics> {
    throw new Error('TtsEngine.speak not implemented');
  }

  /** Stop generation and playback immediately. */
  stop(): void {}

  /** fetch() calls the TTS worker has made since it started (privacy check). */
  async networkRequestCount(): Promise<number> {
    return 0;
  }

  dispose(): void {}
}

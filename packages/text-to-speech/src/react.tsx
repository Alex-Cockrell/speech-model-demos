'use client';
/**
 * React bindings: one TextToSpeech shared through context, so one component can download the model and any other
 * can speak with it.
 *
 *   <TextToSpeechProvider config={{ voice: 'af_heart' }}>   // or tts={instance}
 *     <DownloadButton />   // useModelDownload()
 *     <ReadButton />       // useSpeak()
 *   </TextToSpeechProvider>
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  createTextToSpeech,
  type DownloadProgress,
  type Playback,
  type PlaybackState,
  type SpeakOptions,
  type StreamingPlayback,
  type TextToSpeech,
  type TextToSpeechConfig,
  type TextToSpeechState,
} from './text-to-speech.js';

const TextToSpeechContext = createContext<TextToSpeech | null>(null);

export type TextToSpeechProviderProps = { children?: ReactNode } & (
  | { /** An instance you created (and dispose) yourself, e.g. at module level. */ tts: TextToSpeech; config?: never }
  | { /** Creates (and disposes) an instance; a changed config creates a new one. */ config?: TextToSpeechConfig; tts?: never }
);

export function TextToSpeechProvider({ tts, config, children }: TextToSpeechProviderProps): ReactNode {
  const configKey = JSON.stringify(config ?? {});
  const owned = useMemo(() => (tts ? null : createTextToSpeech(JSON.parse(configKey) as TextToSpeechConfig)), [tts, configKey]);
  // dispose() leaves the instance reusable, so React's development double-mount is harmless.
  useEffect(() => () => owned?.dispose(), [owned]);
  return <TextToSpeechContext.Provider value={tts ?? owned}>{children}</TextToSpeechContext.Provider>;
}

/** The provider's TextToSpeech instance. */
export function useTextToSpeech(): TextToSpeech {
  const tts = useContext(TextToSpeechContext);
  if (!tts) throw new Error('useTextToSpeech() needs a <TextToSpeechProvider> above it.');
  return tts;
}

/** The model's state (idle / loading with progress / ready / error); re-renders on change. */
export function useTextToSpeechState(): TextToSpeechState {
  const tts = useTextToSpeech();
  return useSyncExternalStore(tts.subscribe, tts.getSnapshot, tts.getSnapshot);
}

export interface ModelDownload {
  status: TextToSpeechState['status'];
  progress: DownloadProgress | null;
  error: string | null;
  /** Whether the files are already stored in this browser; null while checking. */
  cached: boolean | null;
  load: () => Promise<void>;
}

/** Everything a download button / progress bar needs. */
export function useModelDownload(): ModelDownload {
  const tts = useTextToSpeech();
  const state = useTextToSpeechState();
  const [cached, setCached] = useState<boolean | null>(null);
  useEffect(() => {
    if (state.status === 'ready') {
      setCached(true);
      return;
    }
    if (state.status === 'loading') return;
    let live = true;
    void tts.isCached().then((value) => live && setCached(value));
    return () => {
      live = false;
    };
  }, [tts, state.status]);
  const load = useCallback(() => tts.load(), [tts]);
  return { status: state.status, progress: state.progress, error: state.error, cached, load };
}

const NO_PLAYBACK = () => null;
const NOOP_SUBSCRIBE = () => () => undefined;

/** The live state of a playback (or null for none). */
export function usePlaybackState(playback: Playback | null): PlaybackState | null {
  return useSyncExternalStore(
    playback ? playback.subscribe : NOOP_SUBSCRIBE,
    playback ? playback.getSnapshot : NO_PLAYBACK,
    playback ? playback.getSnapshot : NO_PLAYBACK,
  );
}

export interface Speaker {
  /** Speaks a complete text (call from a click the first time). */
  speak: (text: string, options?: SpeakOptions) => Playback;
  /** Starts speaking text that is still arriving: push() deltas, end() when complete. */
  stream: (options?: SpeakOptions) => StreamingPlayback;
  /** Stops the playback started through this hook. */
  cancel: () => void;
  /** The latest playback started through this hook. */
  playback: Playback | null;
  /** Its live state (null before the first speak()). */
  state: PlaybackState | null;
  /** True while that playback is loading, starting, playing or paused. */
  active: boolean;
}

export function useSpeak(): Speaker {
  const tts = useTextToSpeech();
  const [playback, setPlayback] = useState<Playback | null>(null);
  const state = usePlaybackState(playback);
  const speak = useCallback(
    (text: string, options?: SpeakOptions) => {
      const p = tts.speak(text, options);
      setPlayback(p);
      return p;
    },
    [tts],
  );
  const stream = useCallback(
    (options?: SpeakOptions) => {
      const p = tts.stream(options);
      setPlayback(p);
      return p;
    },
    [tts],
  );
  const cancel = useCallback(() => playback?.cancel(), [playback]);
  const active = !!state && ['loading', 'starting', 'playing', 'paused'].includes(state.status);
  return { speak, stream, cancel, playback, state, active };
}

export interface StreamingSpeechInput {
  /** Identifies the text being spoken (e.g. the message id). A new id cancels the previous playback. */
  id: string | null;
  /** The text so far; it may only grow (anything else cancels this id's playback). */
  text: string;
  /** The text is complete. */
  done: boolean;
  /** Off cancels any playback and speaks nothing. */
  enabled: boolean;
  options?: SpeakOptions;
}

/**
 * Speaks a growing text (an LLM reply as it streams in), for any chat library: feed it the latest assistant
 * message's id, text and completion. Audio output must have been unlocked by a click before (TextToSpeech.unlockAudio()
 * in the handler that turns this on), since replies arrive without a user gesture.
 */
export function useStreamingSpeech({ id, text, done, enabled, options }: StreamingSpeechInput): PlaybackState | null {
  const tts = useTextToSpeech();
  const tracked = useRef<{ id: string | null; text: string; ended: boolean; playback: StreamingPlayback | null }>({
    id: null,
    text: '',
    ended: false,
    playback: null,
  });
  const [playback, setPlayback] = useState<StreamingPlayback | null>(null);
  const optionsKey = JSON.stringify(options ?? {});

  useEffect(() => {
    const t = tracked.current;
    if (!enabled || id === null) {
      t.playback?.cancel();
      tracked.current = { id: null, text: '', ended: false, playback: null };
      setPlayback(null);
      return;
    }
    if (t.id !== id) {
      t.playback?.cancel();
      const fresh = tts.stream(JSON.parse(optionsKey) as SpeakOptions);
      tracked.current = { id, text: '', ended: false, playback: fresh };
      setPlayback(fresh);
    }
    const current = tracked.current;
    if (!current.playback) return;
    if (!text.startsWith(current.text)) {
      // The text was rewritten (an edit or regeneration under the same id): stop rather than speak a mix.
      current.playback.cancel();
      current.playback = null;
      return;
    }
    if (text.length > current.text.length) {
      current.playback.push(text.slice(current.text.length));
      current.text = text;
    }
    if (done && !current.ended) {
      current.playback.end();
      current.ended = true;
    }
  }, [tts, id, text, done, enabled, optionsKey]);

  useEffect(
    () => () => {
      tracked.current.playback?.cancel();
      // Forget it too, so React's development re-mount starts a fresh playback instead of feeding a cancelled one.
      tracked.current = { id: null, text: '', ended: false, playback: null };
    },
    [],
  );
  return usePlaybackState(playback);
}

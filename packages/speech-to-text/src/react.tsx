'use client';
/**
 * React bindings: one SpeechToText shared through context, so one component can download the model and any other can
 * dictate with it.
 *
 *   <SpeechToTextProvider config={{}}>     // or stt={instance}
 *     <DownloadButton />   // useSpeechToTextDownload()
 *     <MicButton />        // useDictation()
 *   </SpeechToTextProvider>
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  createSpeechToText,
  type Dictation,
  type DictationOptions,
  type DictationState,
  type DownloadProgress,
  type SpeechToText,
  type SpeechToTextConfig,
  type SpeechToTextState,
} from './speech-to-text.js';

const SpeechToTextContext = createContext<SpeechToText | null>(null);

export type SpeechToTextProviderProps = { children?: ReactNode } & (
  | { /** An instance you created (and dispose) yourself, e.g. at module level. */ stt: SpeechToText; config?: never }
  | { /** Creates (and disposes) an instance; a changed config creates a new one. */ config?: SpeechToTextConfig; stt?: never }
);

export function SpeechToTextProvider({ stt, config, children }: SpeechToTextProviderProps): ReactNode {
  const configKey = JSON.stringify(config ?? {});
  const owned = useMemo(() => (stt ? null : createSpeechToText(JSON.parse(configKey) as SpeechToTextConfig)), [stt, configKey]);
  // dispose() leaves the instance reusable, so React's development double-mount is harmless.
  useEffect(() => () => owned?.dispose(), [owned]);
  return <SpeechToTextContext.Provider value={stt ?? owned}>{children}</SpeechToTextContext.Provider>;
}

/** The provider's SpeechToText instance. */
export function useSpeechToText(): SpeechToText {
  const stt = useContext(SpeechToTextContext);
  if (!stt) throw new Error('useSpeechToText() needs a <SpeechToTextProvider> above it.');
  return stt;
}

/** The model's state (idle / loading with progress / ready / error); re-renders on change. */
export function useSpeechToTextState(): SpeechToTextState {
  const stt = useSpeechToText();
  return useSyncExternalStore(stt.subscribe, stt.getSnapshot, stt.getSnapshot);
}

export interface SpeechToTextDownload {
  status: SpeechToTextState['status'];
  progress: DownloadProgress | null;
  error: string | null;
  /** Whether the files are already stored in this browser; null while checking. */
  cached: boolean | null;
  load: () => Promise<void>;
}

/** Everything a download button / progress bar for the transcription model needs. */
export function useSpeechToTextDownload(): SpeechToTextDownload {
  const stt = useSpeechToText();
  const state = useSpeechToTextState();
  const [cached, setCached] = useState<boolean | null>(null);
  useEffect(() => {
    if (state.status === 'ready') {
      setCached(true);
      return;
    }
    if (state.status === 'loading') return;
    let live = true;
    void stt.isCached().then((value) => live && setCached(value));
    return () => {
      live = false;
    };
  }, [stt, state.status]);
  const load = useCallback(() => stt.load(), [stt]);
  return { status: state.status, progress: state.progress, error: state.error, cached, load };
}

const NO_DICTATION = () => null;
const NOOP_SUBSCRIBE = () => () => undefined;

/** The live state of a dictation (or null for none). */
export function useDictationState(dictation: Dictation | null): DictationState | null {
  return useSyncExternalStore(
    dictation ? dictation.subscribe : NOOP_SUBSCRIBE,
    dictation ? dictation.getSnapshot : NO_DICTATION,
    dictation ? dictation.getSnapshot : NO_DICTATION,
  );
}

export interface DictationControls {
  /** Starts listening to the microphone (the browser asks for permission the first time). */
  start: (options?: DictationOptions) => Dictation;
  /** Stops and resolves with the final text ('' when nothing is running). */
  stop: () => Promise<string>;
  cancel: () => void;
  dictation: Dictation | null;
  state: DictationState | null;
  /** Live text: finished segments plus the one being spoken. */
  text: string;
  /** True from start() until it has stopped. */
  listening: boolean;
}

export function useDictation(): DictationControls {
  const stt = useSpeechToText();
  const [dictation, setDictation] = useState<Dictation | null>(null);
  const state = useDictationState(dictation);
  const start = useCallback(
    (options?: DictationOptions) => {
      const d = stt.dictate(options);
      setDictation(d);
      return d;
    },
    [stt],
  );
  const stop = useCallback(() => (dictation ? dictation.stop() : Promise.resolve('')), [dictation]);
  const cancel = useCallback(() => dictation?.cancel(), [dictation]);
  const listening = !!state && ['loading', 'starting', 'listening', 'stopping'].includes(state.status);
  return { start, stop, cancel, dictation, state, text: state?.text ?? '', listening };
}

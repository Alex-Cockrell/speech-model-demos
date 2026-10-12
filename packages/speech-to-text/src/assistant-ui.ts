/**
 * assistant-ui integration (https://www.assistant-ui.com), checked against @assistant-ui/react 0.15: local dictation
 * for the composer's ComposerPrimitive.Dictate button.
 *
 *   const runtime = useChatRuntime({ adapters: { dictation: createDictationAdapter(stt) } });
 *
 * Follows the runtime's rules: live text is sent as { isFinal: false } (it replaces the preview), each finished
 * segment as { isFinal: true } (appended to the composer), the last final before stop() resolves, and onSpeechEnd
 * only once, when the whole dictation has ended.
 */
import type { Dictation, DictationOptions } from './speech-to-text.js';

/** Structurally identical to assistant-ui's DictationAdapter.Status. */
export type DictationAdapterStatus = { type: 'starting' | 'running' } | { type: 'ended'; reason: 'stopped' | 'cancelled' | 'error' };

/** Structurally identical to assistant-ui's DictationAdapter.Result. */
export interface DictationAdapterResult {
  transcript: string;
  isFinal?: boolean;
}

/** Structurally identical to assistant-ui's DictationAdapter.Session. */
export interface DictationAdapterSession {
  readonly status: DictationAdapterStatus;
  stop: () => Promise<void>;
  cancel: () => void;
  onSpeechStart: (callback: () => void) => () => void;
  onSpeechEnd: (callback: (result: DictationAdapterResult) => void) => () => void;
  onSpeech: (callback: (result: DictationAdapterResult) => void) => () => void;
}

/** Assignable to assistant-ui's DictationAdapter (adapters.dictation). */
export interface LocalDictationAdapter {
  listen: () => DictationAdapterSession;
  disableInputDuringDictation?: boolean;
}

/** What the adapter needs: a SpeechToText, or anything with the same dictate(). */
export interface DictationSource {
  dictate(options?: DictationOptions): Dictation;
}

export interface DictationAdapterOptions {
  /** Passed to dictate() (e.g. a specific microphone stream). */
  dictation?: Omit<DictationOptions, 'onPartial' | 'onFinal'>;
}

export function createDictationAdapter(stt: DictationSource, options: DictationAdapterOptions = {}): LocalDictationAdapter {
  return {
    // The composer stays editable: finals are appended to what the user typed.
    disableInputDuringDictation: false,
    listen() {
      const speech = new Set<(result: DictationAdapterResult) => void>();
      const starts = new Set<() => void>();
      const ends = new Set<(result: DictationAdapterResult) => void>();
      let status: DictationAdapterStatus = { type: 'starting' };
      let started = false;
      let endFired = false;
      const emit = <T>(callbacks: Set<(arg: T) => void>, arg: T) => {
        for (const callback of [...callbacks]) {
          try {
            callback(arg);
          } catch (error) {
            console.error('Dictation adapter callback threw', error);
          }
        }
      };

      const dictation = stt.dictate({
        ...options.dictation,
        onPartial: (text) => emit(speech, { transcript: text, isFinal: false }),
        // A segment without words clears the preview instead of appending nothing.
        onFinal: (text) => emit(speech, text.trim() ? { transcript: text, isFinal: true } : { transcript: '', isFinal: false }),
      });

      const sync = () => {
        const state = dictation.getSnapshot();
        if (state.status === 'listening' && !started) {
          started = true;
          status = { type: 'running' };
          emit(starts, undefined);
        } else if (state.status === 'ended' || state.status === 'cancelled' || state.status === 'error') {
          status = { type: 'ended', reason: state.status === 'ended' ? 'stopped' : state.status === 'cancelled' ? 'cancelled' : 'error' };
          if (!endFired) {
            endFired = true;
            emit(ends, { transcript: state.finalText, isFinal: true });
          }
        }
      };
      dictation.subscribe(sync);
      sync();

      const register = <T>(callbacks: Set<T>, callback: T) => {
        callbacks.add(callback);
        return () => {
          callbacks.delete(callback);
        };
      };
      return {
        get status() {
          return status;
        },
        async stop() {
          await dictation.stop();
          sync();
        },
        cancel() {
          dictation.cancel();
          sync();
        },
        onSpeechStart: (callback) => register(starts, callback),
        onSpeechEnd: (callback) => register(ends, callback),
        onSpeech: (callback) => register(speech, callback),
      };
    },
  };
}

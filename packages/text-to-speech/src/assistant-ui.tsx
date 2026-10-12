'use client';
/**
 * assistant-ui integration (https://www.assistant-ui.com), checked against @assistant-ui/react 0.15.
 *
 * Read-aloud button (ActionBarPrimitive.Speak), with the message text once it has finished streaming:
 *
 *   const runtime = useChatRuntime({ adapters: { speech: createSpeechSynthesisAdapter(tts) } });
 *
 * Reading replies aloud while they stream in (assistant-ui itself only speaks finished messages): render
 * <ReadAloudWhileStreaming enabled={on} /> inside <AssistantRuntimeProvider> and <TextToSpeechProvider>, and call
 * tts.unlockAudio() in the click that turns it on.
 */
import { useAuiState } from '@assistant-ui/react';
import { useState, type ReactNode } from 'react';
import { useStreamingSpeech } from './react.js';
import type { PlaybackState, SpeakOptions, TextToSpeech } from './text-to-speech.js';

/** Structurally identical to assistant-ui's SpeechSynthesisAdapter.Status. */
export type SpeechSynthesisStatus =
  | { type: 'starting' | 'running' }
  | { type: 'ended'; reason: 'finished' | 'cancelled' | 'error'; error?: unknown };

/** Structurally identical to assistant-ui's SpeechSynthesisAdapter.Utterance. */
export interface SpeechSynthesisUtteranceHandle {
  readonly status: SpeechSynthesisStatus;
  cancel: () => void;
  subscribe: (callback: () => void) => () => void;
}

/** Assignable to assistant-ui's SpeechSynthesisAdapter (adapters.speech). */
export interface LocalSpeechSynthesisAdapter {
  speak: (text: string) => SpeechSynthesisUtteranceHandle;
}

export function createSpeechSynthesisAdapter(tts: TextToSpeech, options: SpeakOptions = {}): LocalSpeechSynthesisAdapter {
  return {
    speak(text) {
      const playback = tts.speak(text, options);
      const status = (): SpeechSynthesisStatus => {
        const { status: s, error } = playback.getSnapshot();
        switch (s) {
          case 'loading':
          case 'starting':
            return { type: 'starting' };
          case 'playing':
          case 'paused':
            return { type: 'running' };
          case 'ended':
            return { type: 'ended', reason: 'finished' };
          case 'cancelled':
            return { type: 'ended', reason: 'cancelled' };
          case 'error':
            return { type: 'ended', reason: 'error', error };
        }
      };
      return {
        get status() {
          return status();
        },
        cancel: () => playback.cancel(),
        subscribe(callback) {
          const unsubscribe = playback.subscribe(callback);
          // Like assistant-ui's own adapter: a late subscriber to a finished utterance still hears about it.
          if (status().type === 'ended') queueMicrotask(callback);
          return unsubscribe;
        },
      };
    },
  };
}

interface MessageLike {
  id: string;
  role: string;
  status?: { type: string };
  content: readonly { type: string; text?: string }[];
}

function lastAssistant(messages: readonly MessageLike[]): MessageLike | undefined {
  const last = messages.at(-1);
  return last?.role === 'assistant' ? last : undefined;
}

/** The text parts joined as assistant-ui joins them for its read-aloud button. */
function textOf(message: MessageLike | undefined): string {
  if (!message) return '';
  return message.content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n\n');
}

export interface ReadAloudWhileStreamingProps {
  enabled: boolean;
  options?: SpeakOptions;
}

/**
 * Speaks each new assistant reply while it streams in. A reply that had already finished when this was enabled is not
 * read; a new user message stops the current reply. Needs <AssistantRuntimeProvider> and <TextToSpeechProvider>.
 */
export function useReadAloudWhileStreaming({ enabled, options }: ReadAloudWhileStreamingProps): PlaybackState | null {
  const id = useAuiState((s) => lastAssistant(s.thread.messages as readonly MessageLike[])?.id ?? null);
  const text = useAuiState((s) => textOf(lastAssistant(s.thread.messages as readonly MessageLike[])));
  const done = useAuiState((s) => {
    const message = lastAssistant(s.thread.messages as readonly MessageLike[]);
    return !!message && message.status?.type !== 'running';
  });
  // The reply on screen when reading was switched on is history, unless it is still streaming.
  const [skip, setSkip] = useState<{ enabled: boolean; id: string | null }>({ enabled, id: done ? id : null });
  if (skip.enabled !== enabled) setSkip({ enabled, id: enabled && done ? id : null });
  const target = id !== null && id !== skip.id ? id : null;
  return useStreamingSpeech({ id: target, text, done, enabled, options });
}

export function ReadAloudWhileStreaming(props: ReadAloudWhileStreamingProps): ReactNode {
  useReadAloudWhileStreaming(props);
  return null;
}

'use client';
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  type ChatModelAdapter,
} from '@assistant-ui/react';
import { createSpeechSynthesisAdapter, useReadAloudWhileStreaming } from '@localspeech/text-to-speech/assistant-ui';
import { TextToSpeechProvider, useModelDownload, useTextToSpeech } from '@localspeech/text-to-speech/react';
import { useMemo, useState } from 'react';

/** Stands in for an LLM: streams a canned markdown reply a few characters at a time. */
const REPLY =
  "Sure! Here's a quick overview.\n\n" +
  'Local speech runs **entirely in your browser**, so nothing you say is uploaded.\n\n' +
  '1. The voice model downloads once and stays cached.\n' +
  '2. Replies are spoken while they stream in.\n' +
  '3. You can stop at any time.\n\n' +
  "That's it. Enjoy!";

const fakeModel: ChatModelAdapter = {
  async *run({ abortSignal }) {
    for (let i = 3; i <= REPLY.length + 2; i += 3) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (abortSignal.aborted) return;
      yield { content: [{ type: 'text', text: REPLY.slice(0, i) }] };
    }
  },
};

export default function Page() {
  // Configuration is plain data: in a real app it could come from your backend.
  return (
    <TextToSpeechProvider config={{ voice: 'af_heart' }}>
      <Chat />
    </TextToSpeechProvider>
  );
}

function Chat() {
  const tts = useTextToSpeech();
  const speech = useMemo(() => createSpeechSynthesisAdapter(tts), [tts]);
  const runtime = useLocalRuntime(fakeModel, { adapters: { speech } });
  const [readAloud, setReadAloud] = useState(false);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <h1>Local speech · assistant-ui</h1>
      <VoicePanel />
      <div className="panel">
        <label>
          <input
            type="checkbox"
            data-testid="read-aloud-toggle"
            checked={readAloud}
            onChange={(e) => {
              tts.unlockAudio(); // this click is the gesture that lets later replies play
              setReadAloud(e.target.checked);
            }}
          />{' '}
          Read replies aloud while they stream in
        </label>
        <AutoReadStatus enabled={readAloud} />
      </div>
      <Thread />
    </AssistantRuntimeProvider>
  );
}

/** Downloads the voice model; any other component can then speak with it (same provider). */
function VoicePanel() {
  const { status, progress, cached, error, load } = useModelDownload();
  const percent = progress?.fraction != null ? Math.round(progress.fraction * 100) : null;
  return (
    <div className="panel">
      <button type="button" data-testid="download" onClick={() => void load().catch(() => undefined)} disabled={status === 'loading' || status === 'ready'}>
        {status === 'ready' ? 'Voice ready' : cached ? 'Load voice (cached)' : 'Download voice'}
      </button>
      <span data-testid="voice-status">
        {status}
        {status === 'loading' && percent !== null ? ` · ${percent}%` : ''}
        {error ? ` · ${error}` : ''}
      </span>
    </div>
  );
}

function AutoReadStatus({ enabled }: { enabled: boolean }) {
  const state = useReadAloudWhileStreaming({ enabled });
  return <span data-testid="auto-read">{enabled ? (state?.status ?? 'waiting for a reply') : 'off'}</span>;
}

function Thread() {
  return (
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport>
        <ThreadPrimitive.Messages>
          {({ message }) => (message.role === 'user' ? <UserMessage /> : <AssistantMessage />)}
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>
      <ComposerPrimitive.Root className="composer">
        <ComposerPrimitive.Input placeholder="Say something…" data-testid="composer" />
        <ComposerPrimitive.Send data-testid="send">Send</ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="message user">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="message assistant" data-testid="assistant-message">
      <MessagePrimitive.Parts />
      <ActionBarPrimitive.Root>
        <AuiIf condition={(s) => s.message.speech == null}>
          <ActionBarPrimitive.Speak data-testid="speak">Read aloud</ActionBarPrimitive.Speak>
        </AuiIf>
        <AuiIf condition={(s) => s.message.speech != null}>
          <ActionBarPrimitive.StopSpeaking data-testid="stop-speaking">Stop</ActionBarPrimitive.StopSpeaking>
        </AuiIf>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

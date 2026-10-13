# localspeech

**Speech-to-text and text-to-speech that run entirely in the browser.** No server, no API keys, no per-minute bills,
and the user's voice and text never leave their device.

[![CI](https://github.com/Alex-Cockrell/speech-model-demos/actions/workflows/ci.yml/badge.svg)](https://github.com/Alex-Cockrell/speech-model-demos/actions/workflows/ci.yml)
[![npm: text-to-speech](https://img.shields.io/npm/v/@localspeech/text-to-speech?label=%40localspeech%2Ftext-to-speech)](https://www.npmjs.com/package/@localspeech/text-to-speech)
[![npm: speech-to-text](https://img.shields.io/npm/v/@localspeech/speech-to-text?label=%40localspeech%2Fspeech-to-text)](https://www.npmjs.com/package/@localspeech/speech-to-text)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[Try the live demo →](https://speechmodeldemos.projects.alex.cockrell.ai)** (meeting transcription, read aloud and a
benchmark; Chrome or Edge recommended)

## What you get

- **Read aloud, including while an LLM is still answering.** Push tokens in as they stream; each sentence is spoken as
  soon as it is complete, with playback that stays ahead without stalling. Markdown is read the way a person would
  read it: no asterisks, links as their text, code announced rather than spelled out.
- **Live dictation and transcription.** Text appears while you speak and settles into punctuated sentences when you
  pause. 25 European languages, detected automatically. Microphone, a recording, or a shared call or tab.
- **Drop-in for chat UIs.** React hooks for any app, and ready-made adapters for
  [assistant-ui](https://www.assistant-ui.com)'s read-aloud and dictation buttons.
- **Works on locked-down networks.** One command downloads the pinned model files so your own site can serve them;
  then nothing is fetched from anywhere else. A strict Content-Security-Policy is supported.
- **Fast enough to feel instant.** Even without a GPU (WebAssembly on 8 CPU threads), speech starts in about 1.3 s and
  generates at roughly 3× real time; WebGPU is used automatically when available.
- **Clean bill of health.** Zero `npm audit` findings, enforced in CI, and tests that check streamed speech is exactly
  what reading the finished text would produce.

## Packages

| Package | |
| --- | --- |
| [`@localspeech/text-to-speech`](packages/text-to-speech) | Speak finished text or a streaming LLM reply; synthesize audio files; React hooks; assistant-ui read-aloud adapters |
| [`@localspeech/speech-to-text`](packages/speech-to-text) | Dictation with live text, file transcription, microphone + call-audio sessions; React hooks; assistant-ui dictation adapter |
| [`@localspeech/core`](packages/core) | Shared model download and caching, and the `localspeech-assets` / `localspeech-models` commands |

```sh
npm install @localspeech/text-to-speech @localspeech/speech-to-text
```

## Quick start

```ts
import { createTextToSpeech } from '@localspeech/text-to-speech';
import { createSpeechToText } from '@localspeech/speech-to-text';

// Text to speech: the model downloads on first use and is cached in the browser.
const tts = createTextToSpeech({ voice: 'af_heart' });
speakButton.onclick = () => tts.speak('Hello! This voice runs entirely in your browser.');

// An LLM reply as it streams in.
const live = tts.stream();
for await (const delta of reply) live.push(delta);
live.end();

// Speech to text.
const stt = createSpeechToText();
const dictation = stt.dictate({ onPartial: (text) => (preview.textContent = text) });
const text = await dictation.stop();
```

Your site serves two small runtime files and should send two security headers; both are covered, with a Next.js
example, in the [text-to-speech README](packages/text-to-speech#serving-the-runtime-files-required).

### In an assistant-ui chat

```tsx
const tts = useTextToSpeech();
const stt = useSpeechToText();
const adapters = useMemo(
  () => ({ speech: createSpeechSynthesisAdapter(tts), dictation: createDictationAdapter(stt) }),
  [tts, stt],
);
const runtime = useChatRuntime({ adapters });   // the Speak and Dictate buttons now run locally

<ReadAloudWhileStreaming enabled={autoRead} />   // optional: speak replies while they stream in
```

[examples/assistant-ui-chat](examples/assistant-ui-chat) is a complete, runnable chat with both.

## How it works

```text
text ──► markdown-aware sentence planner ──► Kokoro 82M ──► Web Audio playback (read-ahead, pause, seek)
microphone / call audio ──► voice-activity segmentation ──► Parakeet TDT 0.6B v3 ──► live text, then final text
```

Both models run in Web Workers on [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/), using WebGPU when
the device has it and multithreaded WebAssembly otherwise. Model files are pinned to exact revisions and stored in the
browser's Cache API, so the download happens once (≈160 MB for the voice, ≈670 MB for transcription on WebAssembly).

| | Model | License | Languages |
| --- | --- | --- | --- |
| Text to speech | [Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M) | Apache-2.0 | English (US and UK voices) |
| Speech to text | [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) | CC-BY-4.0 | 25 European languages |

The model weights are downloaded at runtime and are not part of this repository or the packages. The text-to-speech
package depends on eSpeak NG (GPL-3.0) for pronunciation; see its
[third-party notices](packages/text-to-speech/THIRD_PARTY_NOTICES.md).

## The demo app

The [live demo](https://speechmodeldemos.projects.alex.cockrell.ai) is the Next.js app in this repository's root. It
uses the packages exactly as any other site would and adds:

- **Meeting transcription**: microphone and call audio together, speakers labelled and renamable, transcripts saved in
  the browser and exported as Markdown, text, JSON, WebVTT or SRT.
- **Read aloud**: paste a document and listen, with sentence highlighting, pause and seek.
- **Benchmark**: every stage timed (download, initialization, time to first text and first audio, playback
  continuity), exportable as JSON.

Running it, deploying it to Cloudflare, mirroring the models to R2, the test matrix and troubleshooting are in
[docs/demo-app.md](docs/demo-app.md).

## Development

Needs Node.js 20.9+ and a current Chrome or Edge.

```sh
npm install
npm run dev               # the demo app on http://localhost:3000 (builds the packages first)
npm test                  # unit tests
npm run typecheck
npm run audit:prod        # no high or critical advisories allowed
npm run pack:packages     # the exact tarballs that would be published, in .tarballs/
```

```text
packages/core             shared plumbing and the command-line tools
packages/text-to-speech   the Kokoro engine, streaming planner, React and assistant-ui bindings
packages/speech-to-text   the Parakeet engine, dictation, React and assistant-ui bindings
examples/assistant-ui-chat  a chat that installs the packed packages
src/                      the demo app (UI, benchmark, meeting mode, speaker labels)
docs/                     the demo app's guide
```

Changes to the packages come with a changeset (`npx changeset`), which drives versions and changelogs.

## License

[MIT](LICENSE) © Alex Cockrell. Model weights and third-party components keep their own licenses, listed above and in
each package.

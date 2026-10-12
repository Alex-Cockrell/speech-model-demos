# @localspeech/text-to-speech

Natural-sounding text-to-speech that runs **entirely in the browser**: no server, no API key, and the text never leaves
the device. It speaks finished text, or text that is **still streaming in** from an LLM, starting at the first complete
sentence. React hooks and [assistant-ui](https://www.assistant-ui.com) adapters are included.

- Model: [Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M) on ONNX Runtime Web (WebGPU, or multithreaded WASM).
- Streaming input: `push()` text as it arrives; complete sentences are spoken at once, the rest when it completes.
- Read-ahead playback: generation stays a bounded distance (30 s) ahead of playback; pause, resume, cancel.
- Markdown is read the way a listener expects: no symbols, links read as their text, lists as sentences, code
  announced rather than spelled out.
- Downloads once (≈163 MB on WASM, ≈326 MB on WebGPU) and is cached in the browser; can be served from your own
  origin for locked-down networks.
- English (US and UK voices).

```sh
npm install @localspeech/text-to-speech
```

## Quick start

```ts
import { createTextToSpeech } from '@localspeech/text-to-speech';

const tts = createTextToSpeech({ voice: 'af_heart' });   // nothing is downloaded yet

button.onclick = () => tts.speak('Hello! This voice runs entirely in your browser.');   // loads on first use

// An LLM reply as it streams in:
const live = tts.stream();
for await (const delta of replyStream) live.push(delta);
live.end();
await live.done;   // 'finished' or 'cancelled'
```

Call `speak()` / `stream()` from a click (or call `tts.unlockAudio()` in one first): browsers only start audio output
after a user gesture.

## Serving the runtime files (required)

ONNX Runtime's `.wasm`/`.mjs` files must be served from your own origin. The `localspeech-assets` command (installed
with the package) copies them to `public/localspeech/`, which is the default `runtimeUrl`:

```json
{ "scripts": { "predev": "localspeech-assets", "prebuild": "localspeech-assets" } }
```

Serve your pages **cross-origin isolated** so inference can use several CPU threads (without it, WASM runs on one thread
and is several times slower; WebGPU is unaffected):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp      (or credentialless, if you embed third-party content)
```

In Next.js:

```ts
// next.config.ts
export default {
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
    ] }];
  },
};
```

With a Content-Security-Policy, allow `worker-src 'self' blob:`, `script-src 'wasm-unsafe-eval'` and, in
`connect-src`, the model host (`https://huggingface.co https://*.huggingface.co https://*.hf.co`, or your own).

## Configuration

`createTextToSpeech(config)` takes plain data, so it can come from build-time env or your backend.

| Option | Default | |
| --- | --- | --- |
| `voice` | `'af_heart'` | Voice id, downloaded with the model (e.g. `af_heart`, `am_michael`, `bf_emma`, `bm_george`). |
| `speed` | `1` | Speaking rate, 0.5–2. |
| `backend` | `'auto'` | `'auto'` (WebGPU, falling back to WASM), `'webgpu'` or `'wasm'`. |
| `precision` | `'auto'` | `fp16` on WASM, `fp32` on WebGPU; or `fp32`, `fp16`, `q8`, `q4`, `q4f16`. |
| `modelBaseUrl` | `https://huggingface.co` | A mirror with the same layout, or a path on your site (see Self-hosting). |
| `runtimeUrl` | `/localspeech/onnxruntime-web-<version>/` | Where the runtime files are served. |
| `split` | `'sentence'` | `'clause'` also splits at `, ; :` for earlier audio on slow machines. |
| `readAheadSec` | `30` | How far generation runs ahead of playback. |
| `wasmThreads` | `0` | WASM threads; 0 = automatic. |

## API

```ts
const tts = createTextToSpeech(config);

tts.getSnapshot();          // { status: 'idle' | 'loading' | 'ready' | 'error', progress, error, backend, precision }
tts.subscribe(listener);    // returns unsubscribe (works with React's useSyncExternalStore)
await tts.load();           // optional; concurrent calls share one load
await tts.isCached();       // already in browser storage? (for "Download voice (163 MB)" vs instant)

const playback = tts.speak(text, { voice?, speed?, format?: 'markdown' | 'plain' });
const live = tts.stream(options);   // live.push(delta) … live.end()
playback.getSnapshot();     // { status: 'loading' | 'starting' | 'playing' | 'paused' | 'ended' | 'cancelled' | 'error', error }
playback.pause(); playback.resume(); playback.cancel();
await playback.done;        // 'finished' | 'cancelled'; rejects on failure

const { samples, sampleRate, toWav } = await tts.synthesize(text);   // audio without playback
tts.unlockAudio();          // call in a click before playback that starts without one
tts.dispose();              // releases the model; the object stays usable
```

One playback at a time: starting a new one cancels the previous.

**Streaming text.** Each update re-plans the text received so far and speaks every sentence except the last one, which
may still grow (a sentence counts as complete once the next one has started). Paragraphs close at a blank line. While
the structure is ambiguous it waits: inside an unclosed code fence, possible front matter, a line that may become a
table row. The result is exactly what reading the finished text would produce.

## React

```tsx
import { TextToSpeechProvider, useSpeak, useTextToSpeechDownload } from '@localspeech/text-to-speech/react';

export function App() {
  return (
    <TextToSpeechProvider config={{ voice: 'af_heart' }}>   {/* or tts={instance} */}
      <DownloadButton />
      <ReadButton text="Hello from React." />
    </TextToSpeechProvider>
  );
}

function DownloadButton() {
  const { status, progress, cached, load } = useTextToSpeechDownload();
  if (status === 'ready') return <span>Voice ready</span>;
  const pct = progress?.fraction != null ? ` ${Math.round(progress.fraction * 100)}%` : '';
  return <button onClick={() => load()} disabled={status === 'loading'}>{cached ? 'Load voice' : `Download voice${pct}`}</button>;
}

function ReadButton({ text }: { text: string }) {
  const { speak, cancel, active } = useSpeak();
  return <button onClick={() => (active ? cancel() : speak(text))}>{active ? 'Stop' : 'Read aloud'}</button>;
}
```

Also: `useTextToSpeech()` (the instance), `useTextToSpeechState()`, `usePlaybackState(playback)`, and
`useStreamingSpeech({ id, text, done, enabled })`, which speaks a growing message for any chat library (feed it the
latest assistant message's id, text and completion).

## assistant-ui

```tsx
import { createSpeechSynthesisAdapter, ReadAloudWhileStreaming } from '@localspeech/text-to-speech/assistant-ui';
import { useTextToSpeech } from '@localspeech/text-to-speech/react';

function Chat() {
  const tts = useTextToSpeech();
  const speech = useMemo(() => createSpeechSynthesisAdapter(tts), [tts]);
  const runtime = useChatRuntime({ adapters: { speech } });   // ActionBarPrimitive.Speak now uses it
  const [autoRead, setAutoRead] = useState(false);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <label>
        <input type="checkbox" checked={autoRead} onChange={(e) => { tts.unlockAudio(); setAutoRead(e.target.checked); }} />
        Read replies aloud
      </label>
      <ReadAloudWhileStreaming enabled={autoRead} />   {/* speaks each reply while it streams in */}
      <Thread />
    </AssistantRuntimeProvider>
  );
}
```

assistant-ui's own speech support reads a message only after it has finished; `ReadAloudWhileStreaming` (or the
`useReadAloudWhileStreaming` hook) adds reading as it streams. A reply that was already finished when reading was
switched on is not read; a new user message stops the current reply. Checked against `@assistant-ui/react` 0.15.

## Self-hosting the model (locked-down networks)

```sh
npx localspeech-models public/models --tts      # downloads the pinned files into public/models/
```

then `createTextToSpeech({ modelBaseUrl: '/models' })`. Nothing is then fetched from huggingface.co. Use
`--tts-precision` and `--voices` to choose what to download (`--help` lists everything).

## Browser support

Current Chrome and Edge (WebGPU, or WASM). Other browsers with WebAssembly SIMD should work on WASM; Safari and mobile
browsers are untested. The voice model needs about 0.5–1 GB of memory while loading.

## Licenses

MIT. The model weights are downloaded at runtime and not included: Kokoro 82M is Apache-2.0. The text pipeline is
ported from [kokoro-js](https://github.com/hexgrad/kokoro/tree/main/kokoro.js) (Apache-2.0); its dependency
`phonemizer` embeds **eSpeak NG, which is GPL-3.0**, so applications that bundle this package ship GPL-3.0 code. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Related projects

[kokoro-js](https://www.npmjs.com/package/kokoro-js) (the model runner this builds on),
[LocalMode](https://github.com/LocalMode-AI/LocalMode) (a broad local-AI toolkit with Kokoro playback),
[FluidAudio Web](https://github.com/FluidInference/fluidaudio-web) (Kokoro and Parakeet SDK) and the
[transformers.js examples](https://github.com/huggingface/transformers.js-examples). This package focuses on streamed
LLM text, read-ahead playback and assistant-ui integration.

Part of [localspeech](https://github.com/Alex-Cockrell/speech-model-demos); see also
[`@localspeech/speech-to-text`](https://github.com/Alex-Cockrell/speech-model-demos/tree/main/packages/speech-to-text).

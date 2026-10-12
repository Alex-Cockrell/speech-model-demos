# @localspeech/speech-to-text

Live speech-to-text that runs **entirely in the browser**: no server, no API key, and audio never leaves the device.
Dictation with live text, transcription of recordings, and multi-source sessions (microphone plus a shared call or
tab). React hooks and an [assistant-ui](https://www.assistant-ui.com) dictation adapter are included.

- Model: [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) on ONNX Runtime Web
  (WebGPU, or multithreaded WASM), with punctuation and capitalization.
- 25 European languages, detected automatically: Bulgarian, Croatian, Czech, Danish, Dutch, English, Estonian,
  Finnish, French, German, Greek, Hungarian, Italian, Latvian, Lithuanian, Maltese, Polish, Portuguese, Romanian,
  Russian, Slovak, Slovenian, Spanish, Swedish, Ukrainian.
- Live text: speech is cut into segments at pauses; the open segment is re-transcribed while you speak (every
  800 ms), then finalized with word timings when you pause.
- Downloads once (≈670 MB on WASM, ≈1.2 GB on WebGPU) and is cached in the browser; can be served from your own origin
  for locked-down networks.

```sh
npm install @localspeech/speech-to-text
```

## Quick start

```ts
import { createSpeechToText } from '@localspeech/speech-to-text';

const stt = createSpeechToText();          // nothing is downloaded yet

// Dictation (loads the model and opens the microphone on first use):
const dictation = stt.dictate({
  onPartial: (text) => preview.textContent = text,   // the phrase being spoken, updated live
  onFinal: (text) => output.value += ` ${text}`,     // each finished phrase
});
const text = await dictation.stop();       // finalizes what was being said

// A recording or file (any format the browser can decode):
const { text: transcript } = await stt.transcribe(file);
```

## Serving the runtime files (required)

ONNX Runtime's `.wasm`/`.mjs` files must be served from your own origin. The `localspeech-assets` command (installed
with the package) copies them to `public/localspeech/`, the default `runtimeUrl`:

```json
{ "scripts": { "predev": "localspeech-assets", "prebuild": "localspeech-assets" } }
```

Serve your pages cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp` or `credentialless`) so WASM inference can use several threads; without
it, transcription on WASM is too slow to keep up live. See the
[text-to-speech README](https://github.com/Alex-Cockrell/speech-model-demos/tree/main/packages/text-to-speech#serving-the-runtime-files-required) for a Next.js example and CSP notes.
The microphone needs a secure context (HTTPS or localhost).

## Configuration

| Option | Default | |
| --- | --- | --- |
| `backend` | `'auto'` | `'auto'` (WebGPU, falling back to WASM), `'webgpu'` or `'wasm'`. |
| `precision` | `'auto'` | Encoder: `int8` on WASM, `fp16` on WebGPU (`fp32` without `shader-f16`). |
| `segmentation` | 800 / 600 / 20000 | `{ partialIntervalMs, minSilenceMs, maxSegmentMs }`: live-text interval, pause that ends a segment, longest segment. |
| `modelBaseUrl` | `https://huggingface.co` | A mirror with the same layout, or a path on your site (see Self-hosting). |
| `runtimeUrl` | `/localspeech/onnxruntime-web-<version>/` | Where the runtime files are served. |
| `wasmThreads` | `0` | WASM threads; 0 = automatic (cores − 2). |

## API

```ts
const stt = createSpeechToText(config);

stt.getSnapshot();          // { status: 'idle' | 'loading' | 'ready' | 'error', progress, error, backend, precision }
stt.subscribe(listener);
await stt.load();
await stt.isCached();

const d = stt.dictate({ stream?, onPartial?, onFinal? });   // returns at once
d.getSnapshot();            // { status: 'loading' | 'starting' | 'listening' | 'stopping' | 'ended' | 'cancelled' | 'error', text, finalText, error }
d.subscribe(listener);
await d.stop();             // final text, after the phrase being spoken is finalized
d.cancel();                 // stop at once, discard the open phrase

await stt.transcribe(input);   // Blob | ArrayBuffer | AudioBuffer | { samples, sampleRate } → { text, durationSec, computeMs }

// Advanced: microphone and call audio at once, with per-segment events and word timings.
const session = await stt.startSession(
  { sources: [{ kind: 'mic' }, { kind: 'system', stream: await requestSystemAudio() }] },
  { onPartial, onFinal, onLevel, onStats },
);
await session.stop();
```

`requestSystemAudio()` must be called in a click: it opens the browser's screen picker (share a tab with audio, or
the screen with system audio); only the sound is kept. One dictation or session at a time.

## React

```tsx
import { SpeechToTextProvider, useDictation, useSpeechToTextDownload } from '@localspeech/speech-to-text/react';

<SpeechToTextProvider config={{}}>   {/* or stt={instance} */}
  <MicButton />
</SpeechToTextProvider>;

function MicButton() {
  const { start, stop, listening, text } = useDictation();
  return (
    <>
      <button onClick={() => (listening ? stop() : start())}>{listening ? 'Stop' : 'Dictate'}</button>
      <p>{text}</p>
    </>
  );
}
```

Also: `useSpeechToText()`, `useSpeechToTextState()`, `useSpeechToTextDownload()` (download button and progress) and
`useDictationState(dictation)`.

## assistant-ui

```ts
import { createDictationAdapter } from '@localspeech/speech-to-text/assistant-ui';

const stt = useSpeechToText();
const dictation = useMemo(() => createDictationAdapter(stt), [stt]);
const runtime = useChatRuntime({ adapters: { dictation } });   // ComposerPrimitive.Dictate now uses it
```

Live text is shown as the composer's preview; each finished phrase is appended to what the user typed. Checked
against `@assistant-ui/react` 0.15.

## Self-hosting the model (locked-down networks)

```sh
npx localspeech-models public/models --stt      # int8 + fp16 encoders by default (≈1.9 GB); --stt-precision int8 for WASM only
```

then `createSpeechToText({ modelBaseUrl: '/models' })`. Nothing is then fetched from huggingface.co.

## Browser support

Current Chrome and Edge (WebGPU, or WASM). Other browsers with WebAssembly SIMD should work on WASM; Safari and mobile
browsers are untested. Live transcription on WASM needs a reasonably fast CPU and cross-origin isolation; WebGPU keeps
up comfortably.

## Licenses

MIT. The model weights are downloaded at runtime and not included: Parakeet TDT 0.6B v3 is CC-BY-4.0 (by NVIDIA;
attribution required, which this notice provides); the ONNX export used is
[ysdede/parakeet-tdt-0.6b-v3-onnx](https://huggingface.co/ysdede/parakeet-tdt-0.6b-v3-onnx), run with
[parakeet.js](https://github.com/ysdede/parakeet.js) (MIT).

## Related projects

[parakeet.js](https://github.com/ysdede/parakeet.js) and [Keet](https://github.com/ysdede/keet) (the runner this builds
on, and a live transcription app), [FluidAudio Web](https://github.com/FluidInference/fluidaudio-web),
[LocalMode](https://github.com/LocalMode-AI/LocalMode), [MoonshineJS](https://www.npmjs.com/package/@moonshine-ai/moonshine-js) and
[whisper-web](https://github.com/xenova/whisper-web). Chrome also offers on-device Web Speech recognition in some
locales; this package works the same in every browser that runs it, with 25 languages and an assistant-ui adapter.

Part of [localspeech](https://github.com/Alex-Cockrell/speech-model-demos); see also
[`@localspeech/text-to-speech`](https://github.com/Alex-Cockrell/speech-model-demos/tree/main/packages/text-to-speech).

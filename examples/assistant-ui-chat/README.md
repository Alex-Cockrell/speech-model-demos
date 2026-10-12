# assistant-ui chat with local read-aloud and dictation

A minimal [assistant-ui](https://www.assistant-ui.com) chat that speaks with `@localspeech/text-to-speech` and listens with
`@localspeech/speech-to-text`, entirely in the browser. A fake model streams a canned markdown reply, so no API key is needed.

It shows:

- **Download in one component, use from another**: `VoicePanel` and `TranscriptionPanel` use
  `useTextToSpeechDownload()` / `useSpeechToTextDownload()`; the rest of the app shares the same providers.
- **assistant-ui's Read aloud button**: `createSpeechSynthesisAdapter(tts)` passed as `adapters.speech`.
- **assistant-ui's Dictate button**: `createDictationAdapter(stt)` passed as `adapters.dictation`; live text appears in
  the composer while you speak, and each finished phrase is kept.
- **Transcribing a file**: `stt.transcribe(file)` on any audio the browser can decode.
- **Reading replies aloud while they stream in**: `useReadAloudWhileStreaming()` (or `<ReadAloudWhileStreaming />`);
  the checkbox's click calls `tts.unlockAudio()`, because replies arrive without a user gesture.
- **Serving the runtime files**: `localspeech-assets` (the `predev`/`prebuild` scripts) copies ONNX Runtime's files to
  `public/localspeech/`, the packages' default `runtimeUrl`; `next.config.ts` sends the COOP/COEP headers that enable
  multithreaded WASM.

The packages are installed from `npm pack` tarballs, exactly as published, so this also tests the package build.

## Run

From the repository root:

```sh
npm install
npm run pack:packages          # builds the packages into .tarballs/
cd examples/assistant-ui-chat
npm install
npm run dev                    # http://localhost:3000
```

After changing a package, run `npm run pack:packages` again, then `npm install` here (delete `package-lock.json`
first if npm keeps the old tarball).

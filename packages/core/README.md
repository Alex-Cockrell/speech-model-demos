# @localspeech/core

Shared plumbing for [`@localspeech/text-to-speech`](https://github.com/Alex-Cockrell/speech-model-demos/tree/main/packages/text-to-speech)
and [`@localspeech/speech-to-text`](https://github.com/Alex-Cockrell/speech-model-demos/tree/main/packages/speech-to-text):
model download and caching (Cache API, pinned revisions, mirror rewriting), environment and WebGPU detection, and two
command-line tools. It is installed with those packages; you normally don't depend on it directly.

## Commands

### `localspeech-assets [dir]`

Copies ONNX Runtime Web's `ort-wasm-simd-threaded.jsep.{mjs,wasm}`, in the version the installed packages use, to
`<dir>/onnxruntime-web-<version>/` (default `public/localspeech/`, which is the packages' default `runtimeUrl`). Run it
before building:

```json
{ "scripts": { "predev": "localspeech-assets", "prebuild": "localspeech-assets" } }
```

### `localspeech-models [dir] [options]`

Downloads the model files the installed packages load, pinned to their exact revisions, into the layout they request
(`<dir>/<repo>/resolve/<revision>/<file>`, default `public/models/`). Serve that folder and pass its URL as
`modelBaseUrl` (e.g. `'/models'`): nothing is then fetched from huggingface.co.

```sh
npx localspeech-models public/models                         # both packages, the precisions 'auto' picks
npx localspeech-models public/models --tts --voices af_heart,am_michael
npx localspeech-models public/models --stt --stt-precision int8   # WASM only (≈670 MB)
npx localspeech-models --dry-run                             # list the files
```

## Utilities

`clearModelCaches()` (delete every stored model file), `getStorageInfo()` / `requestPersistentStorage()`,
`detectEnvironment()` / `detectWebGpuSupport()`, and `createPageNetworkMonitor()` (counts the page's own network
requests, e.g. to show that nothing is uploaded).

MIT. Part of [localspeech](https://github.com/Alex-Cockrell/speech-model-demos).

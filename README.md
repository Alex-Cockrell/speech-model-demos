# Local Speech

A prototype of browser-local speech features for the product (spec and decisions: [idea.md](idea.md)). Everything runs in the browser; no inference runs on a server, and audio never leaves the machine.

- **Meeting transcription:** microphone and/or call audio, speech segmented at pauses with live text, speakers labelled Speaker 1, 2, … (renamable), transcripts autosaved in the browser and exported as Markdown, text, JSON, WebVTT or SRT.
- **Read aloud:** paste a document or response and hear it with streaming playback, sentence highlighting, pause and seek.
- **Benchmark:** the original proof of concept. Speak, see the transcript, hear it read back, with every stage timed (model download and initialization, streaming cadence, time to first audio, playback continuity, end-to-end latency) and exportable as JSON.

The UI deliberately shows no model, library or host names. They are documented here and recorded in the benchmark JSON.

**Test deployment:** https://speechmodeldemos.projects.alex.cockrell.ai (Cloudflare, deployed automatically from `main`).

```text
Microphone / shared call audio → AudioWorklet (16 kHz PCM) → ASR worker: NVIDIA Parakeet TDT 0.6B v3 (parakeet.js)
  → segments → speaker worker: 3D-Speaker CAM++ embeddings + clustering → transcript
Text → TTS worker: Kokoro 82M (kokoro-js / transformers.js) → Web Audio playback
All models run on ONNX Runtime Web (WebGPU or multithreaded WASM).
```

## Quick start

Needs Node.js 20.9+ (Cloudflare builds use 22, pinned in `.node-version`) and a current Chrome or Edge for WebGPU.

```sh
npm install
npm run dev        # http://localhost:3000
```

- `predev` copies ONNX Runtime's `.wasm`/`.mjs` files into `public/ort/` (`scripts/copy-ort-assets.mjs`; generated and gitignored).
- The dev server sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (`next.config.ts`), so the page is cross-origin isolated and ONNX Runtime can run multithreaded WASM. Open `http://localhost`, not a LAN IP: isolation and the microphone both need a secure context.
- **Load models** downloads the weights from Hugging Face the first time (about 800 MiB for WASM, 1.5 GiB for WebGPU, plus 30 MB for the meeting speaker model; see [Model sizes](#model-sizes)) and keeps them in browser storage.

## Using the app

### Meeting transcription

1. **Load models** (speech recognition + speaker model). If the benchmark already loaded speech recognition, only the speaker model loads.
2. Choose the sources: **Microphone** for the room or your own voice, **Call audio** for the people on a call. Both can run at once.
3. **Start meeting**. For call audio, Edge asks what to share:
   - Teams, Meet or Zoom **in Edge**: pick the call's tab and keep "Also share tab audio" on.
   - Teams or Zoom **desktop app**: pick *Entire screen* and turn on "Also share system audio".
   - Only the sound is used; the picture is discarded right away. Edge shows its sharing bar until the meeting stops.
4. Lines appear when a speaker pauses (about 0.8 s after they stop on a fast laptop), with live text while they talk. Speakers are numbered in order of appearance; click a name to rename it everywhere, merge two speakers, move a single line, or **Re-identify speakers** (optionally with the number of people) once more audio is in. Lines with under a second of speech stay unlabelled until re-identified.
5. On laptop speakers the microphone also hears the call. Those duplicate lines are detected and hidden (toggle to show them); headphones avoid it altogether.
6. Transcripts autosave every 10 s and on Stop to IndexedDB (`speech-poc-transcripts`). **Clear model caches** never deletes them. After a crash or reload, an unfinished meeting shows up as *Interrupted*. Export from the meeting or the saved list.

7. **Refine with Teams transcript** (optional, after the meeting): our words are usually more accurate than Teams', but Teams knows who spoke because it hears each participant separately. Open the meeting (or a saved one), click **Refine with Teams transcript…**, and paste the transcript from Teams (meeting chat → Recap → Transcript, select all and copy) or open/drop its `.docx`, `.vtt` or `.txt` download. The app lines the two up locally (clock offset found automatically), keeps our words and timings, takes Teams' speaker names and turns, splits lines where the speaker changed, and adds lines only Teams heard (marked "from Teams"). The result is saved as a new "(refined)" transcript; the original is kept. Transcription must have been on in Teams; for long meetings prefer the download, since the transcript pane may only copy what it has loaded.

The live bar shows the real-time factor and a backlog of speech waiting to be transcribed; a warning appears if the laptop cannot keep up (WebGPU, or a single source, helps).

### Read aloud

Paste text or open a `.txt`/`.md` file, then **Play**. Markdown is cleaned up for listening: links are read as their text, list items and table rows become sentences, and code blocks are announced instead of read. Generation stays at most about 30 s ahead of playback; stalls (generation slower than playback) are counted and explained. **Download audio (WAV)** saves what has been generated. **Copy diagnostics JSON** records every piece's exact text, voice, speed and precision, and whether its audio came back unusable; send it if speech ever goes missing. Voices: Heart (default) and Michael.

### Benchmark

The original spec (sections 1–20 of idea.md): Load models, Record, Stop, and the transcript is read back with every stage timed. See [Test matrix](#test-matrix-spec-17).

## Network lock

Production builds add a Content-Security-Policy (`scripts/network-lock.mjs`, run as `postbuild`, written into `out/_headers`). The browser then refuses every connection except to the app itself and the build's model host (the public model host, or `NEXT_PUBLIC_MODEL_BASE_URL` when set), so audio and text cannot leave the device even through a bug. The in-app model-source setting is hidden in locked builds.

- On by default for `npm run build` (and therefore on Cloudflare). `npm run dev` is never locked.
- To build without it, e.g. to try models from another URL: set `NETWORK_LOCK=off` for the build (PowerShell: `$env:NETWORK_LOCK='off'; npm run build`; Cloudflare: a build environment variable).
- To check it on a deployment: DevTools → Network → the document → Response headers shows `Content-Security-Policy`; in the console, `fetch('https://example.com')` fails with a Content-Security-Policy error.
- It covers fetch/XHR/WebSocket/beacons, scripts, images, media and frames. Like any page policy it cannot stop a user from clicking a link away.

## Production preview

```sh
npm run build      # static export to out/ (prebuild copies the ONNX Runtime files again)
npm run preview    # serves out/ at http://localhost:3000 the way Cloudflare does
```

`scripts/serve-out.mjs` applies `out/_headers` with Cloudflare's matching rules, Cloudflare's default `Cache-Control`, and correct MIME types (`.wasm` as `application/wasm`). Options: `npm run preview -- --port 8080 --host 0.0.0.0 --dir out --quiet`.

## Deploying to Cloudflare

The site is static files only: no SSR, API routes, Pages Functions or Worker code. Both deployment paths below read `out/_headers` (copied from `public/_headers`): COOP/COEP/CORP on every path, and `Cache-Control: public, max-age=31536000, immutable` for `/_next/static/*` (content-hashed) and `/ort/*` (versioned directories). Cloudflare rejects static files over 25 MiB; the largest file is ONNX Runtime's 23.8 MiB `.wasm`, and `copy-ort-assets` fails the build if a file ever exceeds the limit. Model weights are never part of the site.

### Option 1: Cloudflare Pages

Workers & Pages → Create → Pages → connect the Git repository:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Build command | `npm run build` |
| Build output directory | `out` |
| Environment variable (optional) | `NEXT_PUBLIC_MODEL_BASE_URL`, see [R2 mirror](#cloudflare-r2-mirror) |

- Use `npm run build`, not the "Next.js (Static HTML Export)" preset's `npx next build`: the npm `prebuild` hook is what copies the ONNX Runtime files.
- `.node-version` selects Node 22 (Pages build image v3 reads it).
- Pages skips `wrangler.jsonc` because it has no `pages_build_output_dir`; the build log says "A wrangler.toml file was found but it does not appear to be valid … Skipping file and continuing." That is expected. Do not add `pages_build_output_dir`: it would turn the file into the Pages project configuration.
- Without Git: `npm run build && npx wrangler pages deploy out --project-name <project>`.

### Option 2: Workers with static assets

`wrangler.jsonc` describes an assets-only Worker named `speech-model-demos` that serves `./out` (unknown paths get `out/404.html` with status 404).

- From a machine: `npm run build && npx wrangler deploy`.
- Workers Builds (Git): Workers & Pages → Create → Import a repository. Build command `npm run build`; deploy command `npx wrangler deploy` (the default). The Worker name must equal `name` in `wrangler.jsonc`, otherwise the build fails. Workers Builds defaults to Node 24; `.node-version` selects 22. Set `NEXT_PUBLIC_MODEL_BASE_URL` under Settings → Build → Build variables and secrets (it is read at build time).
- Keep `wrangler.jsonc` in the repository. Without a Wrangler config, `wrangler deploy` (4.68+) and Workers Builds run automatic framework configuration, which turns a Next.js app into a server-rendered Worker (Workers Builds opens a pull request for it). With the file present they upload `out/` as plain static assets.

### After deploying

```sh
curl -sI https://<app>/ | grep -i cross-origin
curl -sI https://<app>/ort/onnxruntime-web-1.24.1/ort-wasm-simd-threaded.jsep.wasm | grep -i -E 'content-type|cache-control'
```

Expect `same-origin` and `require-corp`, then `application/wasm` and the immutable `Cache-Control`. In the app, the Environment panel should show the page as cross-origin isolated with WASM threads available.

## Model hosting

Model files are pinned to commit SHAs in `src/lib/config.ts`. The inference workers rewrite every `https://huggingface.co/{repo}/resolve/{any revision}/{file}` request for those repos to the pinned revision on the selected source (`src/lib/net/instrument.ts`), so Hugging Face and the mirror serve byte-identical files and share browser cache entries.

### Hugging Face (default)

No setup. Files come from `huggingface.co`, which redirects downloads to CDN hosts under `hf.co`; both must be reachable.

### Cloudflare R2 mirror

The mirror uses Hugging Face's key layout, `{repo}/resolve/{revision}/{file}`, so switching sources only changes the base URL.

1. **Bucket**: `npx wrangler r2 bucket create speech-models` (or use the dashboard).
2. **Custom domain**: R2 → bucket → Settings → Custom Domains → Connect, e.g. `models.example.com`. The domain must be a zone in the same Cloudflare account. CLI: `npx wrangler r2 bucket domain add speech-models --domain models.example.com --zone-id <zone id>`. The bucket's `r2.dev` URL is rate-limited and not cached; use it for testing only.
3. **CORS**: replace `https://speech-test.example.com` in `r2/cors.json` with the app origin(s) (it also allows `http://localhost:3000`; methods `GET` and `HEAD`; exposes `Content-Length`, `Content-Type` and `ETag`), then run `npx wrangler r2 bucket cors set speech-models --file r2/cors.json`.
4. **Upload**: create an R2 API token with Object Read & Write on the bucket, then:
   ```sh
   export R2_ACCOUNT_ID=<account id> R2_ACCESS_KEY_ID=<key id> R2_SECRET_ACCESS_KEY=<secret> R2_BUCKET=speech-models
   npm run mirror-models -- --dry-run     # files, sizes and object keys; needs no credentials
   npm run mirror-models                  # about 2.5 GB; --include-fp32 adds the 2.5 GB fp32 encoder
   ```
   Each file streams from its pinned Hugging Face URL into a multipart upload with `Cache-Control: public, max-age=31536000, immutable`. Objects that already exist with the right size are skipped, so an interrupted run can simply be restarted.
5. **Verify** what browsers will see (status, size, `Access-Control-Allow-Origin`), once per app origin:
   ```sh
   npm run mirror-models -- --verify https://models.example.com --origin https://speech-test.example.com
   ```
6. **Use it**: build with `NEXT_PUBLIC_MODEL_BASE_URL=https://models.example.com` (Pages environment variable, Workers Builds build variable, or `.env.local`), or pick Model source → Mirror in the app and enter the base URL (saved per browser).

Edge caching:

- Cloudflare's cache only stores some file extensions by default (`.bin` yes; `.onnx`, `.json`, `.txt` no). Add a Cache Rule for the models hostname with "Eligible for cache" so the weights are cached at the edge; the objects already carry the immutable `Cache-Control`.
- Files larger than the plan's maximum cacheable size (512 MB on Free, Pro and Business; 5 GB on Enterprise) are never edge-cached. The Parakeet encoders (int8 652 MB, fp16 1.24 GB, fp32 weights 2.44 GB) are therefore always served from R2 itself; every other file fits. R2 has no egress fees.
- Cloudflare's cache ignores `Vary: Origin` by default and keeps the CORS headers of the request that filled it (per the R2 docs, cached objects do not pick up CORS changes until refreshed). If more than one origin uses the mirror (for example production and `localhost:3000`), or a file was first fetched without an `Origin` header (curl, a browser address bar), cached copies can carry another origin's `Access-Control-Allow-Origin` or none. The weights are public, so the robust fix is a response header Transform Rule on the models hostname that sets `Access-Control-Allow-Origin: *`. Purge the cache after any CORS change; `--verify` prints `cf-cache-status` for each file.

## Model sizes

Download per backend with the default ("auto") quantizations, one voice included. MiB/GiB here are binary; the app reports MB = 10^6 bytes.

| Backend | Parakeet | Kokoro | Total |
| --- | --- | --- | --- |
| WASM | int8 encoder + int8 decoder: 639 MiB | fp16: 156 MiB | ≈ 795 MiB |
| WebGPU with `shader-f16` | fp16 encoder + int8 decoder: 1.17 GiB | fp32: 311 MiB | ≈ 1.5 GiB |
| WebGPU without `shader-f16` | fp32 encoder (`.onnx` + `.onnx.data`) + int8 decoder: 2.32 GiB | fp32: 311 MiB | ≈ 2.6 GiB |

Meeting transcription adds the speaker model: 3D-Speaker CAM++ (VoxCeleb, `csukuangfj/speaker-embedding-models`), 29.6 MB, always on WASM with 1 thread (ONNX Runtime Web's WebGPU backend can't run its pooling; the app also patches an AveragePool padding bug of ORT ≤ 1.24 in memory). Its upstream weights are Apache-2.0, but the re-export repository carries no license tag; confirm before production use.

Add the ONNX Runtime files served by the app (23.8 MiB for Parakeet, 20.6 MiB for Kokoro). The Parakeet decoder always runs on WASM, so it stays int8. The mirror only has the fp32 encoder if it was uploaded with `--include-fp32`.

## Test matrix (spec §17)

Tag each run with **Test case (spec §17)** so the exported JSON records the row. Reload the page before each row: loading again in the same page with the same settings is reported as a session load.

| # | Cache | Backend | Network | How |
| --- | --- | --- | --- | --- |
| 1 | Cold | Auto | Online | Clear model caches, reload, Load models, record. |
| 2 | Warm | Auto | Online | After row 1: reload, Load models (load kind must read Warm), record. |
| 3 | Warm | WebGPU | Online | Backend Force WebGPU. If these files were never loaded, load once first; then reload, Load models, record. |
| 4 | Warm | WASM | Online | As row 3 with Force WASM. |
| 5 | Warm | Auto | Offline after load | Load models online, go offline (DevTools → Network → Offline, or disconnect the network), record. `privacy.networkRequestsDuringRun` must be 0. |
| 6 | Cold | WASM | Online | Force WASM, Clear model caches, reload, Load models, record. |

- **Clear model caches** deletes the Cache Storage and IndexedDB data the model loaders use. Model files are always fetched with `cache: 'no-store'` (they persist in Cache Storage instead), so after clearing, a cold load really downloads them. The ONNX Runtime `.wasm`/`.mjs` files still use the normal HTTP cache, so a "cold" row may read them from disk; that only affects `runtimeBytes` timing, not the model download numbers.
- On managed machines, request persistent storage in the app before the warm rows (see Troubleshooting).
- Managed laptop: also run row 2 after closing every browser window and reopening the browser. A Cold result means model storage does not survive a browser restart there.

## Troubleshooting

**`crossOriginIsolated` is false.** The HTML response lacks COOP `same-origin` and COEP `require-corp`; check DevTools → Network → the document → Headers. Usual causes: the app is served by something other than `npm run dev`, `npm run preview` or Cloudflare with `out/_headers`; it was opened via a LAN IP over plain HTTP; a proxy or extension strips headers. ONNX Runtime then runs single-threaded and the app reports multithreaded WASM as unavailable.

**WebGPU unavailable.** Check chrome://gpu or edge://gpu (the WebGPU row). `navigator.gpu` is missing on browsers without WebGPU and on insecure origins; `requestAdapter()` returns null when the GPU or driver is blocklisted or hardware acceleration is off (enterprise policy `HardwareAccelerationModeEnabled`). Auto then falls back to WASM and records the reason; Force WebGPU fails. Without `shader-f16`, Parakeet needs the fp32 encoder (2.3 GiB).

**WASM very slow or failing on managed Chrome/Edge.** Policies that block the JavaScript JIT (`DefaultJavaScriptJitSetting`, `JavaScriptJitBlockedForSites`, Edge enhanced security mode set to strict) slow JavaScript down and can disable WebAssembly. Ask IT to exempt the app's site (`JavaScriptJitAllowedForSites`).

**Models download again after a restart, or downloads fail for lack of space.** The Environment panel shows storage usage, quota and whether storage is persistent. Expect 0.7 to 2.6 GiB per backend configuration, more when several are cached. Persistent storage (`navigator.storage.persist()`) only protects against eviction under storage pressure. It does not survive policies that clear site data on exit, such as cookies kept for the session only (`DefaultCookiesSetting` = 4), Chrome's `ClearBrowsingDataOnExitList` or Edge's `ClearBrowsingDataOnExit`; check chrome://policy or edge://policy. Incognito and guest profiles have small quotas and are wiped on close.

**Call audio isn't transcribed.** The share was made without audio: share again and keep "Also share tab audio" (tab) or "Also share system audio" (entire screen) switched on. Window sharing only carries audio in recent Edge versions. Stopping the share from Edge's bar ends the call source; the microphone keeps going.

**Everything said on the call appears twice, or speakers multiply.** The microphone hears the call through the laptop speakers. Duplicate lines are hidden automatically; headphones avoid them. If one person still shows up as two speakers, merge them or use Re-identify speakers with the number of people.

**huggingface.co is blocked.** Model downloads fail with network or CORS errors. Use the R2 mirror on a hostname IT can allow-list (when using Hugging Face, its CDN hosts under `hf.co` must be reachable too).

**Mirror CORS errors.** Run `--verify` with the exact app origin and read the edge caching notes above. Every voice in the app's voice picker is mirrored; if the picker gains a voice, add it to `VOICES` in `scripts/mirror-models-to-r2.mjs` and re-run the upload.

## Testing without a microphone

Edge and Chrome can play a WAV file as the microphone and as shared screen audio (headless works, nothing is audible):

```sh
msedge --use-fake-ui-for-media-stream --use-fake-device-for-media-stream   --use-file-for-fake-audio-capture="C:/path/meeting.wav%noloop"   --auto-select-desktop-capture-source="Entire screen" http://localhost:3000
```

Use 16-bit PCM WAV files. Sharing a real tab that plays audio doesn't work for automated tests in headless mode: headless browsers render audio to a null sink, so the captured tab audio is silent.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Copy the ONNX Runtime files, start the cross-origin isolated dev server on :3000 |
| `npm run build` | Copy the ONNX Runtime files, static export to `out/` |
| `npm run preview` | Serve `out/` with Cloudflare's headers and MIME types |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run copy-ort-assets` | Copy the ONNX Runtime files into `public/ort/`, checking versions against `ORT_ASSETS` in `src/lib/config.ts` |
| `npm run mirror-models -- [options]` | Mirror the pinned model files to R2, or `--verify` a mirror (see `--help`) |

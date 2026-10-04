# Local Speech Test

A proof of concept that answers one question (spec: [idea.md](idea.md)): can the laptops our users actually have run speech recognition and speech synthesis entirely in the browser, fast enough to be useful? The app transcribes the microphone with NVIDIA Parakeet TDT 0.6B v3, reads the exact transcript back with Kokoro 82M, and times every stage: model download and initialization, streaming ASR cadence, time to first TTS audio, playback continuity and end-to-end latency. No inference runs on a server. Network traffic is limited to the app itself, the ONNX Runtime files and the model weights; audio and metrics never leave the machine unless you use **Copy benchmark JSON**.

```text
Microphone → AudioWorklet (16 kHz PCM) → ASR worker: Parakeet (parakeet.js, ONNX Runtime Web, WebGPU or WASM)
           → transcript → TTS worker: Kokoro (kokoro-js, transformers.js, ONNX Runtime Web) → Web Audio playback
```

## Quick start

Needs Node.js 20.9+ (Cloudflare builds use 22, pinned in `.node-version`) and a current Chrome or Edge for WebGPU.

```sh
npm install
npm run dev        # http://localhost:3000
```

- `predev` copies ONNX Runtime's `.wasm`/`.mjs` files into `public/ort/` (`scripts/copy-ort-assets.mjs`; generated and gitignored).
- The dev server sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (`next.config.ts`), so the page is cross-origin isolated and ONNX Runtime can run multithreaded WASM. Open `http://localhost`, not a LAN IP: isolation and the microphone both need a secure context.
- **Load models** downloads the weights from Hugging Face the first time (about 730 MiB for WASM, 1.5 GiB for WebGPU, see [Model sizes](#model-sizes)) and keeps them in browser storage.

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

**huggingface.co is blocked.** Model downloads fail with network or CORS errors. Use the R2 mirror on a hostname IT can allow-list (when using Hugging Face, its CDN hosts under `hf.co` must be reachable too).

**Mirror CORS errors.** Run `--verify` with the exact app origin and read the edge caching notes above. Every voice in the app's voice picker is mirrored; if the picker gains a voice, add it to `VOICES` in `scripts/mirror-models-to-r2.mjs` and re-run the upload.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Copy the ONNX Runtime files, start the cross-origin isolated dev server on :3000 |
| `npm run build` | Copy the ONNX Runtime files, static export to `out/` |
| `npm run preview` | Serve `out/` with Cloudflare's headers and MIME types |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run copy-ort-assets` | Copy the ONNX Runtime files into `public/ort/`, checking versions against `ORT_ASSETS` in `src/lib/config.ts` |
| `npm run mirror-models -- [options]` | Mirror the pinned model files to R2, or `--verify` a mirror (see `--help`) |

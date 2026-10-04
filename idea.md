# Browser-Local Speech Pipeline Proof of Concept

## 1. Purpose

Build a minimal Next.js application that proves automatic speech recognition and text-to-speech can run entirely inside a user's browser.

The application contains no LLM, agent, server-side inference, or semantic transformation.

The complete pipeline is:

**Microphone → Parakeet ASR → Transcript → Kokoro TTS → Speaker**

If the user says:

> "The quick brown fox jumps over the lazy dog."

the application should transcribe the utterance, display the transcript, and read the resulting transcript back to the user.

All inference must happen locally on the user's machine.

---

# 2. Primary Goal

Answer one question:

> **Are browser-local ASR and TTS practical on the machines our users actually have?**

The prototype should measure both functionality and performance.

It should determine:

- whether Parakeet runs successfully in-browser;
- whether Kokoro runs successfully in-browser;
- whether both work without a discrete GPU;
- whether WebGPU meaningfully improves performance when available;
- how long each model takes to download;
- how long each model takes to initialize;
- how quickly transcription starts appearing;
- how frequently transcription updates while the user is speaking;
- how quickly synthesized speech begins;
- whether synthesized speech can continue without pauses or buffer underruns;
- how much time the full speech → text → speech loop requires;
- whether all inference continues working after network connectivity is removed.

---

# 3. Models

## ASR

**NVIDIA Parakeet TDT 0.6B v3**

Runtime:

- parakeet.js
- ONNX Runtime Web
- WebGPU when available
- WASM fallback

Parakeet.js supports browser-local inference, WebGPU/WASM execution, IndexedDB caching and stateful streaming transcription.

## TTS

**ONNX Community Kokoro-82M-v1.0-ONNX**

Runtime:

- kokoro-js / Transformers.js
- ONNX Runtime Web
- WebGPU when appropriate
- WASM fallback

Kokoro.js supports completely local browser execution and exposes a streaming interface that returns generated audio chunks as text is processed.

Use a quantized Kokoro model for the initial test.

---

# 4. Technology Stack

**Framework:** Next.js  
**Language:** TypeScript  
**Frontend:** React  
**Inference:** Client-side only  
**ASR:** parakeet.js  
**TTS:** kokoro-js / Transformers.js  
**Runtime:** ONNX Runtime Web  
**Audio:** Web Audio API  
**Acceleration:** WebGPU when available  
**Fallback:** WASM / CPU  
**Hosting:** Cloudflare  
**Model hosting:** Hugging Face initially or Cloudflare R2

There should be no application backend required for inference.

---

# 5. Privacy Boundary

The prototype must demonstrate the following property:

> **Raw voice data never leaves the user's machine.**

The following remain entirely client-side:

- microphone audio;
- recorded PCM;
- ASR inference;
- partial transcripts;
- final transcript;
- TTS inference;
- generated audio.

Network traffic is allowed only for:

- loading the application;
- loading runtime JavaScript/WASM assets;
- downloading model files.

After the required model/runtime assets have loaded, the speech pipeline must be capable of operating with network connectivity disabled.

---

# 6. Backend Selection

The application should expose three modes.

### Auto

Attempt WebGPU first.

If unavailable or initialization fails, fall back to WASM.

### Force WebGPU

Useful for determining best-case performance.

### Force CPU / WASM

Useful for approximating machines without usable WebGPU.

A discrete GPU must not be required.

Integrated GPUs may expose WebGPU as well.

CPU/WASM should be treated as the compatibility baseline.

---

# 7. Benchmark Instrumentation

Performance measurement is a primary feature of the prototype.

All benchmark timestamps should be generated locally using a monotonic high-resolution timer such as:

`performance.now()`

Do not send benchmark results to a server automatically.

Metrics should remain client-side unless the user explicitly copies or exports them.

Every test run should generate a structured benchmark record.

---

# 8. Model Download Metrics

Track Parakeet and Kokoro independently.

For each model capture:

### Download Start

Timestamp immediately before model retrieval begins.

### Time to First Byte

Time between starting the model request and receiving the first model data.

### Download Complete

Timestamp when all required model files have been retrieved.

### Total Download Time

`downloadComplete - downloadStart`

### Downloaded Bytes

Total number of network bytes required for the model.

### Effective Download Rate

`downloadedBytes / downloadDuration`

Display as MB/s.

### Initialization Start

When model loading/compilation begins after the required data is available.

### Model Ready

When the model can perform its first inference.

### Initialization Time

`modelReady - initializationStart`

### Total Cold Start

`modelReady - downloadStart`

This is one of the most important metrics for the managed-browser environment.

The UI should clearly identify:

**Cold Load**

Model data was retrieved over the network.

**Warm Load**

Model data was recovered from persistent browser storage/cache.

**Session Load**

Model was already initialized in the current page session.

---

# 9. ASR Streaming Metrics

Parakeet should be tested using its streaming transcription support rather than measuring only a completed recording. Parakeet.js exposes a streaming transcriber that accepts successive audio chunks.

Track:

### Microphone Start

User presses Record.

### Speech Start

When speech activity is first detected.

This can initially be approximate.

### First Audio Submitted

The first microphone audio chunk passed to Parakeet.

### Time to First Transcript

The most important ASR responsiveness metric.

Measure:

`speechStart → first non-empty partial transcript`

Also record:

`firstAudioSubmitted → first non-empty partial transcript`

### Partial Transcript Updates

Record a timestamp every time the visible partial transcript changes.

Example:

```text
0 ms      speech begins
412 ms    "The"
681 ms    "The quick"
924 ms    "The quick brown"
1198 ms   "The quick brown fox"
```

Calculate:

- first transcript latency;
- average interval between transcript updates;
- median interval between transcript updates;
- maximum interval between updates;
- total number of partial updates.

This measures whether transcription feels continuously responsive rather than merely measuring final throughput.

### Final Transcript Latency

When the user stops recording:

`recordingStop → finalTranscript`

This represents how long the user would wait in a future chat interface before their message could be submitted.

### ASR Real-Time Factor

`ASR compute time / audio duration`

RTF below `1.0` means inference is faster than real time.

---

# 10. TTS Streaming Metrics

The exact final Parakeet transcript becomes the Kokoro input.

No LLM or transformation exists between them.

Kokoro's streaming interface should be used so the prototype can measure responsiveness rather than waiting for the entire utterance to be synthesized first.

Track:

### TTS Start

Timestamp immediately before transcript text is submitted to Kokoro.

### First Audio Generated

Timestamp when Kokoro produces the first playable audio chunk.

Calculate:

**Time to First Audio Generation**

`firstAudioChunkGenerated - ttsStart`

### First Audible Output

Timestamp when playback of the first generated chunk actually begins through the Web Audio API.

Calculate:

**Time to First Speech**

`firstPlaybackStart - ttsStart`

This is more meaningful to the user than generation time alone.

### Subsequent Audio Chunks

Record the generation time for every subsequent audio chunk.

Example:

```text
0 ms       TTS requested
318 ms     first audio generated
346 ms     playback begins
721 ms     chunk 2 generated
1084 ms    chunk 3 generated
1432 ms    chunk 4 generated
```

Measure:

- first-chunk latency;
- average chunk-generation interval;
- median chunk-generation interval;
- maximum chunk-generation interval.

### Playback Continuity

Track whether generated audio arrives quickly enough to maintain uninterrupted playback.

Record:

- buffer underruns;
- audible pauses caused by generation;
- minimum buffered audio duration;
- maximum buffered audio duration.

A future voice agent needs not only fast generation but **continuous generation faster than audio consumption**.

### TTS Generation Complete

When Kokoro has generated the entire utterance.

### Playback Complete

When the final generated audio has finished playing.

---

# 11. End-to-End Metrics

The application should calculate several aggregate metrics.

### Voice-to-First-Text

`speechStart → firstPartialTranscript`

### Stop-to-Final-Text

`recordingStop → finalTranscript`

This approximates how quickly a future chat application could receive the completed user message.

### Text-to-First-Speech

`finalTranscript → firstPlaybackStart`

### Stop-to-First-Speech

`recordingStop → firstPlaybackStart`

This is the most useful metric for the current demonstration.

It answers:

> After I finish speaking, how long until the computer starts saying my words back?

### Full Round Trip

`speechStart → playbackComplete`

---

# 12. Accuracy Testing

Provide two modes.

## Free Speech

User speaks anything.

The application:

1. transcribes it;
2. displays it;
3. reads it back.

## Benchmark Phrase

Display a known phrase for the user to read.

Example:

> The quick brown fox jumps over the lazy dog.

Compare expected text against the ASR result.

Calculate:

- normalized exact match;
- Word Error Rate;
- substitutions;
- insertions;
- deletions.

Ignore capitalization and punctuation for the normalized comparison.

Display the untouched raw transcript separately.

---

# 13. Diagnostics UI

The prototype should function partly as a benchmark dashboard.

Example:

```text
Local Speech Test
────────────────────────────────────

Environment

Browser       Chrome 1xx
WebGPU        Available
Backend       WebGPU
CPU Threads   12

Models

Parakeet
Download      8.42 sec
Size          684 MB
Initialization 2.13 sec
Status        READY

Kokoro
Download      1.31 sec
Size          92 MB
Initialization 0.44 sec
Status        READY

────────────────────────────────────

[ Start Recording ]

Partial transcript:
"This is a test of browser local speech..."

Final transcript:
"This is a test of browser local speech processing."

────────────────────────────────────

ASR

First Text             438 ms
Avg Update Interval    281 ms
Finalization           294 ms
Audio Duration         8.2 sec
RTF                    0.31

TTS

First Audio Generated  221 ms
First Audible Speech   258 ms
Avg Chunk Interval     402 ms
Buffer Underruns       0
Generation RTF         0.18

End-to-End

Stop → Final Text      294 ms
Text → Speech          258 ms
Stop → Speech          552 ms

[ Copy Benchmark JSON ]
```

---

# 14. Benchmark Export

Provide:

**Copy Benchmark JSON**

The JSON should include:

```json
{
  "environment": {},
  "models": {},
  "downloads": {},
  "asr": {},
  "tts": {},
  "endToEnd": {}
}
```

Include:

- browser;
- OS information exposed by the browser;
- WebGPU availability;
- selected backend;
- quantization;
- model versions;
- model download sizes;
- cold/warm load;
- download timings;
- initialization timings;
- ASR timings;
- TTS timings;
- accuracy results;
- audio duration;
- buffer underruns.

This makes comparisons across laptops easy without introducing a telemetry backend.

---

# 15. Cloudflare Deployment

The application itself should be capable of being deployed as a static Next.js application.

No SSR is required.

No API routes are required.

No Cloudflare Worker should perform model inference.

The browser remains the inference environment.

Because Cloudflare Pages limits individual static assets to 25 MiB, the model weights should not be bundled directly into the site's Pages assets.

Two model delivery options are acceptable.

## Option A — Hugging Face

Fastest prototype setup.

The browser downloads the model directly from the model repository.

## Option B — Cloudflare R2

Preferred for controlled deployment testing.

Example:

```text
speech-test.example.com
        │
        └── Cloudflare Pages
                │
                │ browser
                ▼
models.example.com
        │
        └── Cloudflare R2
              ├── parakeet/
              └── kokoro/
```

Advantages:

- control model URLs;
- control CORS;
- control caching;
- avoid dependencies on Hugging Face availability from managed environments;
- easier model version pinning;
- easier download instrumentation;
- Cloudflare edge caching.

Cloudflare supports serving public R2 objects through a custom domain and its CDN cache.

---

# 16. WASM Deployment Requirement

Parakeet.js notes that multithreaded WASM requires cross-origin isolation using COOP/COEP headers.

The Cloudflare deployment should therefore be configured to return appropriate headers for the application.

The prototype should report whether the browser is actually cross-origin isolated:

```text
crossOriginIsolated === true
```

Display this in the diagnostics panel.

If multithreaded WASM cannot initialize, report that clearly rather than silently changing behavior.

---

# 17. Required Test Matrix

The prototype should eventually be run under at least these configurations.

| Test | Cache | Backend | Network            |
| ---- | ----- | ------- | ------------------ |
| 1    | Cold  | Auto    | Online             |
| 2    | Warm  | Auto    | Online             |
| 3    | Warm  | WebGPU  | Online             |
| 4    | Warm  | WASM    | Online             |
| 5    | Warm  | Auto    | Offline after load |
| 6    | Cold  | WASM    | Online             |

The managed target laptop should additionally be tested after completely closing and reopening its locked-down browser.

This determines whether model storage survives browser restart.

---

# 18. Acceptance Criteria

The prototype succeeds if:

- microphone audio is processed locally;
- Parakeet successfully produces text;
- partial transcription can be observed while speaking;
- Kokoro successfully produces speech;
- generated audio can begin before the complete TTS job finishes;
- neither inference operation requires a server;
- the application works through WASM without requiring a discrete GPU;
- WebGPU can optionally accelerate inference;
- every major model loading and inference stage is timed;
- model download time can be distinguished from initialization time;
- first-output latency can be measured for both ASR and TTS;
- streaming cadence can be measured for both ASR and TTS;
- benchmark results can be copied as JSON;
- the pipeline continues working after the network is disabled once assets are loaded.

---

# 19. Out of Scope

Do not implement today:

- LLM inference;
- chat history;
- conversation management;
- wake words;
- interruption handling;
- full duplex conversation;
- server-side inference;
- authentication;
- accounts;
- telemetry backend;
- production UI;
- production persistence strategy.

Those become relevant only after browser-local speech inference has been proven viable.

---

# 20. Prototype Decision

The initial experiment should answer:

> **Can a user's browser independently download, initialize and continuously operate our speech models quickly enough to provide a useful voice experience without sending raw audio off-device?**

If yes, the next project can determine how the same browser-local speech layer should plug into a chat interface.

---

# 21. Phase 2 Scope

Added after the first build. The prototype now also covers the two features intended for the product. The benchmark (sections 1–20) stays as the measurement tool.

## Meeting Transcription

- Sources: microphone, call audio (a tab, window or the whole screen shared with audio), or both.
- Speech is cut into segments at pauses. Each segment shows live text while it is spoken and gets its final text when it ends.
- A local speaker-embedding model labels speakers Speaker 1, 2, … per source. Labels can be renamed, merged and re-identified.
- When the microphone also hears the call through speakers, duplicate "echo" lines are detected and hidden.
- Transcripts are autosaved in the browser during the meeting and export as Markdown, text, JSON, WebVTT or SRT.
- Live indicators show whether the machine keeps up: real-time factor and untranscribed backlog.

## Read Aloud

- Paste a document or response, or open a .txt/.md file. Kokoro reads it with streaming playback, sentence highlighting, pause/resume and seeking.
- Generation read-ahead is bounded. Stalls are measured and shown.

---

# 22. Implementation Decisions

| Decision | Reason |
| --- | --- |
| Models from Hugging Face by default; Cloudflare R2 mirror optional (one setting, mirror script, CORS file) | Hugging Face serves CORS and needs no setup. R2 is the fallback if the managed network blocks huggingface.co. Revisions are pinned to commit SHAs, so both serve identical bytes. |
| ONNX Runtime WASM files served from the app's own origin | No dependency on a public CDN. The files are 20.6 and 23.8 MiB, under Cloudflare's 25 MiB per-file limit. |
| Parakeet: int8 encoder on WASM (≈640 MB), fp16 on WebGPU (≈1.2 GB) | int8 cannot run on WebGPU; fp32 would be 2.4 GB. |
| Kokoro: fp16 on WASM with up to 8 threads, fp32 on WebGPU | On WASM, q8 generates at ≈1.0× real time because its int8 path is slow; fp16 runs at ≈0.45× with half of fp32's download. |
| ASR streaming: segments at pauses, re-transcribed from the segment start for live text, one final pass per segment | parakeet.js's contiguous-chunk streamer produced unusable partials, because each chunk had no context. |
| Model files bypass the HTTP cache and persist in Cache Storage | After "Clear model caches", a cold load is a real download, and gigabytes are not stored twice. |
| WASM speed probe at startup | Edge Enhanced Security Mode turns off the JIT. WASM inference would then look hopeless for reasons unrelated to the hardware. |
| Inline page icon | Browser-initiated favicon requests were counted as network traffic during runs. |

# 23. Findings So Far

All on the development machine (Ryzen 9 7900X3D, 24 threads, RTX 4070 SUPER, Chrome/Edge 154). Managed laptops will be slower; rerun the benchmark there.

## Automated tests, version 2 (production build, Edge, synthetic speech as fake microphone / shared audio)

| Metric | WASM | WebGPU |
| --- | --- | --- |
| Parakeet cold download | 670 MB in 7.7 s | 1.24 GB in 23 s |
| First live text after speech starts | 0.36 s | 0.58–0.95 s (first GPU pass of a recording is slower) |
| End of speech → final text (segment closes after a 600 ms pause) | ≈0.8 s | ≈0.8 s |
| Stop → final text (last segment already final) | ≈5 ms | ≈6 ms |
| Kokoro time to first audio | 1.1–1.3 s (fp16) | 350–560 ms (fp32) |
| Kokoro generation speed | 0.39–0.45× real time | 0.06–0.17× real time |
| Stop → first speech | 1.2 s (18 s passage) | 0.64 s (7 s clip) |
| Word error rate, benchmark phrases | 0 | 0 |

Meeting mode, 57 s synthetic meeting with four voices and nine turns: 9 lines, word error rate 0, all 9 lines attributed to the right speaker. Results were the same from the microphone, from shared screen audio, and from both at once; with both, the 9 duplicate microphone lines were detected as echo and hidden.

Read aloud (WebGPU): first audio 223 ms after the first piece was generated in 147 ms; generation 0.05× real time; no stalls.

## Real-world tests by the product owner, version 1 (deployed site, Chrome 154, USB microphone, noisy room)

- 60 s of naturally read prose on WebGPU: word error rate 5.3% (6 errors in 114 words, e.g. "Kokoro download" heard as "coro correct"). Stop → final text 625 ms, Stop → first speech 1.17 s, time to first audio 454 ms, no underruns.
- Harvard passage on Force WASM: word error rate 0. Its speed numbers were inflated by automated tests running on the same machine at the same time (final pass 0.30× real time instead of ≈0.06×).
- Version 1's live partial text was unusable in both runs ("Well. . . . . . Excellent. or two. es are set up."); version 2 replaced the chunk streamer, see above.

Every run had 0 network requests between Record and the end of playback, including runs with the browser offline after loading the models.

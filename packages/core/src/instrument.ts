/**
 * Fetch instrumentation for inference workers. OWNER: platform agent.
 *
 * Installed once at the top of each inference worker, BEFORE the model library is used. It wraps
 * globalThis.fetch to:
 *   1. rewrite https://huggingface.co/{repo}/resolve/{anyRev}/{file} for pinned repos to
 *      {source.baseUrl}/{repo}/resolve/{pinnedRev}/{file} (pins revisions + enables the R2 mirror);
 *   2. record per-request timing (request start, headers, first body byte, completion) and body
 *      bytes as the body streams through — timestamps via now() from @local-speech/core's clock;
 *   3. count every request (privacy check: no fetches should happen during a speech run).
 *
 * blob: and data: URLs (e.g. parakeet.js re-reading the blobs it cached in IndexedDB) are not network
 * traffic: they pass straight through and are neither counted nor recorded.
 */
import { now, span } from './clock.js';
import { HUGGING_FACE_BASE_URL } from './models.js';
import type { DownloadMetrics, FileFetchRecord, ModelSource } from './types.js';

export interface FetchInstrumentationOptions {
  source: ModelSource;
  /** HF repo id → pinned commit SHA. Requests for these repos are rewritten as described above. */
  pinnedRevisions: Record<string, string>;
}

export interface FetchInstrumentation {
  /** Total fetch() calls observed since install. */
  readonly requestCount: number;
  /** Start a capture window (call right before a model load). */
  beginCapture(): void;
  /** All requests since beginCapture(). Records for still-streaming bodies have completeAt === null. */
  endCapture(): FileFetchRecord[];
  /** Apply the source/pin rewrite to a URL (for loaders that build URLs themselves). */
  resolveUrl(url: string): string;
}

interface Installed extends FetchInstrumentation {
  configure(opts: FetchInstrumentationOptions): void;
}

const INSTALLED: unique symbol = Symbol.for('speech-poc/fetch-instrumentation');

/**
 * Wrap globalThis.fetch. Idempotent per JS context: a second call does not wrap again, it updates
 * the source / pins of the existing instrumentation and returns it (request count is kept).
 */
export function installFetchInstrumentation(opts: FetchInstrumentationOptions): FetchInstrumentation {
  const scope = globalThis as typeof globalThis & { [INSTALLED]?: Installed };
  const existing = scope[INSTALLED];
  if (existing) {
    existing.configure(opts);
    return existing;
  }
  const realFetch = globalThis.fetch.bind(globalThis);
  let rules = compileRules(opts);
  let requestCount = 0;
  let captured: FileFetchRecord[] | null = null;

  const instrumentedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/^(?:blob|data):/i.test(raw)) return realFetch(input, init);

    requestCount++;
    const target = resolveTarget(raw, rules);
    const request = !target.rewritten ? input : input instanceof Request ? new Request(target.url, input) : target.url;
    const record: FileFetchRecord = {
      file: target.file,
      url: target.url,
      kind: target.kind,
      requestStart: now(),
      responseHeadersAt: null,
      firstByteAt: null,
      completeAt: null,
      bytes: 0,
      status: null,
      error: null,
    };
    captured?.push(record);

    // Model files persist in the Cache API (transformers.js, kokoro-voices, the parakeet loader), which
    // the libraries check before fetching. Bypassing the HTTP cache keeps a cold load a real network
    // download after "Clear model caches", and avoids storing gigabytes twice.
    const requestInit: RequestInit | undefined = target.kind === 'model' ? { ...init, cache: 'no-store' } : init;

    let response: Response;
    try {
      response = await realFetch(request, requestInit);
    } catch (err) {
      record.error = describeError(err);
      throw err;
    }
    record.responseHeadersAt = now();
    if (response.type === 'opaque' || response.type === 'opaqueredirect') return response; // nothing observable
    record.status = response.status;
    if (!response.ok) {
      record.error = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
      return response;
    }
    if (!response.body) {
      record.completeAt = record.responseHeadersAt;
      return response;
    }
    return target.kind === 'runtime' ? countAlongside(response, record) : countThrough(response, record);
  };

  const installed: Installed = {
    get requestCount() {
      return requestCount;
    },
    beginCapture() {
      captured = [];
    },
    endCapture() {
      const records = (captured ?? []).map((r) => ({ ...r }));
      captured = null;
      return records;
    },
    resolveUrl(url) {
      const target = resolveTarget(url, rules);
      return target.rewritten ? target.url : url;
    },
    configure(next) {
      rules = compileRules(next);
    },
  };
  (globalThis as { fetch: typeof fetch }).fetch = instrumentedFetch;
  scope[INSTALLED] = installed;
  return installed;
}

/**
 * Build DownloadMetrics from captured records and the list of files the load needed.
 * Model files (kind 'model') count toward downloadedBytes; runtime assets are reported separately.
 * Expected files with no network record are reported as cachedFiles.
 */
export function summarizeDownloads(expectedFiles: string[], records: FileFetchRecord[]): DownloadMetrics {
  const byStart = [...records].sort((a, b) => a.requestStart - b.requestStart).map((r) => ({ ...r }));
  const networkFiles = byStart.filter((r) => r.kind === 'model');
  const runtimeFiles = byStart.filter((r) => r.kind === 'runtime');

  const fetched = new Set(networkFiles.map((r) => r.file));
  const succeeded = networkFiles.filter((r) => r.error === null && r.completeAt !== null);
  // Complete once every expected file that went to the network has a finished, successful response
  // (a failed attempt followed by a successful retry counts as finished).
  const allExpectedArrived = expectedFiles.every((f) => !fetched.has(f) || succeeded.some((r) => r.file === f));

  const downloadStart = minOf(networkFiles.map((r) => r.requestStart));
  const firstByteAt = minOf(networkFiles.map((r) => r.firstByteAt));
  const downloadComplete = allExpectedArrived ? maxOf(succeeded.map((r) => r.completeAt)) : null;
  const totalDownloadMs = span(downloadStart, downloadComplete);
  const downloadedBytes = sumBytes(networkFiles);

  return {
    expectedFiles: [...expectedFiles],
    networkFiles,
    cachedFiles: expectedFiles.filter((f) => !fetched.has(f)),
    downloadStart,
    firstByteAt,
    downloadComplete,
    timeToFirstByteMs: span(downloadStart, firstByteAt),
    totalDownloadMs,
    downloadedBytes,
    // bytes / 1e6 per (ms / 1e3)
    effectiveMBps: totalDownloadMs !== null && totalDownloadMs > 0 ? downloadedBytes / 1e3 / totalDownloadMs : null,
    runtimeFiles,
    runtimeBytes: sumBytes(runtimeFiles),
  };
}

// ---------------------------------------------------------------------------
// URL rewriting and classification
// ---------------------------------------------------------------------------

interface Rules {
  /** Normalized source base URL, no trailing slash. */
  base: string;
  /** Hosts whose /{org}/{name}/resolve/{rev}/{path} URLs are recognised as model files. */
  repoHosts: string[];
  pins: Record<string, string>;
}

interface Target {
  url: string;
  rewritten: boolean;
  kind: FileFetchRecord['kind'];
  file: string;
}

function compileRules(opts: FetchInstrumentationOptions): Rules {
  const base = normalizeBase(opts.source.baseUrl);
  const huggingFace = normalizeBase(HUGGING_FACE_BASE_URL);
  return {
    base,
    repoHosts: base === huggingFace ? [huggingFace] : [huggingFace, base],
    pins: { ...opts.pinnedRevisions },
  };
}

function normalizeBase(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return (url.origin + url.pathname).replace(/\/+$/, '');
  } catch {
    return baseUrl.replace(/\/+$/, '');
  }
}

function resolveTarget(raw: string, rules: Rules): Target {
  let url: URL;
  try {
    url = new URL(raw, globalThis.location?.href);
  } catch {
    return { url: raw, rewritten: false, kind: 'other', file: raw };
  }
  const location = url.origin + url.pathname;
  for (const host of rules.repoHosts) {
    if (!location.startsWith(`${host}/`)) continue;
    const m = /^([^/]+)\/([^/]+)\/resolve\/[^/]+\/(.+)$/.exec(location.slice(host.length + 1));
    if (!m) continue;
    const repo = `${decode(m[1])}/${decode(m[2])}`;
    if (!Object.hasOwn(rules.pins, repo)) continue;
    const pinned = `${rules.base}/${m[1]}/${m[2]}/resolve/${encodeURIComponent(rules.pins[repo])}/${m[3]}${url.search}`;
    return {
      url: pinned,
      rewritten: pinned !== url.href,
      kind: 'model',
      file: m[3].split('/').map(decode).join('/'),
    };
  }
  const isRuntime = /\.(?:wasm|mjs)$/i.test(url.pathname) || url.pathname.includes('/ort/');
  return {
    url: url.href,
    rewritten: false,
    kind: isRuntime ? 'runtime' : 'other',
    file: isRuntime ? decode(url.pathname.slice(url.pathname.lastIndexOf('/') + 1)) : decode(url.pathname),
  };
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------
// Body counting
// ---------------------------------------------------------------------------

/** Model / other files: the body is re-streamed through a counter, so bytes are counted exactly once. */
function countThrough(response: Response, record: FileFetchRecord): Response {
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      record.firstByteAt ??= now();
      record.bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush() {
      record.completeAt = now();
    },
  });
  // Rejects when the connection fails mid-body or the consumer cancels the body; the consumer sees
  // the same error through the counted stream, so this only records it.
  response.body!.pipeTo(counter.writable).catch((err: unknown) => {
    record.error ??= `body: ${describeError(err)}`;
  });
  // status/statusText/headers keep response.ok and Content-Length (used for progress) intact.
  const counted = new Response(counter.readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // A constructed Response reports url '' and redirected false; callers use url in error messages.
  Object.defineProperties(counted, {
    url: { value: response.url },
    redirected: { value: response.redirected },
  });
  return counted;
}

/**
 * Runtime assets (.wasm/.mjs): hand the caller the ORIGINAL response and count a clone. ONNX Runtime
 * passes the .wasm response to WebAssembly.instantiateStreaming(), and Chromium's compiled-wasm code
 * cache only works with the real network response (it is keyed by the response URL and needs the
 * response's cache handle, which a `new Response(...)` does not have). Re-wrapping it would make
 * every warm load recompile ~24 MB of wasm and skew initialization timings. The files are small
 * enough (< 25 MiB) for the clone's tee buffer not to matter.
 */
function countAlongside(response: Response, record: FileFetchRecord): Response {
  const reader = response.clone().body!.getReader();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        record.firstByteAt ??= now();
        record.bytes += value.byteLength;
      }
      record.completeAt = now();
    } catch (err) {
      record.error ??= `body: ${describeError(err)}`;
    }
  })();
  return response;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === 'object' && err !== null && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

function minOf(values: (number | null)[]): number | null {
  let min: number | null = null;
  for (const v of values) if (v !== null && (min === null || v < min)) min = v;
  return min;
}

function maxOf(values: (number | null)[]): number | null {
  let max: number | null = null;
  for (const v of values) if (v !== null && (max === null || v > max)) max = v;
  return max;
}

function sumBytes(records: FileFetchRecord[]): number {
  return records.reduce((total, r) => total + r.bytes, 0);
}

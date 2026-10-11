/**
 * Persistent storage for Parakeet model files. Runs inside the ASR worker.
 *
 * Files are keyed by their canonical Hugging Face URL at the pinned revision, so Hugging Face and an R2
 * mirror (byte-identical files) share cache entries. Downloads stream straight into the Cache API and
 * are read back as Blobs, which browsers keep on disk: this module never holds a 0.6–2.3 GB file in JS
 * memory (ONNX Runtime makes its own copy when it creates the session).
 *
 * parakeet.js's own getParakeetModel()/fromHub() is deliberately not used: it always calls the
 * huggingface.co tree API (breaks the mirror and locked-down networks) and caches in IndexedDB.
 */
import { HUGGING_FACE_BASE_URL, modelFileUrl } from '@local-speech/core';
import { PARAKEET_MODEL } from './models.js';
import { describeError } from './protocol.js';

/** Listed in MODEL_CACHE_NAMES (cache.ts in @local-speech/core) so "clear model caches" removes it. */
export const PARAKEET_CACHE_NAME = 'speech-poc-models-v1';

export function canonicalModelUrl(file: string): string {
  const huggingFace = { kind: 'huggingface', baseUrl: HUGGING_FACE_BASE_URL } as const;
  return modelFileUrl(huggingFace, PARAKEET_MODEL.repo, PARAKEET_MODEL.revision, file);
}

/** `done` is true once, when the whole body has been read. */
export type ByteProgress = (loaded: number, total: number | null, done: boolean) => void;

export interface RetrievedFile {
  blob: Blob;
  fromNetwork: boolean;
  /** Set when a downloaded file could not be kept for the next load (quota, storage failure). */
  storageError: string | null;
}

export async function openModelCache(): Promise<{ cache: Cache | null; error: string | null }> {
  if (typeof caches === 'undefined') return { cache: null, error: 'the Cache API is not available here' };
  try {
    return { cache: await caches.open(PARAKEET_CACHE_NAME), error: null };
  } catch (err) {
    return { cache: null, error: `the Cache API cannot be opened (${describeError(err)})` };
  }
}

/**
 * Cache hit → Blob from storage. Miss → fetch(url) (the worker's fetch instrumentation rewrites it to
 * the configured source and records timing/bytes), streamed into the cache, then read back from it.
 * `store: false` still reads the cache but does not try to write to it.
 */
export async function retrieveModelFile(
  cache: Cache | null,
  url: string,
  onProgress: ByteProgress,
  store: boolean,
): Promise<RetrievedFile> {
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      const blob = await hit.blob();
      onProgress(blob.size, blob.size, true);
      return { blob, fromNetwork: false, storageError: null };
    }
  }

  const response = await fetchOk(url);
  const total = declaredLength(response);
  // A missing cache was already reported by the caller, once.
  const notStored = !cache ? null : store ? await quotaShortfall(total) : 'not stored, because storing an earlier file failed';
  if (!cache || notStored) {
    return { blob: await new Response(counted(response, total, onProgress)).blob(), fromNetwork: true, storageError: notStored };
  }

  let bodyComplete = false;
  try {
    const body = counted(response, total, onProgress, () => (bodyComplete = true));
    await cache.put(url, new Response(body, { headers: storedHeaders(response, total) }));
    const stored = await cache.match(url);
    if (!stored) throw new Error('the entry was missing right after it was written');
    return { blob: await stored.blob(), fromNetwork: true, storageError: null };
  } catch (err) {
    // A TypeError before the body finished is the download itself failing. Anything else is the
    // storage side (quota, eviction, disk); the body is gone by then, so fetch once more without caching.
    if (err instanceof TypeError && !bodyComplete) throw err;
    const again = await fetchOk(url);
    const blob = await new Response(counted(again, declaredLength(again), onProgress)).blob();
    return { blob, fromNetwork: true, storageError: `storing it in the Cache API failed (${describeError(err)})` };
  }
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
  }
  return response;
}

function counted(response: Response, total: number | null, onProgress: ByteProgress, onComplete?: () => void): ReadableStream<Uint8Array> {
  let loaded = 0;
  onProgress(0, total, false);
  return response.body!.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loaded += chunk.byteLength;
        onProgress(loaded, total, false);
        controller.enqueue(chunk);
      },
      flush() {
        onProgress(loaded, total, true);
        onComplete?.();
      },
    }),
  );
}

function declaredLength(response: Response): number | null {
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding !== 'identity') return null; // Content-Length would count encoded bytes
  const length = Number(response.headers.get('content-length'));
  return Number.isFinite(length) && length > 0 ? length : null;
}

function storedHeaders(response: Response, total: number | null): Headers {
  const headers = new Headers({ 'content-type': response.headers.get('content-type') ?? 'application/octet-stream' });
  if (total != null) headers.set('content-length', String(total));
  return headers;
}

async function quotaShortfall(bytes: number | null): Promise<string | null> {
  if (bytes == null || typeof navigator.storage?.estimate !== 'function') return null;
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (quota == null || usage == null || bytes <= quota - usage) return null;
    const mb = (n: number) => Math.round(n / 1e6);
    return `not enough storage quota to keep it (${mb(bytes)} MB needed, ${mb(quota - usage)} MB available)`;
  } catch {
    return null;
  }
}

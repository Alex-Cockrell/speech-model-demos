/**
 * Persistent storage for the speaker model file. Runs inside the speaker worker.
 *
 * The file is cached in the Cache API under its canonical Hugging Face URL at the pinned revision, so Hugging
 * Face and an R2 mirror (byte-identical files) share one entry and a warm load makes no network request. The
 * cache is the one the Parakeet loader uses, which "Clear model caches" already deletes (MODEL_CACHE_NAMES).
 */
import { HUGGING_FACE_BASE_URL, SPEAKER_MODEL, modelFileUrl } from '../config';
import { errorMessage } from './protocol';

export const SPEAKER_CACHE_NAME = 'speech-poc-models-v1';

export function canonicalModelUrl(file: string): string {
  return modelFileUrl({ kind: 'huggingface', baseUrl: HUGGING_FACE_BASE_URL }, SPEAKER_MODEL.repo, SPEAKER_MODEL.revision, file);
}

export type ByteProgress = (loaded: number, total: number | null, done: boolean) => void;

export interface RetrievedModel {
  bytes: Uint8Array<ArrayBuffer>;
  fromNetwork: boolean;
  /** Why a downloaded file could not be kept for the next load (no Cache API, quota, storage failure). */
  storageError: string | null;
}

/**
 * Cache hit → bytes from storage, no network. Miss → fetch(url) (the worker's fetch instrumentation rewrites it
 * to the configured source and pinned revision, and records timing and bytes), then store a copy.
 */
export async function retrieveModelFile(url: string, onProgress: ByteProgress): Promise<RetrievedModel> {
  let cache: Cache | null = null;
  let storageError: string | null = null;
  try {
    if (typeof caches === 'undefined') throw new Error('the Cache API is not available here');
    cache = await caches.open(SPEAKER_CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      onProgress(bytes.byteLength, bytes.byteLength, true);
      return { bytes, fromNetwork: false, storageError: null };
    }
  } catch (e) {
    storageError = errorMessage(e);
    cache = null;
  }

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
  }
  const bytes = await readBody(response, onProgress);
  if (cache) {
    try {
      // A BufferSource body is copied when the Response is constructed, so the caller may modify `bytes` later.
      const headers = { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) };
      await cache.put(url, new Response(bytes, { headers }));
    } catch (e) {
      storageError = `storing it in the Cache API failed (${errorMessage(e)})`;
    }
  }
  return { bytes, fromNetwork: true, storageError };
}

async function readBody(response: Response, onProgress: ByteProgress): Promise<Uint8Array<ArrayBuffer>> {
  const encoding = response.headers.get('content-encoding');
  const declared = Number(response.headers.get('content-length'));
  const total = (!encoding || encoding === 'identity') && Number.isFinite(declared) && declared > 0 ? declared : null;
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  onProgress(0, total, false);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total, false);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress(loaded, total, true);
  return bytes;
}

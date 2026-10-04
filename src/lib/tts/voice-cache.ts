/** Worker-only helper: pre-fetches a Kokoro voice into the cache kokoro-js reads from. */
import { HUGGING_FACE_BASE_URL, KOKORO_MODEL } from '../config';

/** Cache API name kokoro-js 1.2.1 stores voices in (also listed in MODEL_CACHE_NAMES for clearing). */
const VOICE_CACHE = 'kokoro-voices';

/**
 * Must be byte-identical to the URL kokoro-js builds, because it is also kokoro-js's cache key. The fetch
 * instrumentation rewrites the request to the pinned revision and the configured source.
 */
function voiceUrl(voice: string): string {
  return `${HUGGING_FACE_BASE_URL}/${KOKORO_MODEL.repo}/resolve/main/${KOKORO_MODEL.voiceFile(voice)}`;
}

/**
 * Stores the voice embedding the way kokoro-js would, unless it is already cached, so it downloads in parallel
 * with the model (instead of inside the warm-up) and later runs need no network.
 * Returns the bytes fetched over the network (0 when it was already cached).
 */
export async function prefetchVoice(voice: string): Promise<number> {
  const url = voiceUrl(voice);
  let cache: Cache | null = null;
  try {
    cache = await caches.open(VOICE_CACHE);
    if (await cache.match(url)) return 0;
  } catch {
    // Cache API blocked (some private modes): kokoro-js then re-fetches the voice on every load as well.
    cache = null;
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Kokoro voice "${voice}" could not be downloaded (HTTP ${response.status}).`);
  }
  const bytes = await response.arrayBuffer();
  // A failed cache write is not fatal: kokoro-js fetches the voice itself on first use.
  await cache?.put(url, new Response(bytes, { headers: response.headers })).catch(() => undefined);
  return bytes.byteLength;
}

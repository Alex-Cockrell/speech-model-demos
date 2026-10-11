/**
 * Moves voice-model files that kokoro-js stored into the shared model cache, so visitors who loaded the voice model
 * with an earlier version don't download it again. kokoro-js (through transformers.js) kept the weights and
 * tokenizer in 'transformers-cache' and the voices in 'kokoro-voices', keyed by their Hugging Face URL at revision
 * 'main'. Those bytes are the pinned revision's: the fetch instrumentation pinned every request.
 */
import { HUGGING_FACE_BASE_URL } from '@localspeech/core';

const LEGACY_CACHES = ['transformers-cache', 'kokoro-voices'] as const;

/** Best effort: any failure leaves the file to be downloaded as usual. */
export async function adoptLegacyEntry(cache: Cache, repo: string, file: string, canonicalUrl: string): Promise<void> {
  try {
    if (typeof caches === 'undefined' || (await cache.match(canonicalUrl))) return;
    const legacyUrl = `${HUGGING_FACE_BASE_URL}/${repo}/resolve/main/${file}`;
    for (const name of LEGACY_CACHES) {
      if (!(await caches.has(name))) continue;
      const legacy = await caches.open(name);
      const hit = await legacy.match(legacyUrl);
      if (!hit) continue;
      await cache.put(canonicalUrl, hit);
      await legacy.delete(legacyUrl);
      return;
    }
  } catch (err) {
    console.warn(`[tts] could not reuse a stored copy of ${file}:`, err);
  }
}

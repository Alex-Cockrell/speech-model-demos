import type { ModelSource } from './types.js';

export const HUGGING_FACE_BASE_URL = 'https://huggingface.co';

/**
 * Pinned model artifacts use commit SHAs as revisions, so Hugging Face and a mirror serve byte-identical files.
 * Mirror object keys use the same layout as Hugging Face: {baseUrl}/{repo}/resolve/{revision}/{file}
 */
export function modelFileUrl(source: ModelSource, repo: string, revision: string, file: string): string {
  return `${source.baseUrl}/${repo}/resolve/${revision}/${file}`;
}

/**
 * The model source for a configured base URL: Hugging Face itself, or a mirror. A path such as '/models' means this
 * site serves the files; it is resolved against the page, because workers need an absolute URL.
 */
export function modelSourceFor(baseUrl: string): ModelSource {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed === HUGGING_FACE_BASE_URL) return { kind: 'huggingface', baseUrl: HUGGING_FACE_BASE_URL };
  let url: URL;
  try {
    url = new URL(trimmed, globalThis.location?.href);
  } catch {
    throw new Error(`modelBaseUrl "${baseUrl}" is not a valid URL or path.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`modelBaseUrl must be an http(s) URL or a path on this site (such as /models), not "${baseUrl}".`);
  }
  return { kind: 'mirror', baseUrl: url.href.replace(/\/+$/, '') };
}

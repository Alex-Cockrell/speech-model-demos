import type { ModelSource } from './types.js';

export const HUGGING_FACE_BASE_URL = 'https://huggingface.co';

/**
 * Pinned model artifacts use commit SHAs as revisions, so Hugging Face and a mirror serve byte-identical files.
 * Mirror object keys use the same layout as Hugging Face: {baseUrl}/{repo}/resolve/{revision}/{file}
 */
export function modelFileUrl(source: ModelSource, repo: string, revision: string, file: string): string {
  return `${source.baseUrl}/${repo}/resolve/${revision}/${file}`;
}

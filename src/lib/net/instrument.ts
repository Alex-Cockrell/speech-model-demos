/**
 * Fetch instrumentation for inference workers. OWNER: platform agent.
 *
 * Installed once at the top of each inference worker, BEFORE the model library is used. It wraps
 * globalThis.fetch to:
 *   1. rewrite https://huggingface.co/{repo}/resolve/{anyRev}/{file} for pinned repos to
 *      {source.baseUrl}/{repo}/resolve/{pinnedRev}/{file} (pins revisions + enables the R2 mirror);
 *   2. record per-request timing (request start, headers, first body byte, completion) and body
 *      bytes by teeing the response body stream — timestamps via now() from '@/lib/clock';
 *   3. count every request (privacy check: no fetches should happen during a speech run).
 *
 * This file currently holds the public interface only; the implementation replaces the bodies.
 */
import type { DownloadMetrics, FileFetchRecord, ModelSource } from '../types';

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

export function installFetchInstrumentation(_opts: FetchInstrumentationOptions): FetchInstrumentation {
  throw new Error('installFetchInstrumentation not implemented');
}

/**
 * Build DownloadMetrics from captured records and the list of files the load needed.
 * Model files (kind 'model') count toward downloadedBytes; runtime assets are reported separately.
 * Expected files with no network record are reported as cachedFiles.
 */
export function summarizeDownloads(_expectedFiles: string[], _records: FileFetchRecord[]): DownloadMetrics {
  throw new Error('summarizeDownloads not implemented');
}

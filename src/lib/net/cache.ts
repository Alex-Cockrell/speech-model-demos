/**
 * Persistent model storage helpers (main thread). OWNER: platform agent.
 *
 * This file currently holds the public interface only; the implementation replaces the bodies.
 */
import type { StorageInfo } from '../types';

/** Cache API cache names used for model files: transformers.js, kokoro-js voices, our parakeet loader. */
export const MODEL_CACHE_NAMES = ['transformers-cache', 'kokoro-voices', 'speech-poc-models-v1'] as const;
/** IndexedDB databases that may hold model files (parakeet.js's own hub cache, if ever used). */
export const MODEL_IDB_NAMES = ['parakeet-cache-db'] as const;

/** Delete every persistent model cache so the next load is cold. Returns what was deleted. */
export async function clearModelCaches(): Promise<string[]> {
  throw new Error('clearModelCaches not implemented');
}

export async function getStorageInfo(): Promise<StorageInfo> {
  throw new Error('getStorageInfo not implemented');
}

/** navigator.storage.persist(); returns the resulting persisted state. */
export async function requestPersistentStorage(): Promise<boolean> {
  throw new Error('requestPersistentStorage not implemented');
}

/**
 * Counts network requests made by the page itself (PerformanceObserver resource entries) between
 * start() and stop(). Worker requests are counted by the engines' networkRequestCount().
 */
export function createPageNetworkMonitor(): { start(): void; stop(): number } {
  throw new Error('createPageNetworkMonitor not implemented');
}

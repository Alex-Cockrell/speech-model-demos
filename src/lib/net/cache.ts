/**
 * Persistent model storage helpers (main thread). OWNER: platform agent.
 */
import type { StorageInfo } from '../types';

/** Cache API cache names used for model files: transformers.js, kokoro-js voices, our parakeet loader. */
export const MODEL_CACHE_NAMES = ['transformers-cache', 'kokoro-voices', 'speech-poc-models-v1'] as const;
/** IndexedDB databases that may hold model files (parakeet.js's own hub cache, if ever used). */
export const MODEL_IDB_NAMES = ['parakeet-cache-db'] as const;

/**
 * How long an IndexedDB deletion may stay 'blocked' before giving up. A worker that was just
 * terminated releases its connection within milliseconds; another open tab of the app never does.
 */
const IDB_BLOCKED_TIMEOUT_MS = 5000;

/**
 * Delete every persistent model cache so the next load is cold. Returns what was deleted.
 * Terminate the inference workers first: they may hold the IndexedDB database open.
 * Does not touch the browser's HTTP cache (see README: cold runs).
 */
export async function clearModelCaches(): Promise<string[]> {
  const deleted: string[] = [];
  if (typeof caches !== 'undefined') {
    for (const name of MODEL_CACHE_NAMES) {
      if (await caches.delete(name)) deleted.push(`Cache Storage: ${name}`);
    }
  }
  if (typeof indexedDB !== 'undefined') {
    const existing = await listDatabases();
    for (const name of MODEL_IDB_NAMES) {
      if (existing && !existing.has(name)) continue;
      await deleteDatabase(name);
      deleted.push(`IndexedDB: ${name}`);
    }
  }
  return deleted;
}

export async function getStorageInfo(): Promise<StorageInfo> {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  const info: StorageInfo = { usageBytes: null, quotaBytes: null, persisted: null };
  try {
    const estimate = await storage?.estimate?.();
    info.usageBytes = estimate?.usage ?? null;
    info.quotaBytes = estimate?.quota ?? null;
  } catch {
    // estimate() is missing or rejected (e.g. storage access blocked by policy): leave null.
  }
  try {
    info.persisted = storage?.persisted ? await storage.persisted() : null;
  } catch {
    info.persisted = null;
  }
  return info;
}

/** navigator.storage.persist(); returns the resulting persisted state. */
export async function requestPersistentStorage(): Promise<boolean> {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!storage?.persist) return false;
  try {
    return await storage.persist();
  } catch {
    return false;
  }
}

/**
 * Counts network requests made by the page itself (PerformanceObserver resource entries) between
 * start() and stop(). Worker requests are counted by the engines' networkRequestCount().
 *
 * Resource entries are created when a response completes, so a request still in flight at stop()
 * (or finishing in the same task as stop()) is not counted.
 */
export function createPageNetworkMonitor(): { start(): void; stop(): number } {
  let observer: PerformanceObserver | null = null;
  let windowStart: number | null = null;
  const entries = new Set<PerformanceEntry>();

  const collect = (list: PerformanceEntryList) => {
    for (const entry of list) {
      if (windowStart !== null && entry.startTime >= windowStart && !/^(?:blob|data):/i.test(entry.name)) {
        entries.add(entry);
      }
    }
  };

  return {
    start() {
      observer?.disconnect();
      entries.clear();
      // entry.startTime is on this document's performance.now() timeline.
      windowStart = performance.now();
      observer = null;
      if (typeof PerformanceObserver === 'undefined') return;
      try {
        observer = new PerformanceObserver((list) => collect(list.getEntries()));
        observer.observe({ type: 'resource' });
      } catch {
        observer = null;
      }
    },
    stop() {
      if (observer) {
        // Entries for responses that completed before stop() but were not delivered yet.
        collect(observer.takeRecords());
        observer.disconnect();
        observer = null;
      }
      windowStart = null;
      return entries.size;
    },
  };
}

async function listDatabases(): Promise<Set<string> | null> {
  try {
    if (typeof indexedDB.databases !== 'function') return null;
    const databases = await indexedDB.databases();
    return new Set(databases.map((db) => db.name).filter((name): name is string => !!name));
  } catch {
    return null;
  }
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve();
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`Deleting IndexedDB "${name}" failed: ${request.error?.message ?? 'unknown error'}`));
    };
    // 'blocked' means another connection is still open; the deletion completes once it closes.
    request.onblocked = () => {
      timer ??= setTimeout(() => {
        reject(
          new Error(
            `Deleting IndexedDB "${name}" is blocked by another open connection — close other tabs of this app. ` +
              'The deletion finishes once they close.',
          ),
        );
      }, IDB_BLOCKED_TIMEOUT_MS);
    };
  });
}

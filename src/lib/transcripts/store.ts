/**
 * Saved transcripts in IndexedDB. OWNER: meeting agent.
 *
 * Database 'speech-poc-transcripts' is deliberately not one of the model caches (lib/net/cache.ts), so
 * "Clear model caches" never deletes transcripts. Two object stores, written together in one transaction:
 * 'summaries' (what the saved list shows, small) and 'transcripts' (the full MeetingTranscript).
 */
import { errorMessage } from '../benchmark/errors';
import type { AudioSourceKind } from '../types';
import { echoCount } from './model';
import type { MeetingSegment, MeetingSpeaker, MeetingTranscript, TranscriptStatus, TranscriptSummary } from './types';

export const TRANSCRIPT_DB_NAME = 'speech-poc-transcripts';
const DB_VERSION = 1;
const SUMMARIES = 'summaries';
const TRANSCRIPTS = 'transcripts';
/** How long opening may stay blocked (another tab holding an older version open) before giving up. */
const OPEN_BLOCKED_TIMEOUT_MS = 5000;

export interface StoredTranscript {
  transcript: MeetingTranscript;
  summary: TranscriptSummary;
}

export interface TranscriptStore {
  /** Newest first. */
  list(): Promise<TranscriptSummary[]>;
  get(id: string): Promise<StoredTranscript | null>;
  /** Insert or replace; returns the summary that was stored. */
  put(transcript: MeetingTranscript, status: TranscriptStatus): Promise<TranscriptSummary>;
  /** Changes the title of a stored transcript; null when it does not exist (any more). */
  rename(id: string, title: string): Promise<TranscriptSummary | null>;
  delete(id: string): Promise<void>;
}

export function summarizeTranscript(t: MeetingTranscript, status: TranscriptStatus, savedAtMs: number): TranscriptSummary {
  const visible = t.segments.filter((s) => s.echoOf === null);
  const speakers = new Set<string>();
  for (const s of visible) if (s.speakerId !== null) speakers.add(s.speakerId);
  return {
    id: t.id,
    title: t.title,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    durationMs: t.durationMs,
    sources: [...t.sources],
    speakerCount: speakers.size,
    segmentCount: visible.length,
    status,
    savedAtMs,
    echoLines: echoCount(t.segments),
  };
}

/** Readable message for a storage failure, with what to do about it. */
export function storageErrorMessage(e: unknown): string {
  const name = typeof e === 'object' && e !== null ? ((e as { name?: unknown }).name ?? '') : '';
  switch (name) {
    case 'QuotaExceededError':
      return (
        'Browser storage is full. Export the transcript to keep it, then free space: delete old transcripts, or clear ' +
        'model caches on the Benchmark tab.'
      );
    case 'SecurityError':
      return (
        'This browser profile does not allow site storage (private window or a policy), so transcripts cannot be ' +
        'saved here. Export them instead.'
      );
    case 'InvalidStateError':
      return 'The transcript database was closed (another tab of this app upgraded or deleted it). Reload the page.';
    case 'UnknownError':
      return `The browser could not write to its storage (UnknownError: the disk may be full or the profile's storage damaged). ${errorMessage(e)}`;
    default:
      return errorMessage(e);
  }
}

// ---------------------------------------------------------------------------
// Validation of stored data (older versions, other tabs, hand edits)
// ---------------------------------------------------------------------------

const SOURCES: readonly AudioSourceKind[] = ['mic', 'system'];
const STATUSES: readonly TranscriptStatus[] = ['recording', 'complete', 'interrupted'];

type Loose = Record<string, unknown>;

function isObject(v: unknown): v is Loose {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function source(v: unknown): AudioSourceKind {
  return SOURCES.includes(v as AudioSourceKind) ? (v as AudioSourceKind) : 'mic';
}

function normalizeSegment(raw: unknown): MeetingSegment | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.text !== 'string') return null;
  return {
    id: raw.id,
    source: source(raw.source),
    startMs: num(raw.startMs),
    endMs: num(raw.endMs, num(raw.startMs)),
    text: raw.text,
    words: Array.isArray(raw.words) ? (raw.words as MeetingSegment['words']) : null,
    speakerId: typeof raw.speakerId === 'string' ? raw.speakerId : null,
    speakerConfidence: typeof raw.speakerConfidence === 'number' ? raw.speakerConfidence : null,
    echoOf: typeof raw.echoOf === 'string' ? raw.echoOf : null,
    speakerManual: raw.speakerManual === true,
    originalText: typeof raw.originalText === 'string' ? raw.originalText : null,
  };
}

/** Accepts a MeetingTranscript or a plain Transcript (missing meeting fields get defaults); null when unusable. */
export function normalizeTranscript(raw: unknown): MeetingTranscript | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || !Array.isArray(raw.segments)) return null;
  const segments = raw.segments.map(normalizeSegment).filter((s): s is MeetingSegment => s !== null);
  const rawSpeakers = Array.isArray(raw.speakers) ? raw.speakers.filter(isObject) : [];
  let next = 1 + Math.max(0, ...rawSpeakers.map((s) => num(s.number)));
  const speakers: MeetingSpeaker[] = rawSpeakers
    .filter((s) => typeof s.id === 'string')
    .map((s) => {
      const number = Number.isInteger(s.number) && (s.number as number) > 0 ? (s.number as number) : next++;
      return { id: s.id as string, name: str(s.name) || `Speaker ${number}`, source: source(s.source), number };
    });
  const createdAt = str(raw.createdAt, new Date(0).toISOString());
  const models = isObject(raw.models) ? (raw.models as MeetingTranscript['models']) : { asr: null, speaker: null };
  const app = isObject(raw.app) ? (raw.app as MeetingTranscript['app']) : { version: 'unknown', commit: null };
  return {
    schemaVersion: 1,
    id: raw.id,
    title: str(raw.title) || 'Untitled meeting',
    createdAt,
    updatedAt: str(raw.updatedAt, createdAt),
    durationMs: num(raw.durationMs),
    sources: Array.isArray(raw.sources) ? raw.sources.filter((s): s is AudioSourceKind => SOURCES.includes(s as AudioSourceKind)) : [],
    speakers,
    segments,
    stats: isObject(raw.stats) ? (raw.stats as unknown as MeetingTranscript['stats']) : null,
    models: { asr: models.asr ?? null, speaker: models.speaker ?? null },
    app,
  };
}

function normalizeSummary(raw: unknown): TranscriptSummary | null {
  if (!isObject(raw) || typeof raw.id !== 'string') return null;
  const createdAt = str(raw.createdAt, new Date(0).toISOString());
  return {
    id: raw.id,
    title: str(raw.title) || 'Untitled meeting',
    createdAt,
    updatedAt: str(raw.updatedAt, createdAt),
    durationMs: num(raw.durationMs),
    sources: Array.isArray(raw.sources) ? raw.sources.filter((s): s is AudioSourceKind => SOURCES.includes(s as AudioSourceKind)) : [],
    speakerCount: num(raw.speakerCount),
    segmentCount: num(raw.segmentCount),
    status: STATUSES.includes(raw.status as TranscriptStatus) ? (raw.status as TranscriptStatus) : 'complete',
    savedAtMs: num(raw.savedAtMs),
    echoLines: num(raw.echoLines),
  };
}

/** Newest first. */
export function sortSummaries<T extends TranscriptSummary>(items: T[]): T[] {
  return items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

/** Resolves when the transaction commits; rejects with its error (e.g. QuotaExceededError) when it aborts. */
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException('The transcript database transaction was aborted.', 'AbortError'));
    tx.onerror = () => {
      // Followed by abort; reject early with the request's error so the cause is kept.
      reject(tx.error ?? new Error('The transcript database transaction failed.'));
    };
  });
}

export function createIndexedDbTranscriptStore(): TranscriptStore {
  let opening: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    if (opening) return opening;
    const attempt = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available in this browser (or is turned off by a policy), so transcripts cannot be saved here.'));
        return;
      }
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(TRANSCRIPT_DB_NAME, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      let blockedTimer: ReturnType<typeof setTimeout> | undefined;
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SUMMARIES)) db.createObjectStore(SUMMARIES, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(TRANSCRIPTS)) db.createObjectStore(TRANSCRIPTS, { keyPath: 'id' });
      };
      request.onsuccess = () => {
        clearTimeout(blockedTimer);
        const db = request.result;
        // Another tab wants to upgrade or delete the database: let it, and reopen on the next call.
        db.onversionchange = () => {
          db.close();
          if (opening === attempt) opening = null;
        };
        db.onclose = () => {
          if (opening === attempt) opening = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        clearTimeout(blockedTimer);
        reject(request.error ?? new Error('Opening the transcript database failed.'));
      };
      request.onblocked = () => {
        blockedTimer ??= setTimeout(
          () => reject(new Error('The transcript database is blocked by another open tab of this app. Close the other tabs and try again.')),
          OPEN_BLOCKED_TIMEOUT_MS,
        );
      };
    });
    opening = attempt;
    attempt.catch(() => {
      if (opening === attempt) opening = null; // let the next call retry
    });
    return attempt;
  };

  const write = async (fn: (summaries: IDBObjectStore, transcripts: IDBObjectStore) => void): Promise<void> => {
    const db = await open();
    const tx = db.transaction([SUMMARIES, TRANSCRIPTS], 'readwrite');
    const done = transactionDone(tx);
    fn(tx.objectStore(SUMMARIES), tx.objectStore(TRANSCRIPTS));
    await done;
  };

  return {
    async list() {
      const db = await open();
      const tx = db.transaction(SUMMARIES, 'readonly');
      const rows = await requestResult(tx.objectStore(SUMMARIES).getAll());
      return sortSummaries(rows.map(normalizeSummary).filter((s): s is TranscriptSummary => s !== null));
    },

    async get(id) {
      const db = await open();
      const tx = db.transaction([SUMMARIES, TRANSCRIPTS], 'readonly');
      const [rawTranscript, rawSummary] = await Promise.all([
        requestResult(tx.objectStore(TRANSCRIPTS).get(id)),
        requestResult(tx.objectStore(SUMMARIES).get(id)),
      ]);
      const transcript = normalizeTranscript(rawTranscript);
      if (!transcript) return null;
      return { transcript, summary: normalizeSummary(rawSummary) ?? summarizeTranscript(transcript, 'complete', 0) };
    },

    async put(transcript, status) {
      const summary = summarizeTranscript(transcript, status, Date.now());
      await write((summaries, transcripts) => {
        transcripts.put(transcript);
        summaries.put(summary);
      });
      return summary;
    },

    async rename(id, title) {
      const db = await open();
      const tx = db.transaction([SUMMARIES, TRANSCRIPTS], 'readwrite');
      const done = transactionDone(tx);
      const summaries = tx.objectStore(SUMMARIES);
      const transcripts = tx.objectStore(TRANSCRIPTS);
      const [rawTranscript, rawSummary] = await Promise.all([requestResult(transcripts.get(id)), requestResult(summaries.get(id))]);
      const transcript = normalizeTranscript(rawTranscript);
      const summary = normalizeSummary(rawSummary);
      if (!transcript || !summary) {
        tx.abort();
        await done.catch(() => undefined);
        return null;
      }
      const updatedAt = new Date().toISOString();
      const nextSummary: TranscriptSummary = { ...summary, title, updatedAt };
      transcripts.put({ ...transcript, title, updatedAt });
      summaries.put(nextSummary);
      await done;
      return nextSummary;
    },

    async delete(id) {
      await write((summaries, transcripts) => {
        summaries.delete(id);
        transcripts.delete(id);
      });
    },
  };
}

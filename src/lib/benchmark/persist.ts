/**
 * localStorage persistence for settings and run history. Every access is wrapped: storage can be
 * disabled by policy (managed browsers), full, or throw in private modes. Failures come back as
 * messages for the UI instead of being swallowed.
 */
import type { BenchmarkRecord } from '../types';
import { errorMessage } from './errors';
import { defaultSettings, sanitizeSettings, type AppSettings } from './settings';

const SETTINGS_KEY = 'speech-poc:settings:v1';
const HISTORY_KEY = 'speech-poc:history:v1';
export const HISTORY_LIMIT = 50;

function read(key: string): { value: unknown; error: string | null } {
  try {
    const raw = window.localStorage.getItem(key);
    return { value: raw == null ? null : JSON.parse(raw), error: null };
  } catch (e) {
    return { value: null, error: errorMessage(e) };
  }
}

function write(key: string, value: unknown): string | null {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return null;
  } catch (e) {
    return errorMessage(e);
  }
}

export function readSettings(): { settings: AppSettings; error: string | null } {
  const { value, error } = read(SETTINGS_KEY);
  const settings = value == null ? defaultSettings() : sanitizeSettings(value);
  // A build-time mirror (NEXT_PUBLIC_MODEL_BASE_URL) fills in when no mirror URL was ever saved.
  if (!settings.mirrorBaseUrl.trim()) settings.mirrorBaseUrl = defaultSettings().mirrorBaseUrl;
  return { settings, error: error && `Saved settings could not be read: ${error}` };
}

export function writeSettings(settings: AppSettings): string | null {
  const error = write(SETTINGS_KEY, settings);
  return error && `Settings could not be saved: ${error}`;
}

function isBenchmarkRecord(v: unknown): v is BenchmarkRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<BenchmarkRecord>;
  return r.schemaVersion === 1 && typeof r.id === 'string' && typeof r.createdAt === 'string';
}

/** Newest first. */
export function readHistory(): { history: BenchmarkRecord[]; error: string | null } {
  const { value, error } = read(HISTORY_KEY);
  return {
    history: Array.isArray(value) ? value.filter(isBenchmarkRecord).slice(0, HISTORY_LIMIT) : [],
    error: error && `Run history could not be read: ${error}`,
  };
}

/** Saves newest-first history. When storage is full, keeps as many of the newest runs as fit and says so. */
export function writeHistory(history: BenchmarkRecord[]): string | null {
  const error = write(HISTORY_KEY, history);
  if (!error) return null;
  for (let count = Math.floor(history.length / 2); count >= 1; count = Math.floor(count / 2)) {
    if (!write(HISTORY_KEY, history.slice(0, count))) {
      return `Storage is full: only the newest ${count} of ${history.length} runs were saved (${error}).`;
    }
  }
  return `Run history could not be saved: ${error}`;
}

export function removeHistory(): string | null {
  try {
    window.localStorage.removeItem(HISTORY_KEY);
    return null;
  } catch (e) {
    return `Run history could not be cleared: ${errorMessage(e)}`;
  }
}

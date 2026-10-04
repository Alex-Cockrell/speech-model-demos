/**
 * Echo duplicates. OWNER: meeting agent.
 *
 * With the call playing through the laptop's speakers, the microphone hears the remote voices too, so the
 * microphone transcript repeats what the call audio already has. A microphone line is an echo when it overlaps
 * call lines in time and most of its words appear, in order, in what the call audio said around it.
 */
import { normalizeText, toWords } from '../accuracy/wer';
import type { TranscriptWord } from '../types';

export interface EchoCandidate {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  words: readonly TranscriptWord[] | null;
}

export interface EchoOptions {
  /** Slack around the microphone line: speaker-to-microphone delay, capture latency, segment boundaries. */
  toleranceMs: number;
  /** Share of the microphone line's words that must appear, in order, in the overlapping call text. */
  minRatio: number;
}

export const DEFAULT_ECHO_OPTIONS: EchoOptions = { toleranceMs: 1000, minRatio: 0.6 };

export interface EchoMatch {
  /** The overlapping call line with the most time in common with the microphone line. */
  echoOf: string;
  /** matchedWords / micWords */
  ratio: number;
  matchedWords: number;
  micWords: number;
}

export function normalizedWords(text: string): string[] {
  return toWords(normalizeText(text));
}

/** Do the two time ranges overlap once each is widened by toleranceMs? */
export function overlapsWithin(
  a: { startMs: number; endMs: number },
  b: { startMs: number; endMs: number },
  toleranceMs: number,
): boolean {
  return a.startMs <= b.endMs + toleranceMs && b.startMs <= a.endMs + toleranceMs;
}

/** Length of the longest common subsequence of two word lists. */
export function lcsLength(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let previous = new Uint16Array(b.length + 1);
  let current = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

/**
 * The call words that could have reached the microphone during `mic`: with word timings, only the words inside
 * the microphone line's window (± tolerance), so a short "yeah" is not matched against a long call line; without
 * usable word timings, the whole call line.
 */
function callWordsAround(call: EchoCandidate, mic: EchoCandidate, toleranceMs: number): string[] {
  const all = normalizedWords(call.text);
  if (!call.words || call.words.length === 0) return all;
  // Word timings are only used when they spell out the same words as the text (not sub-word pieces, not stale after an edit).
  const fromWords = call.words.flatMap((w) => normalizedWords(w.text));
  if (fromWords.join(' ') !== all.join(' ')) return all;
  return call.words
    .filter((w) => w.endMs >= mic.startMs - toleranceMs && w.startMs <= mic.endMs + toleranceMs)
    .flatMap((w) => normalizedWords(w.text));
}

/**
 * Is the microphone line `mic` an echo of the call lines in `call`? Returns the match, or null. `call` may hold
 * any call lines; only those overlapping `mic` (± tolerance) count.
 */
export function detectEcho(mic: EchoCandidate, call: readonly EchoCandidate[], options?: Partial<EchoOptions>): EchoMatch | null {
  const { toleranceMs, minRatio } = { ...DEFAULT_ECHO_OPTIONS, ...options };
  const micWords = normalizedWords(mic.text);
  if (micWords.length === 0) return null;
  const overlapping = call.filter((c) => overlapsWithin(mic, c, toleranceMs)).sort((a, b) => a.startMs - b.startMs);
  if (overlapping.length === 0) return null;
  const callWords = overlapping.flatMap((c) => callWordsAround(c, mic, toleranceMs));
  const matchedWords = lcsLength(micWords, callWords);
  const ratio = matchedWords / micWords.length;
  if (matchedWords === 0 || ratio < minRatio) return null;
  let best = overlapping[0];
  let bestOverlap = -Infinity;
  for (const c of overlapping) {
    const overlap = Math.min(mic.endMs, c.endMs) - Math.max(mic.startMs, c.startMs);
    if (overlap > bestOverlap) {
      best = c;
      bestOverlap = overlap;
    }
  }
  return { echoOf: best.id, ratio, matchedWords, micWords: micWords.length };
}

/** A segment that may still be open: endMs null = still being spoken. */
export interface LiveCandidate {
  id: string;
  startMs: number;
  endMs: number | null;
  text: string;
}

/**
 * Live text: does a microphone segment that is still being spoken already repeat the call text around it? Used to
 * keep echo duplicates out of the live view before their final text decides it. Open segments count as still going.
 */
export function isLiveEcho(mic: LiveCandidate, call: readonly LiveCandidate[], options?: Partial<EchoOptions>): boolean {
  const open = (c: LiveCandidate): EchoCandidate => ({ ...c, endMs: c.endMs ?? Number.MAX_SAFE_INTEGER, words: null });
  return detectEcho(open(mic), call.map(open), options) !== null;
}

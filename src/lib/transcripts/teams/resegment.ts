/**
 * Turning per-word speakers into lines. OWNER: meeting agent.
 *
 * Within one of our segments every word has a speaker (from the Teams word it aligned to, or inferred). Tiny
 * runs of another speaker inside a run are usually alignment noise and are smoothed away, unless they matched
 * a short Teams turn of their own ("yeah", "right"): a genuine interjection. Split points move to a nearby
 * sentence end when the words in between are only weakly attributed. Each remaining run becomes a line.
 */
import { tokenize } from './tokens';

/** No evidence for any speaker. */
export const NO_SPEAKER = -2;
/** A Teams line without a name. */
export const UNNAMED_SPEAKER = -1;

/** How a word got its speaker. */
export const STRENGTH_NONE = 0;
export const STRENGTH_INFERRED = 1;
export const STRENGTH_ALIGNED = 2;
export const STRENGTH_MATCHED = 3;

export interface WordLabel {
  /** Teams speaker index, UNNAMED_SPEAKER or NO_SPEAKER. */
  speaker: number;
  strength: number;
  /** Matched to a short Teams turn of this same speaker (a genuine interjection). */
  interjection: boolean;
  startMs: number;
  endMs: number;
  text: string;
}

export const SMOOTH_MAX_WORDS = 2;
export const SMOOTH_MAX_MS = 1500;

export interface Run {
  start: number;
  /** exclusive */
  end: number;
  speaker: number;
}

export function speakerRuns(speakers: readonly number[]): Run[] {
  const runs: Run[] = [];
  for (let k = 0; k < speakers.length; k++) {
    const last = runs[runs.length - 1];
    if (last && last.speaker === speakers[k]) last.end = k + 1;
    else runs.push({ start: k, end: k + 1, speaker: speakers[k] });
  }
  return runs;
}

/**
 * Removes noise: a run of at most two words (≤ 1.5 s) between two runs of the same other speaker takes their
 * speaker; a single weakly attributed word at either end of the segment takes its neighbour's. Interjections
 * that Teams has as their own turn stay. Words without evidence take the neighbouring speaker.
 */
export function smoothSpeakers(labels: readonly WordLabel[]): number[] {
  const speakers = labels.map((l) => l.speaker);
  // No evidence: the previous word's speaker, else the next one's.
  for (let k = 0; k < speakers.length; k++) if (speakers[k] === NO_SPEAKER && k > 0) speakers[k] = speakers[k - 1];
  for (let k = speakers.length - 2; k >= 0; k--) if (speakers[k] === NO_SPEAKER) speakers[k] = speakers[k + 1];

  for (let pass = 0; pass < 3; pass++) {
    const runs = speakerRuns(speakers);
    let changed = false;
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r];
      const words = run.end - run.start;
      const duration = labels[run.end - 1].endMs - labels[run.start].startMs;
      if (words > SMOOTH_MAX_WORDS || duration > SMOOTH_MAX_MS) continue;
      let genuine = true;
      let strong = false;
      for (let k = run.start; k < run.end; k++) {
        if (labels[k].speaker !== run.speaker || labels[k].strength < STRENGTH_MATCHED || !labels[k].interjection) genuine = false;
        if (labels[k].strength >= STRENGTH_MATCHED && labels[k].speaker === run.speaker) strong = true;
      }
      if (genuine) continue;
      const before = runs[r - 1]?.speaker;
      const after = runs[r + 1]?.speaker;
      let target: number | undefined;
      if (before !== undefined && before === after) target = before;
      else if ((before === undefined) !== (after === undefined) && words === 1 && !strong) target = before ?? after;
      if (target === undefined || target === run.speaker) continue;
      for (let k = run.start; k < run.end; k++) speakers[k] = target;
      changed = true;
    }
    if (!changed) break;
  }
  return speakers;
}

const SENTENCE_END = /[.?!…]["'”’)\]]*$/;
const CLAUSE_END = /[,;:]["'”’)\]]*$/;

/**
 * Moves each speaker change to a sentence end (or failing that a comma) at most two words away, when the
 * words that change speaker are only weakly attributed (not matched word for word).
 */
export function snapToPunctuation(labels: readonly WordLabel[], speakers: readonly number[]): number[] {
  const out = [...speakers];
  const weak = (k: number) => labels[k].strength < STRENGTH_MATCHED;
  const tryMove = (k: number, pattern: RegExp, maxDistance: number): boolean => {
    const left = out[k - 1];
    const right = out[k];
    for (let d = 1; d <= maxDistance; d++) {
      // Earlier: words [k − d, k) go to the right-hand speaker.
      const early = k - d;
      if (early >= 1 && pattern.test(labels[early - 1].text)) {
        let ok = true;
        for (let q = early; q < k; q++) if (out[q] !== left || !weak(q)) ok = false;
        if (ok) {
          for (let q = early; q < k; q++) out[q] = right;
          return true;
        }
      }
      // Later: words [k, k + d) go to the left-hand speaker.
      const late = k + d;
      if (late < out.length && pattern.test(labels[late - 1].text)) {
        let ok = true;
        for (let q = k; q < late; q++) if (out[q] !== right || !weak(q)) ok = false;
        if (ok) {
          for (let q = k; q < late; q++) out[q] = left;
          return true;
        }
      }
    }
    return false;
  };
  for (let k = 1; k < out.length; k++) {
    if (out[k] === out[k - 1] || SENTENCE_END.test(labels[k - 1].text)) continue;
    if (!tryMove(k, SENTENCE_END, 2) && !CLAUSE_END.test(labels[k - 1].text)) tryMove(k, CLAUSE_END, 1);
  }
  return out;
}

/**
 * Spreads a corrected line's text over the pieces its recognized words were split into: the corrected words are
 * aligned to the recognized ones (edit distance over normalized words) and follow them into their piece.
 * Returns null when too little of the correction lines up (a rewrite) or a piece would end up empty.
 */
export function splitCorrectedText(
  corrected: string,
  recognized: readonly string[],
  pieceOfWord: readonly number[],
  pieces: number,
): string[] | null {
  const correctedWords = corrected.split(/\s+/).filter(Boolean);
  const cTokens: { word: number; token: string }[] = [];
  correctedWords.forEach((w, word) => tokenize(w).forEach((token) => cTokens.push({ word, token })));
  const rTokens: { word: number; token: string }[] = [];
  recognized.forEach((w, word) => tokenize(w).forEach((token) => rTokens.push({ word, token })));
  const n = cTokens.length;
  const m = rTokens.length;
  if (n === 0 || m === 0) return null;
  // Edit-distance alignment with traceback.
  const cols = m + 1;
  const d = new Uint32Array((n + 1) * cols);
  for (let i = 0; i <= n; i++) d[i * cols] = i;
  for (let j = 0; j <= m; j++) d[j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = cTokens[i - 1].token === rTokens[j - 1].token ? 0 : 1;
      d[i * cols + j] = Math.min(d[(i - 1) * cols + j - 1] + same, d[(i - 1) * cols + j] + 1, d[i * cols + j - 1] + 1);
    }
  }
  const pieceOfCorrected = new Array<number>(correctedWords.length).fill(-1);
  let matched = 0;
  for (let i = n, j = m; i > 0 && j > 0; ) {
    const same = cTokens[i - 1].token === rTokens[j - 1].token ? 0 : 1;
    if (d[i * cols + j] === d[(i - 1) * cols + j - 1] + same) {
      if (same === 0) matched++;
      const cw = cTokens[i - 1].word;
      if (pieceOfCorrected[cw] < 0) pieceOfCorrected[cw] = pieceOfWord[rTokens[j - 1].word];
      i--;
      j--;
    } else if (d[i * cols + j] === d[(i - 1) * cols + j] + 1) {
      i--;
    } else {
      j--;
    }
  }
  if (matched < Math.max(n, m) * 0.5) return null;
  // Corrected words with no counterpart go with the word before them (or after, at the start).
  for (let k = 0; k < pieceOfCorrected.length; k++) if (pieceOfCorrected[k] < 0 && k > 0) pieceOfCorrected[k] = pieceOfCorrected[k - 1];
  for (let k = pieceOfCorrected.length - 2; k >= 0; k--) if (pieceOfCorrected[k] < 0) pieceOfCorrected[k] = pieceOfCorrected[k + 1];
  // Pieces must stay in order (a correction that moved words across a split cannot be spread).
  for (let k = 1; k < pieceOfCorrected.length; k++) if (pieceOfCorrected[k] < pieceOfCorrected[k - 1]) return null;
  const texts = Array.from({ length: pieces }, () => [] as string[]);
  correctedWords.forEach((w, k) => texts[Math.max(0, pieceOfCorrected[k])].push(w));
  if (texts.some((t) => t.length === 0)) return null;
  return texts.map((t) => t.join(' '));
}

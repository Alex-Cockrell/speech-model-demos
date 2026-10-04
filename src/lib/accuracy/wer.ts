/**
 * Word error rate for benchmark mode (spec §12). Capitalisation and punctuation are ignored; the raw
 * transcript is kept untouched elsewhere so the normalised comparison never hides what was heard.
 */
import type { AccuracyResult, BenchmarkPhrase, WerBreakdown } from '../types';

// Apostrophes are deleted rather than turned into spaces so contractions stay one word ("It's" → "its").
const APOSTROPHES = /['‘’ʼ`´]/g;
const PUNCTUATION_OR_SYMBOL = /[\p{P}\p{S}]+/gu;

/** Lowercase, drop apostrophes, treat every other punctuation mark or symbol as a word break, collapse whitespace. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(PUNCTUATION_OR_SYMBOL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function toWords(normalized: string): string[] {
  return normalized === '' ? [] : normalized.split(' ');
}

export type AlignmentOp =
  | { op: 'match'; ref: string; hyp: string }
  | { op: 'sub'; ref: string; hyp: string }
  | { op: 'del'; ref: string }
  | { op: 'ins'; hyp: string };

/** Minimum-edit word alignment: Levenshtein distance over words, then a backtrace. */
export function alignWords(ref: readonly string[], hyp: readonly string[]): AlignmentOp[] {
  const cols = hyp.length + 1;
  const d = new Uint32Array((ref.length + 1) * cols);
  for (let i = 0; i <= ref.length; i++) d[i * cols] = i;
  for (let j = 0; j <= hyp.length; j++) d[j] = j;
  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      const diagonal = d[(i - 1) * cols + j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      const deletion = d[(i - 1) * cols + j] + 1;
      const insertion = d[i * cols + j - 1] + 1;
      d[i * cols + j] = Math.min(diagonal, deletion, insertion);
    }
  }

  const ops: AlignmentOp[] = [];
  let i = ref.length;
  let j = hyp.length;
  while (i > 0 || j > 0) {
    const cost = d[i * cols + j];
    if (i > 0 && j > 0) {
      const same = ref[i - 1] === hyp[j - 1];
      if (cost === d[(i - 1) * cols + j - 1] + (same ? 0 : 1)) {
        ops.push(same ? { op: 'match', ref: ref[i - 1], hyp: hyp[j - 1] } : { op: 'sub', ref: ref[i - 1], hyp: hyp[j - 1] });
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && cost === d[(i - 1) * cols + j] + 1) {
      ops.push({ op: 'del', ref: ref[i - 1] });
      i--;
    } else {
      ops.push({ op: 'ins', hyp: hyp[j - 1] });
      j--;
    }
  }
  return ops.reverse();
}

/** WER = (S + D + I) / N over normalised words. */
export function computeWer(expected: string, hypothesis: string): WerBreakdown {
  const normalizedExpected = normalizeText(expected);
  const normalizedHypothesis = normalizeText(hypothesis);
  const ref = toWords(normalizedExpected);
  let substitutions = 0;
  let insertions = 0;
  let deletions = 0;
  for (const step of alignWords(ref, toWords(normalizedHypothesis))) {
    if (step.op === 'sub') substitutions++;
    else if (step.op === 'ins') insertions++;
    else if (step.op === 'del') deletions++;
  }
  const errors = substitutions + insertions + deletions;
  return {
    normalizedExpected,
    normalizedHypothesis,
    exactMatch: normalizedExpected === normalizedHypothesis,
    // WER is undefined for an empty reference; 0/1 keeps the record JSON-safe (Infinity serialises as null).
    wer: ref.length > 0 ? errors / ref.length : errors > 0 ? 1 : 0,
    substitutions,
    insertions,
    deletions,
    referenceWordCount: ref.length,
  };
}

/** Accuracy of the final text, plus the streaming text when a final pass changed it. */
export function assessAccuracy(phrase: BenchmarkPhrase, finalText: string, streamingText: string): AccuracyResult {
  const streaming =
    streamingText.trim() !== finalText.trim() ? { ...computeWer(phrase.text, streamingText), hypothesis: streamingText } : null;
  return {
    phraseId: phrase.id,
    expected: phrase.text,
    hypothesis: finalText,
    ...computeWer(phrase.text, finalText),
    streaming,
  };
}

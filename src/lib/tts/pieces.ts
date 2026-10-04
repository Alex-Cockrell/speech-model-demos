/**
 * Read-aloud planning: sentences (what the reader highlights and seeks to) and TTS pieces (what one Kokoro
 * inference synthesises). Pure, no kokoro-js: used on the main thread and by the TTS worker's overflow fallback.
 *
 * Kokoro's input limit. kokoro-js 1.2.1 phonemizes a piece with espeak-ng and tokenizes the phonemes one
 * character per token, adding `$` at both ends, with truncation at model_max_length = 512 (tokenizer_config.json
 * at the pinned revision). Phonemes past 510 characters are cut off silently: the end of the piece is never
 * spoken. Measured with kokoro-js's own preprocessing and phonemizer 1.2.1:
 *   plain English            ≈ 1.05–1.4 tokens per character
 *   numbers                  4–7 per character ("$1,234,567.89" → "one million two hundred thirty-four …")
 *   hex strings, version ids ≈ 4 per character (spelled out)
 *   all-caps acronyms        up to 3.75 per letter ("HTTP" → "aitch tee tee pee")
 *   symbols                  2–10 each ("*" → "asterisk", "=" → "equals")
 * Pieces are planned with a cost estimate (estimateTokens) against a budget well below 510, so overflow needs an
 * unusual piece; the worker still checks the real token count and splits a piece that would be truncated.
 *
 * Piece size is a latency trade-off: the first audio, and the first audio after every seek, waits for a whole
 * piece. The default budget of 220 estimated tokens is ≈ 175 characters of prose, ≈ 12 s of speech, so most
 * sentences stay whole (better prosody) and long ones split at clause boundaries. The first piece of the document
 * gets a smaller budget (if it has a clause boundary to split at) so playback starts sooner. 'clause' mode (the
 * shared TTS split setting) also splits at every , ; : — for earlier audio on slow machines.
 */
import type { DocBlock } from './document';

/** Kokoro's hard limit: phoneme tokens per inference including the two `$` markers (model_max_length). */
export const KOKORO_MAX_TOKENS = 512;
export const DEFAULT_PIECE_TOKENS = 220;
export const DEFAULT_LEAD_TOKENS = 110;
/** Clause mode merges fragments shorter than this with their neighbour ("However," is not a piece). */
const MIN_CLAUSE_CHARS = 30;

// ---------------------------------------------------------------------------
// Token estimate
// ---------------------------------------------------------------------------

const COST_DIGIT = 8;
const COST_SPELLED_LETTER = 3.8;
const COST_LETTER = 1.3;
const COST_OTHER_LETTER = 1.5;
const SYMBOL_COST: Record<string, number> = {
  '%': 7,
  '*': 10,
  '+': 5,
  '=': 7,
  '/': 5,
  '\\': 9,
  '&': 3,
  '#': 4,
  '@': 2,
  '^': 6,
  '~': 6,
  '<': 9,
  '>': 12,
  '|': 4,
  $: 7,
  '£': 6,
  '€': 5,
  '°': 7,
  '§': 7,
  '±': 13,
  '×': 6,
};

/** Per-character costs, so any range's estimate is a prefix-sum difference. */
function charCosts(text: string): Float64Array {
  const costs = new Float64Array(text.length);
  const words = /\S+/g;
  let m: RegExpExecArray | null;
  for (let i = 0; i < text.length; i++) costs[i] = 1; // whitespace and anything not overwritten below
  while ((m = words.exec(text)) !== null) {
    const word = m[0];
    const letters = word.replace(/[^A-Za-z]/g, '');
    // All-caps words and words mixing letters and digits are usually spelled out letter by letter.
    const spelled = (letters.length >= 2 && letters === letters.toUpperCase()) || (/\d/.test(word) && letters.length > 0);
    for (let k = 0; k < word.length; k++) {
      const ch = word[k];
      let cost: number;
      if (ch >= '0' && ch <= '9') cost = COST_DIGIT;
      else if (/[A-Za-z]/.test(ch)) cost = spelled ? COST_SPELLED_LETTER : COST_LETTER;
      else if (/\p{L}/u.test(ch)) cost = COST_OTHER_LETTER;
      else cost = SYMBOL_COST[ch] ?? 1;
      costs[m.index + k] = cost;
    }
  }
  return costs;
}

function prefixSums(costs: Float64Array): Float64Array {
  const sums = new Float64Array(costs.length + 1);
  for (let i = 0; i < costs.length; i++) sums[i + 1] = sums[i] + costs[i];
  return sums;
}

/** Estimated Kokoro tokens for `text` (phoneme characters + the two `$`). Errs high for numbers and symbols. */
export function estimateTokens(text: string): number {
  const costs = charCosts(text);
  let total = 2;
  for (const c of costs) total += c;
  return Math.ceil(total);
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

/** No sentence break after these when the next word is capitalised: "Dr. Smith". */
const TITLE_ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'mx',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'mt',
  'sgt',
  'col',
  'gen',
  'rep',
  'sen',
  'gov',
  'lt',
  'maj',
  'capt',
  'rev',
  'hon',
  'pres',
  'messrs',
]);
/** No sentence break after these when a number follows: "No. 5", "Fig. 3", "Jan. 12". */
const NUMBER_ABBREVIATIONS = new Set([
  'no',
  'nos',
  'fig',
  'figs',
  'vol',
  'vols',
  'p',
  'pp',
  'pg',
  'ch',
  'chap',
  'sec',
  'art',
  'eq',
  'ref',
  'approx',
  'ca',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
]);
/** Never a sentence break after these. */
const ALWAYS_ABBREVIATIONS = new Set(['vs', 'cf', 'al', 'approx', 'incl', 'esp', 'viz']);
const DOTTED_ABBREVIATION = /^(?:\p{L}\.){2,}$/u; // e.g. i.e. U.S. a.m.
const TERMINAL = /[.!?…]/;
const CLOSERS = /["'”’)\]}»]/;
const OPENERS = /^["'“‘(\[«]+/;

function isSentenceBreak(text: string, sentenceStart: number, punctStart: number, punctEnd: number, next: number): boolean {
  const nextChar = text[next];
  if (/\p{Ll}/u.test(nextChar)) return false; // "approx. five", "e.g. this", "Why? she asked"
  const punct = text.slice(punctStart, punctEnd + 1);
  if (!punct.startsWith('.') || punct.startsWith('..')) return true; // ? ! … and "..." before a capital
  let w = punctStart - 1;
  while (w >= sentenceStart && !/\s/.test(text[w])) w--;
  const word = text.slice(w + 1, punctStart).replace(OPENERS, '');
  const lower = word.toLowerCase();
  if (DOTTED_ABBREVIATION.test(`${word}.`)) return false;
  if (/^\p{Lu}$/u.test(word) && /\p{Lu}/u.test(nextChar)) return false; // initials: "J. R. R. Tolkien"
  if (ALWAYS_ABBREVIATIONS.has(lower)) return false;
  if (TITLE_ABBREVIATIONS.has(lower) && /\p{Lu}/u.test(nextChar)) return false;
  if (NUMBER_ABBREVIATIONS.has(lower) && /\d/.test(nextChar)) return false;
  return true;
}

/** Sentence ranges [start, end) of a single-line text, trimmed, in order, covering every non-space character. */
export function splitSentences(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const n = text.length;
  let start = 0;
  let i = 0;
  while (i < n) {
    if (!TERMINAL.test(text[i])) {
      i++;
      continue;
    }
    let end = i;
    while (end + 1 < n && TERMINAL.test(text[end + 1])) end++;
    while (end + 1 < n && CLOSERS.test(text[end + 1])) end++;
    const after = end + 1;
    if (after >= n) break;
    if (!/\s/.test(text[after])) {
      i = after; // "3.14", "Node.js", "a.m.,"
      continue;
    }
    let next = after;
    while (next < n && /\s/.test(text[next])) next++;
    if (next >= n) break;
    if (isSentenceBreak(text, start, i, end, next)) {
      pushTrimmed(text, ranges, start, after);
      start = next;
    }
    i = next;
  }
  pushTrimmed(text, ranges, start, n);
  return ranges;
}

function pushTrimmed(text: string, ranges: Array<[number, number]>, start: number, end: number): void {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (end > start) ranges.push([start, end]);
}

// ---------------------------------------------------------------------------
// Splitting a sentence into pieces
// ---------------------------------------------------------------------------

/** Where a piece may end: priority 3 = ; : — –, 2 = , ) or before (, 1 = before a conjunction, 0 = any space. */
interface Cut {
  /** Index where the next piece starts (after the whitespace). */
  at: number;
  /** End of the current piece (before the whitespace). */
  end: number;
  priority: number;
}

const PRIORITY_WEIGHT = [0, 0.25, 0.45, 0.6];
const CONJUNCTION = /^(and|but|or|nor|so|yet|because|which|who|whose|where|while|although|though|whereas|unless|until|since|if|when|then|that)\b/i;

function cutsIn(text: string, start: number, end: number): Cut[] {
  const cuts: Cut[] = [];
  for (let i = start + 1; i < end; i++) {
    if (!/\s/.test(text[i]) || /\s/.test(text[i - 1])) continue;
    let at = i;
    while (at < end && /\s/.test(text[at])) at++;
    if (at >= end) break;
    const before = text[i - 1];
    const following = text[at];
    let priority = 0;
    if (/[;:]/.test(before) || /[—–]/.test(before) || (/[—–-]/.test(following) && /\s/.test(text[at + 1] ?? ''))) priority = 3;
    else if (/[,)\]]/.test(before) || following === '(') priority = 2;
    else if (CONJUNCTION.test(text.slice(at, at + 10))) priority = 1;
    // "word — next": cut after the dash rather than before it.
    if (/[—–-]/.test(following) && /\s/.test(text[at + 1] ?? '')) {
      let dashEnd = at + 1;
      while (dashEnd < end && /\s/.test(text[dashEnd])) dashEnd++;
      if (dashEnd >= end) continue;
      cuts.push({ at: dashEnd, end: at + 1, priority });
      continue;
    }
    cuts.push({ at, end: i, priority });
  }
  return cuts;
}

/** Splits [start, end) so every part's estimate fits `max`, preferring clause boundaries and balanced parts. */
function fitBudget(text: string, sums: Float64Array, start: number, end: number, max: number): Array<[number, number]> {
  const est = (a: number, b: number) => 2 + sums[b] - sums[a];
  const total = est(start, end);
  if (total <= max) return [[start, end]];
  const parts = Math.ceil(total / max);
  const target = total / parts;
  let best: Cut | null = null;
  let bestScore = -Infinity;
  for (const cut of cutsIn(text, start, end)) {
    const left = est(start, cut.end);
    if (left > max) break;
    const right = est(cut.at, end);
    // Avoid slivers: a tiny first part, or a tiny tail when everything would fit in two parts.
    const sliver = left < max * 0.25 || (parts === 2 && right < max * 0.15);
    const score = PRIORITY_WEIGHT[cut.priority] - Math.abs(left - target) / max - (sliver ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = cut;
    }
  }
  if (!best) {
    // No space within the budget ("a,b,c,…" data, one enormous token): cut after the last punctuation that
    // fits, or where the budget runs out.
    let cut = start + 1;
    while (cut < end - 1 && est(start, cut + 1) <= max) cut++;
    for (let k = cut; k > start + (cut - start) / 2; k--) {
      if (/[,;:|/]/.test(text[k - 1])) {
        cut = k;
        break;
      }
    }
    return [[start, cut], ...fitBudget(text, sums, cut, end, max)];
  }
  return [...fitBudget(text, sums, start, best.end, max), ...fitBudget(text, sums, best.at, end, max)];
}

/** Clause mode: split at every , ; : — boundary, then merge fragments shorter than MIN_CLAUSE_CHARS. */
function clauseParts(text: string, start: number, end: number): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let from = start;
  for (const cut of cutsIn(text, start, end)) {
    if (cut.priority < 2) continue;
    parts.push([from, cut.end]);
    from = cut.at;
  }
  parts.push([from, end]);
  const merged: Array<[number, number]> = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (last && last[1] - last[0] < MIN_CLAUSE_CHARS) last[1] = part[1];
    else merged.push([part[0], part[1]]);
  }
  const tail = merged[merged.length - 1];
  if (merged.length > 1 && tail[1] - tail[0] < MIN_CLAUSE_CHARS) {
    merged.pop();
    merged[merged.length - 1][1] = tail[1];
  }
  return merged;
}

/** The rightmost clause boundary (priority ≥ 2) whose first part fits the lead budget; null when there is none. */
function leadCut(text: string, sums: Float64Array, start: number, end: number, lead: number): Cut | null {
  const est = (a: number, b: number) => 2 + sums[b] - sums[a];
  let chosen: Cut | null = null;
  for (const cut of cutsIn(text, start, end)) {
    if (est(start, cut.end) > lead) break;
    if (cut.priority >= 2 && cut.end - start >= 20) chosen = cut;
  }
  return chosen;
}

/**
 * Worker fallback when a piece turned out longer than Kokoro's window: two halves split near the middle,
 * preferring clause boundaries, then any space. Text without spaces ("a,b,c,…" data) is cut after the
 * punctuation nearest the middle, or at the middle itself: a glitch is better than silently losing the rest.
 * null only for text too short to split.
 */
export function splitInHalf(text: string): [string, string] | null {
  const trimmed = text.trim();
  if (trimmed.length < 2) return null;
  const cuts = cutsIn(trimmed, 0, trimmed.length);
  const mid = trimmed.length / 2;
  if (cuts.length === 0) {
    let at = Math.floor(mid);
    let bestDistance = Infinity;
    for (let i = 1; i < trimmed.length; i++) {
      if (/[,;:|/]/.test(trimmed[i - 1]) && Math.abs(i - mid) < bestDistance) {
        bestDistance = Math.abs(i - mid);
        at = i;
      }
    }
    return [trimmed.slice(0, at), trimmed.slice(at)];
  }
  let best = cuts[0];
  let bestScore = -Infinity;
  for (const cut of cuts) {
    const score = PRIORITY_WEIGHT[cut.priority] - Math.abs(cut.end - mid) / trimmed.length;
    if (score > bestScore) {
      bestScore = score;
      best = cut;
    }
  }
  return [trimmed.slice(0, best.end).trim(), trimmed.slice(best.at).trim()];
}

// ---------------------------------------------------------------------------
// Spoken text
// ---------------------------------------------------------------------------

const UNIT_WORDS: Record<string, [string, string]> = {
  ms: ['millisecond', 'milliseconds'],
  s: ['second', 'seconds'],
  sec: ['second', 'seconds'],
  min: ['minute', 'minutes'],
  h: ['hour', 'hours'],
  hr: ['hour', 'hours'],
  hrs: ['hour', 'hours'],
  kB: ['kilobyte', 'kilobytes'],
  KB: ['kilobyte', 'kilobytes'],
  MB: ['megabyte', 'megabytes'],
  GB: ['gigabyte', 'gigabytes'],
  TB: ['terabyte', 'terabytes'],
  KiB: ['kibibyte', 'kibibytes'],
  MiB: ['mebibyte', 'mebibytes'],
  GiB: ['gibibyte', 'gibibytes'],
  TiB: ['tebibyte', 'tebibytes'],
  Hz: ['hertz', 'hertz'],
  kHz: ['kilohertz', 'kilohertz'],
  MHz: ['megahertz', 'megahertz'],
  GHz: ['gigahertz', 'gigahertz'],
  px: ['pixel', 'pixels'],
};

/**
 * Replacements applied to the text sent to Kokoro (the reader keeps showing the original). Each fixes something
 * kokoro-js 1.2.1 + espeak-ng read badly, checked against their phoneme output: "e.g." → "E G", "~5" → "tilde
 * five", "->" → nothing, "=>" → "equals", "vs." → "V S", "github.com" → "githubcom", "10 ms" → "ten M S".
 */
const SPEECH_REPLACEMENTS: Array<[RegExp, string | ((...groups: string[]) => string)]> = [
  [/\be\.g\.(?=[\s,;:)]|$)/gi, 'for example'],
  [/\bi\.e\.(?=[\s,;:)]|$)/gi, 'that is'],
  [/\bvs\.(?=\s)|(?<=\s)vs(?=\s)/g, 'versus'],
  [/\bapprox\.(?=\s)/gi, 'approximately'],
  [/\band\/or\b/gi, 'and or'],
  [/[~≈]\s?(?=[$£€]?\d)/g, 'about '],
  [/\s*(?:→|->|=>|⟶|⇒)\s*/g, ' to '],
  [/(\d)\s*[–—]\s*(?=[$£€]?\d)/g, '$1 to '],
  [/(?<=\p{L}{2})\.(?=\p{L}{2})/gu, ' dot '],
  [
    /(\d+(?:[.,]\d+)?)(?:\s(s|h)|\s?(ms|sec|min|hrs?|kB|KB|MB|GB|TB|KiB|MiB|GiB|TiB|Hz|kHz|MHz|GHz|px))\b/g,
    (_match: string, value: string, short: string | undefined, long: string | undefined) => {
      const unit = UNIT_WORDS[(short ?? long) as string];
      return unit ? `${value} ${value === '1' ? unit[0] : unit[1]}` : _match;
    },
  ],
];

const CLOSING_PUNCTUATION = /[.!?…:;]["'”’)\]]*$/;

/**
 * The text Kokoro receives for a piece: speech replacements, an ordered-list number ("3, …") and a final period
 * when the piece ends a block without punctuation (headings, list items, table rows), so it gets sentence-final
 * intonation instead of running on.
 */
export function spokenText(display: string, opts: { endsBlock: boolean; ordinal?: number | null } = { endsBlock: false }): string {
  let text = display.trim();
  for (const [pattern, replacement] of SPEECH_REPLACEMENTS) {
    text = typeof replacement === 'string' ? text.replace(pattern, replacement) : text.replace(pattern, replacement as (...a: string[]) => string);
  }
  text = text.replace(/\s{2,}/g, ' ').trim();
  if (opts.ordinal != null) text = `${opts.ordinal}, ${text}`;
  if (opts.endsBlock && !CLOSING_PUNCTUATION.test(text)) text = `${text.replace(/[,\s]+$/, '')}.`;
  return text;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type SplitMode = 'sentence' | 'clause';

export interface PlanOptions {
  split: SplitMode;
  /** Estimated-token budget per piece (default DEFAULT_PIECE_TOKENS). Must stay well below KOKORO_MAX_TOKENS. */
  maxTokens?: number;
  /** Budget for the first piece of the document when it has a clause boundary to split at (default DEFAULT_LEAD_TOKENS). */
  leadTokens?: number;
}

export interface PlannedSentence {
  index: number;
  block: number;
  /** Range in the block's text. */
  start: number;
  end: number;
  firstPiece: number;
  pieceCount: number;
}

export interface PlannedPiece {
  index: number;
  block: number;
  sentence: number;
  /** Range in the block's text (what the reader highlights). */
  start: number;
  end: number;
  /** What Kokoro receives (see spokenText). */
  text: string;
  /** Range of the original input this piece was read from. */
  sourceStart: number;
  sourceEnd: number;
  /** Displayed characters, for progress and time estimates. */
  chars: number;
  estTokens: number;
}

export interface ReadingPlan {
  blocks: readonly DocBlock[];
  sentences: PlannedSentence[];
  pieces: PlannedPiece[];
  /** Sentence indices per block. */
  blockSentences: number[][];
  totalChars: number;
  split: SplitMode;
}

function sourceRange(block: DocBlock, start: number, end: number): [number, number] {
  if (block.kind === 'code') return [block.sourceStart, block.sourceEnd];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = start; i < end; i++) {
    const o = block.offsets[i];
    if (o < lo) lo = o;
    if (o > hi) hi = o;
  }
  return lo === Infinity ? [block.sourceStart, block.sourceStart] : [lo, hi + 1];
}

export function planReading(blocks: readonly DocBlock[], options: PlanOptions): ReadingPlan {
  const maxTokens = Math.min(options.maxTokens ?? DEFAULT_PIECE_TOKENS, KOKORO_MAX_TOKENS - 100);
  const leadTokens = options.leadTokens ?? DEFAULT_LEAD_TOKENS;
  const sentences: PlannedSentence[] = [];
  const pieces: PlannedPiece[] = [];
  const blockSentences: number[][] = [];
  let totalChars = 0;

  blocks.forEach((block, b) => {
    const text = block.text;
    const sums = prefixSums(charCosts(text));
    const ranges = splitSentences(text);
    blockSentences.push([]);
    ranges.forEach(([start, end], r) => {
      let parts = options.split === 'clause' ? clauseParts(text, start, end) : [[start, end] as [number, number]];
      parts = parts.flatMap(([a, z]) => fitBudget(text, sums, a, z, maxTokens));
      if (pieces.length === 0 && parts.length > 0) {
        const [a, z] = parts[0];
        if (2 + sums[z] - sums[a] > leadTokens) {
          const cut = leadCut(text, sums, a, z, leadTokens);
          if (cut) parts = [[a, cut.end], [cut.at, z], ...parts.slice(1)];
        }
      }
      const sentence: PlannedSentence = { index: sentences.length, block: b, start, end, firstPiece: pieces.length, pieceCount: parts.length };
      sentences.push(sentence);
      blockSentences[b].push(sentence.index);
      parts.forEach(([a, z], p) => {
        const endsBlock = r === ranges.length - 1 && p === parts.length - 1;
        const spoken = spokenText(text.slice(a, z), { endsBlock, ordinal: r === 0 && p === 0 ? block.ordinal : null });
        const [sourceStart, sourceEnd] = sourceRange(block, a, z);
        pieces.push({
          index: pieces.length,
          block: b,
          sentence: sentence.index,
          start: a,
          end: z,
          text: spoken,
          sourceStart,
          sourceEnd,
          chars: z - a,
          estTokens: estimateTokens(spoken),
        });
        totalChars += z - a;
      });
    });
  });

  return { blocks, sentences, pieces, blockSentences, totalChars, split: options.split };
}

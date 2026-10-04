/**
 * Word alignment between our transcript and Teams'. OWNER: meeting agent.
 *
 * Global alignment by dynamic programming (match / skip ours / skip Teams), restricted to a band: a token of
 * ours can only pair with Teams tokens whose time, mapped onto our timeline, is within ±windowMs of it. With
 * ~3 words per second each, a ±20 s band holds ~120 Teams tokens per row, so a two-hour meeting (20k × 20k
 * words) costs a few million cells instead of 400 million. Leading and trailing Teams words are free to skip
 * (the transcripts need not start or end together).
 *
 * Scores: exact match +2; near match (edit similarity ≥ fuzzyMin, e.g. "timeouts"/"timeout") 2·sim − 0.4;
 * another word at the same place −0.9 (Teams' wrong words still align by position); a skipped word −0.5;
 * minus a time penalty: a little within slackMs (it picks the right one of several "yeah"s), then steeply more,
 * so that pairing words ~10 s apart no longer beats leaving both unpaired (common words like "the" are
 * everywhere, and the anchor-mapped times are accurate to a few seconds).
 *
 * The DP runs as a generator yielding progress every few hundred rows, so a caller can give the page a breath.
 */

export const PAIR_NONE = 0;
export const PAIR_EXACT = 1;
export const PAIR_FUZZY = 2;
export const PAIR_SUB = 3;
export type PairKind = typeof PAIR_NONE | typeof PAIR_EXACT | typeof PAIR_FUZZY | typeof PAIR_SUB;

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** 1 − edit distance / longer length: 1 for equal words, 0.875 for "timeouts"/"timeout". */
export function wordSimilarity(a: string, b: string): number {
  const longer = Math.max(a.length, b.length);
  return longer === 0 ? 1 : 1 - levenshtein(a, b) / longer;
}

/** Similarity of interned tokens, cached; pairs that cannot reach `floor` are not computed. */
export function createSimilarity(words: readonly string[], floor: number): (x: number, y: number) => number {
  const cache = new Map<number, number>();
  const n = Math.max(1, words.length);
  return (x, y) => {
    if (x === y) return 1;
    const a = words[x];
    const b = words[y];
    const longer = Math.max(a.length, b.length);
    // Short words differ too much in one letter ("in"/"on"); a big length difference cannot reach the floor.
    if (longer <= 2 || Math.abs(a.length - b.length) > longer * (1 - floor)) return 0;
    const key = x < y ? x * n + y : y * n + x;
    let s = cache.get(key);
    if (s === undefined) {
      s = wordSimilarity(a, b);
      cache.set(key, s);
    }
    return s;
  };
}

export interface BandedAlignOptions {
  windowMs: number;
  exactScore: number;
  /** Similarity from which two different words count as the same word misheard. */
  fuzzyMin: number;
  /** Score for pairing two different words; null forbids it (only matches are wanted). */
  mismatchScore: number | null;
  /** Leaving one of our words / one Teams word unpaired. */
  gapOurs: number;
  gapTeams: number;
  /** Time difference that is normal (rough Teams word times): costs at most timeWeight. */
  slackMs: number;
  timeWeight: number;
  /** Beyond slackMs, each further second costs this much. */
  farPerSecond: number;
}

/** Score taken off a pair whose times differ by dt ms. */
export function timePenalty(dt: number, options: Pick<BandedAlignOptions, 'slackMs' | 'timeWeight' | 'farPerSecond'>): number {
  return dt <= options.slackMs
    ? (options.timeWeight * dt) / options.slackMs
    : options.timeWeight + (options.farPerSecond * (dt - options.slackMs)) / 1000;
}

export const PASS1_OPTIONS: BandedAlignOptions = {
  windowMs: 20_000,
  exactScore: 2,
  fuzzyMin: 0.6,
  mismatchScore: -0.9,
  gapOurs: -0.5,
  gapTeams: -0.5,
  slackMs: 4000,
  timeWeight: 0.3,
  farPerSecond: 0.45,
};

export interface Alignment {
  /** Teams token paired with each of our tokens, or -1. */
  oursPartner: Int32Array;
  /** PAIR_* of each of our tokens. */
  oursKind: Uint8Array;
  /** Our token paired with each Teams token, or -1. */
  teamsPartner: Int32Array;
  /** DP cells evaluated. */
  cells: number;
}

const FROM_DIAG = 0;
const FROM_UP = 1;
const FROM_LEFT = 2;
const FROM_START = 3;

/**
 * Banded alignment of `ours` (times oursMs, non-decreasing) with `teams` (times teamsMs on our timeline,
 * non-decreasing). Yields the fraction of rows done; returns the alignment.
 */
export function* alignBandedSteps(
  ours: ArrayLike<number>,
  oursMs: ArrayLike<number>,
  teams: ArrayLike<number>,
  teamsMs: ArrayLike<number>,
  similarity: (x: number, y: number) => number,
  options: BandedAlignOptions,
): Generator<number, Alignment, void> {
  const N = ours.length;
  const M = teams.length;
  const W = options.windowMs;
  const oursPartner = new Int32Array(N).fill(-1);
  const oursKind = new Uint8Array(N);
  const teamsPartner = new Int32Array(M).fill(-1);
  if (N === 0 || M === 0) return { oursPartner, oursKind, teamsPartner, cells: 0 };

  // Window of Teams tokens per token of ours: [winLo, winHi] (empty when winHi < winLo).
  const winLo = new Int32Array(N);
  const winHi = new Int32Array(N);
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < N; i++) {
    while (lo < M && teamsMs[lo] < oursMs[i] - W) lo++;
    if (hi < lo - 1) hi = lo - 1;
    while (hi + 1 < M && teamsMs[hi + 1] <= oursMs[i] + W) hi++;
    winLo[i] = lo;
    winHi[i] = hi;
  }

  // Band of DP columns per row (column c = Teams tokens consumed). Row r > 0 is our token r − 1. Rows overlap
  // their predecessor (bandLo[r] ≤ bandHi[r − 1]), so every cell is reachable.
  const bandLo = new Int32Array(N + 1);
  const bandHi = new Int32Array(N + 1);
  const rowStart = new Float64Array(N + 2); // offsets into the flat backpointer array (can exceed 2^31 in theory)
  bandLo[0] = winLo[0];
  bandHi[0] = Math.max(winLo[0], winHi[0] + 1);
  for (let r = 1; r <= N; r++) {
    bandLo[r] = Math.min(winLo[r - 1], bandHi[r - 1]);
    bandHi[r] = Math.max(winHi[r - 1] + 1, bandHi[r - 1], bandLo[r]);
  }
  let maxWidth = 0;
  for (let r = 0; r <= N; r++) {
    const width = bandHi[r] - bandLo[r] + 1;
    rowStart[r + 1] = rowStart[r] + width;
    maxWidth = Math.max(maxWidth, width);
  }
  const cells = rowStart[N + 1];
  const back = new Uint8Array(cells);
  let prev = new Float64Array(maxWidth);
  let cur = new Float64Array(maxWidth);

  for (let c = bandLo[0]; c <= bandHi[0]; c++) {
    prev[c - bandLo[0]] = 0;
    back[c - bandLo[0]] = FROM_START;
  }
  const { exactScore, fuzzyMin, mismatchScore, gapOurs, gapTeams } = options;
  for (let r = 1; r <= N; r++) {
    const i = r - 1;
    const tok = ours[i];
    const t = oursMs[i];
    const pLo = bandLo[r - 1];
    const pHi = bandHi[r - 1];
    const cLo = bandLo[r];
    const cHi = bandHi[r];
    const wLo = winLo[i];
    const wHi = winHi[i];
    const base = rowStart[r];
    for (let c = cLo; c <= cHi; c++) {
      let best = -Infinity;
      let from = FROM_UP;
      const j = c - 1;
      if (j >= wLo && j <= wHi && j >= pLo && j <= pHi) {
        let score: number;
        const other = teams[j];
        if (other === tok) {
          score = exactScore;
        } else {
          const sim = similarity(tok, other);
          score = sim >= fuzzyMin ? exactScore * sim - 0.4 : (mismatchScore ?? -Infinity);
        }
        if (score > -Infinity) {
          best = prev[j - pLo] + score - timePenalty(Math.abs(t - teamsMs[j]), options);
          from = FROM_DIAG;
        }
      }
      if (c >= pLo && c <= pHi) {
        const v = prev[c - pLo] + gapOurs;
        if (v > best) {
          best = v;
          from = FROM_UP;
        }
      }
      if (c - 1 >= cLo) {
        const v = cur[c - 1 - cLo] + gapTeams;
        if (v > best) {
          best = v;
          from = FROM_LEFT;
        }
      }
      cur[c - cLo] = best;
      back[base + c - cLo] = from;
    }
    [prev, cur] = [cur, prev];
    if ((r & 511) === 0) yield r / N;
  }

  // Free trailing Teams words: the best cell of the last row.
  let c = bandLo[N];
  for (let k = bandLo[N] + 1; k <= bandHi[N]; k++) if (prev[k - bandLo[N]] > prev[c - bandLo[N]]) c = k;
  let r = N;
  while (r > 0) {
    const from = back[rowStart[r] + c - bandLo[r]];
    if (from === FROM_DIAG) {
      const i = r - 1;
      const j = c - 1;
      oursPartner[i] = j;
      teamsPartner[j] = i;
      const tok = ours[i];
      const other = teams[j];
      oursKind[i] = tok === other ? PAIR_EXACT : similarity(tok, other) >= fuzzyMin ? PAIR_FUZZY : PAIR_SUB;
      r--;
      c--;
    } else if (from === FROM_UP) {
      r--;
    } else if (from === FROM_LEFT) {
      c--;
    } else {
      break;
    }
  }
  return { oursPartner, oursKind, teamsPartner, cells };
}

/** Runs the alignment to completion (tests, small inputs). */
export function alignBanded(...args: Parameters<typeof alignBandedSteps>): Alignment {
  const steps = alignBandedSteps(...args);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

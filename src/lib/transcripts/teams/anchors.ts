/**
 * Clock offset between our recording and the Teams transcript. OWNER: meeting agent.
 *
 * Our session started at a different moment than Teams' transcript, so the same words have different times.
 * Anchors are word n-grams that occur exactly once in each transcript; for the right pairs, our time minus the
 * Teams time is (nearly) the same everywhere. The fit is a robust mode: the densest window of anchor offsets
 * (± tolerance), then a least-squares line through its inliers for clock drift (bounded to ±0.5 %). A few
 * further dense clusters are accepted too (a transcript whose times restart), and the anchors used are made
 * monotone in both transcripts (longest increasing chain). Teams token times are then mapped onto our timeline
 * by interpolating the anchors' offsets, which also corrects the rough word times inside long Teams turns.
 */

export interface AnchorPair {
  /** Token index in our sequence. */
  i: number;
  /** Token index in the Teams sequence. */
  j: number;
}

export interface Anchor extends AnchorPair {
  /** Our time − Teams time (ms). */
  offsetMs: number;
  teamsMs: number;
}

/**
 * Token n-grams that occur exactly once in `a` and once in `b`, as (start in a, start in b), sorted by i.
 * Ids must be small non-negative integers (interned tokens).
 */
export function findAnchors(a: ArrayLike<number>, b: ArrayLike<number>, n: number, vocabSize: number): AnchorPair[] {
  // A numeric key while it stays exact; strings otherwise.
  const numeric = Math.pow(Math.max(2, vocabSize), n) < Number.MAX_SAFE_INTEGER;
  const key = (s: ArrayLike<number>, p: number): number | string => {
    if (!numeric) return Array.prototype.slice.call(s, p, p + n).join(',');
    let k = 0;
    for (let q = 0; q < n; q++) k = k * vocabSize + s[p + q];
    return k;
  };
  const DUPLICATE = -1;
  const index = (s: ArrayLike<number>): Map<number | string, number> => {
    const m = new Map<number | string, number>();
    for (let p = 0; p + n <= s.length; p++) {
      const k = key(s, p);
      m.set(k, m.has(k) ? DUPLICATE : p);
    }
    return m;
  };
  const inB = index(b);
  const inA = index(a);
  const anchors: AnchorPair[] = [];
  for (const [k, i] of inA) {
    if (i === DUPLICATE) continue;
    const j = inB.get(k);
    if (j !== undefined && j !== DUPLICATE) anchors.push({ i, j });
  }
  return anchors.sort((x, y) => x.i - y.i);
}

interface Window {
  center: number;
  count: number;
}

/** The densest window of width 2·tol over sorted values; center = median of its members. */
function densestWindow(sorted: readonly number[], tol: number): Window | null {
  if (sorted.length === 0) return null;
  let best = { start: 0, end: 0 };
  let start = 0;
  for (let end = 0; end < sorted.length; end++) {
    while (sorted[end] - sorted[start] > 2 * tol) start++;
    if (end - start > best.end - best.start) best = { start, end };
  }
  const members = sorted.slice(best.start, best.end + 1);
  return { center: members[members.length >> 1], count: members.length };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface OffsetModel {
  /** Our time = Teams time + offsetMs + driftPerMs · Teams time. */
  offsetMs: number;
  driftPerMs: number;
}

export interface OffsetFit {
  model: OffsetModel;
  /** Anchors agreeing with the model (main cluster). */
  inliers: Anchor[];
  /** Anchors of further clusters (a transcript whose times restart). */
  extra: Anchor[];
  candidates: number;
}

/** Largest drift accepted: 0.5 % (18 s per hour); real clock and sample-rate drift is far below that. */
const MAX_DRIFT = 0.005;

function fitLine(anchors: readonly Anchor[]): OffsetModel {
  const n = anchors.length;
  const ts = anchors.map((a) => a.teamsMs);
  const span = Math.max(...ts) - Math.min(...ts);
  if (n >= 8 && span >= 10 * 60_000) {
    const mt = ts.reduce((s, t) => s + t, 0) / n;
    const mo = anchors.reduce((s, a) => s + a.offsetMs, 0) / n;
    let cov = 0;
    let varT = 0;
    for (const a of anchors) {
      cov += (a.teamsMs - mt) * (a.offsetMs - mo);
      varT += (a.teamsMs - mt) ** 2;
    }
    const d = Math.max(-MAX_DRIFT, Math.min(MAX_DRIFT, varT > 0 ? cov / varT : 0));
    return { offsetMs: median(anchors.map((a) => a.offsetMs - d * a.teamsMs)), driftPerMs: d };
  }
  return { offsetMs: median(anchors.map((a) => a.offsetMs)), driftPerMs: 0 };
}

export function predictOffset(model: OffsetModel, teamsMs: number): number {
  return model.offsetMs + model.driftPerMs * teamsMs;
}

/**
 * Robust offset (and drift) from anchors. tolMs: how far an anchor's offset may be from the model (rough Teams
 * word times inside long turns need several seconds). Returns null without anchors.
 */
export function fitOffset(anchors: readonly Anchor[], tolMs: number, minClusterSize: number): OffsetFit | null {
  const sorted = anchors.map((a) => a.offsetMs).sort((x, y) => x - y);
  const main = densestWindow(sorted, tolMs);
  if (!main) return null;
  let inliers = anchors.filter((a) => Math.abs(a.offsetMs - main.center) <= tolMs);
  let model = fitLine(inliers);
  for (let iteration = 0; iteration < 2; iteration++) {
    const next = anchors.filter((a) => Math.abs(a.offsetMs - predictOffset(model, a.teamsMs)) <= tolMs);
    if (next.length < inliers.length * 0.9) break;
    inliers = next;
    model = fitLine(inliers);
  }
  const used = new Set(inliers);
  const extra: Anchor[] = [];
  let rest = anchors.filter((a) => !used.has(a));
  for (let cluster = 0; cluster < 3 && rest.length > 0; cluster++) {
    const w = densestWindow(
      rest.map((a) => a.offsetMs).sort((x, y) => x - y),
      tolMs,
    );
    if (!w || w.count < Math.max(minClusterSize, inliers.length * 0.1)) break;
    const members = rest.filter((a) => Math.abs(a.offsetMs - w.center) <= tolMs);
    extra.push(...members);
    const taken = new Set(members);
    rest = rest.filter((a) => !taken.has(a));
  }
  return { model, inliers, extra, candidates: anchors.length };
}

/**
 * Longest chain of anchors increasing in both i and j (patience sorting). Every position starts at most one
 * n-gram, so i and j are each unique; sorted by i, this is the longest increasing subsequence of j.
 */
export function monotoneChain<T extends AnchorPair>(anchors: readonly T[]): T[] {
  const sorted = [...anchors].sort((x, y) => x.i - y.i || x.j - y.j);
  const tails: number[] = []; // index into sorted of the smallest tail j for each chain length
  const prev = new Int32Array(sorted.length).fill(-1);
  for (let k = 0; k < sorted.length; k++) {
    const j = sorted[k].j;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[tails[mid]].j < j) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const chain: T[] = [];
  for (let k = tails.length > 0 ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) chain.push(sorted[k]);
  return chain.reverse();
}

/**
 * Teams token times on our timeline. Between two chain anchors the offset is interpolated by token position;
 * before the first and after the last, the nearest anchor's offset holds. The result never decreases.
 */
export function mapTeamsTimes(teamsMs: ArrayLike<number>, chain: readonly Anchor[], fallback: OffsetModel): Float64Array {
  const out = new Float64Array(teamsMs.length);
  let k = 0;
  let max = -Infinity;
  for (let j = 0; j < teamsMs.length; j++) {
    let offset: number;
    if (chain.length === 0) {
      offset = predictOffset(fallback, teamsMs[j]);
    } else {
      while (k + 1 < chain.length && chain[k + 1].j <= j) k++;
      const a = chain[k];
      const b = chain[k + 1];
      if (j <= a.j || !b) offset = a.offsetMs;
      else offset = a.offsetMs + ((b.offsetMs - a.offsetMs) * (j - a.j)) / (b.j - a.j);
    }
    max = Math.max(max, teamsMs[j] + offset);
    out[j] = max;
  }
  return out;
}

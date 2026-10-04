/**
 * Speaker clustering for one meeting: online assignment as segments arrive, and offline re-clustering
 * (recluster) over everything seen so far. Pure TypeScript on L2-normalised embeddings, so the meeting
 * session and the Node tests run the same code. Sources ('mic', 'system') are clustered independently and
 * never share a speaker.
 *
 * Online, per source
 *   A segment joins the speaker whose centroid (normalised, speech-weighted mean of its segments' embeddings)
 *   is most similar, if that cosine similarity reaches the join threshold. The threshold is lower for short
 *   segments, whose embeddings are noisier: it rises linearly from `shortThreshold` at `minSpeechMs` to
 *   `threshold` at `fullSpeechMs`. A segment that matches nobody opens a new speaker only if it has at least
 *   `minNewSpeakerMs` of speech (a source's first speaker too); a shorter one gets no speaker for now
 *   (recluster() can still place it). Guards against speaker explosion: short segments never open speakers,
 *   speakers whose centroids drift within `mergeThreshold` of each other are merged (the newer into the older),
 *   and a known speaker count (given to recluster) caps the number of speakers.
 *
 * Offline (recluster), per source
 *   Average-linkage agglomerative clustering on cosine distance (nearest-neighbour chain, O(n²) time and
 *   memory, from similarities cached as segments arrive). Without a count, the dendrogram is cut where the
 *   average similarity between the closest clusters falls below `reclusterThreshold`, and clusters with less
 *   speech than max(`minClusterSpeechMs`, `minClusterFraction` of the source's speech) are folded into the most
 *   similar larger cluster. With a count k, it takes the coarsest cut that still has k clusters with real speech
 *   and folds the rest into them (cutting at exactly k clusters would keep noisy outliers as "speakers"). New
 *   clusters inherit the old speaker ids they share the most speech with (Hungarian assignment); the rest get
 *   new ids.
 *
 * Speaker ids are `${source}-${n}`, numbered per source in order of creation and never reused, so a name the
 * user gave a speaker cannot jump to a different voice.
 *
 * Defaults were tuned on three AMI meetings (close-talk and far-field, 4 speakers each, both ground-truth turns
 * and pause-based segments) and on synthetic two- and three-voice conversations; see the speakers report.
 */
import type { AudioSourceKind } from '../types';

export interface ClusteringOptions {
  /** Online join threshold (cosine similarity to a speaker's centroid) for segments with fullSpeechMs or more speech. */
  threshold: number;
  /** Join threshold for a segment with exactly minSpeechMs of speech; interpolated linearly up to fullSpeechMs. */
  shortThreshold: number;
  /** Segments with less speech get no embedding upstream; used here for the threshold ramp. */
  minSpeechMs: number;
  fullSpeechMs: number;
  /** A segment that matches nobody opens a new speaker only with at least this much speech. */
  minNewSpeakerMs: number;
  /** Online: two speakers of one source whose centroids are at least this similar are merged. */
  mergeThreshold: number;
  /** Offline: stop merging when the average similarity between the closest clusters falls below this. */
  reclusterThreshold: number;
  /**
   * Offline: clusters with less speech than this, or than minClusterFraction of the source's speech, are
   * folded into the most similar larger one.
   */
  minClusterSpeechMs: number;
  minClusterFraction: number;
  /** A segment's weight in centroids: its speech in seconds, capped at this. */
  maxWeightSec: number;
}

export const DEFAULT_CLUSTERING: ClusteringOptions = {
  threshold: 0.5,
  shortThreshold: 0.25,
  minSpeechMs: 1000,
  fullSpeechMs: 6000,
  minNewSpeakerMs: 3000,
  mergeThreshold: 0.7,
  reclusterThreshold: 0.4,
  minClusterSpeechMs: 10000,
  minClusterFraction: 0.02,
  maxWeightSec: 10,
};

export interface SegmentAssignment {
  segmentId: string;
  speakerId: string | null;
  confidence: number | null;
}

export interface ClusterSegmentInput {
  segmentId: string;
  source: AudioSourceKind;
  /** L2-normalised; null when the segment had too little speech to embed. */
  embedding: Float32Array | null;
  speechMs: number;
}

interface SegmentRecord extends ClusterSegmentInput {
  weight: number;
  speakerId: string | null;
  confidence: number | null;
}

interface Speaker {
  id: string;
  /** Sum of weight × embedding over the members. */
  sum: Float64Array;
  weight: number;
  members: SegmentRecord[];
}

interface SourceState {
  speakers: Speaker[];
  nextNumber: number;
  /** Known number of speakers (from recluster), or null. */
  cap: number | null;
  /** Segments of this source that have an embedding, in arrival order. */
  embedded: SegmentRecord[];
  /** similarities[i][j] = cosine(embedded[i], embedded[j]) for j < i, kept up to date so recluster() is O(n²) cheap. */
  similarities: Float32Array[];
}

export class SpeakerClusterer {
  readonly options: Readonly<ClusteringOptions>;
  private readonly segments: SegmentRecord[] = [];
  private readonly sources = new Map<AudioSourceKind, SourceState>();

  constructor(options: Partial<ClusteringOptions> = {}) {
    this.options = { ...DEFAULT_CLUSTERING, ...options };
  }

  /** Online assignment of one segment. */
  add(input: ClusterSegmentInput): SegmentAssignment {
    const record: SegmentRecord = {
      ...input,
      weight: Math.min(input.speechMs / 1000, this.options.maxWeightSec),
      speakerId: null,
      confidence: null,
    };
    this.segments.push(record);
    const embedding = record.embedding;
    if (!embedding) return assignmentOf(record);

    const state = this.source(record.source);
    const row = new Float32Array(state.embedded.length);
    state.embedded.forEach((other, j) => (row[j] = dot(embedding, other.embedding!)));
    state.embedded.push(record);
    state.similarities.push(row);

    let best: Speaker | null = null;
    let bestSimilarity = -Infinity;
    for (const speaker of state.speakers) {
      const similarity = cosineToCentroid(embedding, speaker);
      if (similarity > bestSimilarity) {
        best = speaker;
        bestSimilarity = similarity;
      }
    }

    const capped = state.cap !== null && state.speakers.length >= state.cap;
    if (best && (bestSimilarity >= this.joinThreshold(record.speechMs) || capped)) {
      record.confidence = clamp01(bestSimilarity);
      addMember(best, record);
      this.mergeNearDuplicates(state, best);
    } else if (record.speechMs >= this.options.minNewSpeakerMs) {
      // Also for the source's first speaker: a speaker founded on a short, noisy embedding is often not matched
      // by its own later segments, which then open a second speaker for the same person.
      const speaker = this.newSpeaker(state, record.source);
      record.confidence = 1;
      addMember(speaker, record);
    }
    return assignmentOf(record);
  }

  /**
   * Offline re-clustering of every segment seen so far. `speakersPerSource` fixes the number of speakers of a
   * source (and caps later online assignments to it); sources without a count use the threshold. Returns
   * the assignment of every segment, in the order they were added.
   */
  recluster(speakersPerSource: Partial<Record<AudioSourceKind, number>> = {}): SegmentAssignment[] {
    for (const [source, state] of this.sources) {
      const requested = speakersPerSource[source];
      const count = requested !== undefined && Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : null;
      this.reclusterSource(source, state, count);
    }
    return this.segments.map(assignmentOf);
  }

  /** Every assignment so far, in the order the segments were added. */
  assignments(): SegmentAssignment[] {
    return this.segments.map(assignmentOf);
  }

  // -------------------------------------------------------------------------
  // Online
  // -------------------------------------------------------------------------

  private joinThreshold(speechMs: number): number {
    const { threshold, shortThreshold, minSpeechMs, fullSpeechMs } = this.options;
    if (fullSpeechMs <= minSpeechMs) return threshold;
    const t = Math.min(1, Math.max(0, (speechMs - minSpeechMs) / (fullSpeechMs - minSpeechMs)));
    return shortThreshold + t * (threshold - shortThreshold);
  }

  private source(source: AudioSourceKind): SourceState {
    let state = this.sources.get(source);
    if (!state) {
      state = { speakers: [], nextNumber: 1, cap: null, embedded: [], similarities: [] };
      this.sources.set(source, state);
    }
    return state;
  }

  private newSpeaker(state: SourceState, source: AudioSourceKind): Speaker {
    const speaker: Speaker = { id: `${source}-${state.nextNumber++}`, sum: new Float64Array(0), weight: 0, members: [] };
    state.speakers.push(speaker);
    return speaker;
  }

  /** Merges `changed` with any speaker of the source whose centroid is now within mergeThreshold of it. */
  private mergeNearDuplicates(state: SourceState, changed: Speaker): void {
    for (;;) {
      let partner: Speaker | null = null;
      let partnerSimilarity = this.options.mergeThreshold;
      for (const other of state.speakers) {
        if (other === changed) continue;
        const similarity = centroidSimilarity(changed, other);
        if (similarity >= partnerSimilarity) {
          partner = other;
          partnerSimilarity = similarity;
        }
      }
      if (!partner) return;
      // Keep the older speaker (lower number): its id is the one the user has seen longest.
      const [keep, drop] = speakerNumber(partner) < speakerNumber(changed) ? [partner, changed] : [changed, partner];
      for (const member of drop.members) addMember(keep, member);
      state.speakers.splice(state.speakers.indexOf(drop), 1);
      changed = keep;
    }
  }

  // -------------------------------------------------------------------------
  // Offline
  // -------------------------------------------------------------------------

  private reclusterSource(source: AudioSourceKind, state: SourceState, count: number | null): void {
    state.cap = count;
    const items = state.embedded;
    if (items.length === 0) return;

    const { similarities } = state;
    // Every segment counts the same in the linkage (speech-weighted linkage was no better on AMI).
    const tree = averageLinkage(items.length, (i, j) => (i > j ? similarities[i][j] : similarities[j][i]), new Array(items.length).fill(1));
    const speech = items.map((s) => s.speechMs);
    const totalSpeech = speech.reduce((a, b) => a + b, 0);
    const minSpeech = Math.max(this.options.minClusterSpeechMs, this.options.minClusterFraction * totalSpeech);
    let groups: number[][];
    if (count === null) {
      const merges = tree.merges.filter((m) => m.similarity >= this.options.reclusterThreshold).length;
      groups = this.foldSmallClusters(items, cutTree(tree, merges), minSpeech);
    } else {
      // Average linkage keeps outliers (noisy or mixed segments) apart until the very end, so cutting at exactly
      // `count` clusters tends to give one big cluster plus outliers. Instead: the coarsest cut that still has
      // `count` clusters with real speech, then fold the remaining small clusters into them.
      const large = Math.min(minSpeech, totalSpeech / (2 * count));
      const merges = coarsestCutWithLargeClusters(tree, speech, large, count);
      groups =
        merges === null ? cutTree(tree, Math.max(0, items.length - count)) : this.foldSmallClusters(items, cutTree(tree, merges), large);
    }

    const inherited = inheritIds(groups, items);
    const speakers: Speaker[] = [];
    // New ids are numbered in order of each cluster's first segment.
    const order = groups.map((group, g) => ({ g, first: Math.min(...group) })).sort((a, b) => a.first - b.first);
    for (const { g } of order) {
      speakers.push({ id: inherited[g] ?? `${source}-${state.nextNumber++}`, sum: new Float64Array(0), weight: 0, members: [] });
    }
    order.forEach(({ g }, k) => {
      for (const i of groups[g]) addMember(speakers[k], items[i]);
    });
    // Confidence: similarity to the centroid of the speaker's other segments (1 for a speaker's only segment).
    for (const speaker of speakers) {
      for (const member of speaker.members) member.confidence = leaveOneOutSimilarity(speaker, member);
    }
    state.speakers = speakers.sort((a, b) => speakerNumber(a) - speakerNumber(b));
  }

  /** Moves the members of clusters with less than `minSpeechMs` of speech to the most similar larger cluster. */
  private foldSmallClusters(items: SegmentRecord[], groups: number[][], minSpeechMs: number): number[][] {
    const speech = (group: number[]) => group.reduce((sum, i) => sum + items[i].speechMs, 0);
    const large = groups.filter((g) => speech(g) >= minSpeechMs);
    if (large.length === 0 || large.length === groups.length) return groups;
    const isLarge = new Set(large);
    const centroids = large.map((g) => centroidOf(g.map((i) => items[i])));
    const result = large.map((g) => [...g]);
    for (const group of groups) {
      if (isLarge.has(group)) continue;
      for (const i of group) {
        let best = 0;
        let bestSimilarity = -Infinity;
        centroids.forEach((c, k) => {
          const similarity = dot(items[i].embedding!, c);
          if (similarity > bestSimilarity) {
            best = k;
            bestSimilarity = similarity;
          }
        });
        result[best].push(i);
      }
    }
    return result.map((g) => g.sort((a, b) => a - b));
  }
}

// ---------------------------------------------------------------------------
// Speakers and vectors
// ---------------------------------------------------------------------------

/** Above this many cells the id matching is greedy instead of Hungarian (only with hundreds of speakers). */
const MAX_HUNGARIAN_CELLS = 2500;

/**
 * The old speaker id each new cluster keeps, or null for a new id: a one-to-one matching of clusters to the
 * ids their segments had, maximising the speech that keeps its label (Hungarian assignment).
 */
function inheritIds(groups: number[][], items: SegmentRecord[]): (string | null)[] {
  const oldIds: string[] = [];
  const column = new Map<string, number>();
  const shared = groups.map((group) => {
    const row = new Map<number, number>();
    for (const i of group) {
      const id = items[i].speakerId;
      if (id === null) continue;
      let c = column.get(id);
      if (c === undefined) {
        c = oldIds.length;
        oldIds.push(id);
        column.set(id, c);
      }
      row.set(c, (row.get(c) ?? 0) + items[i].weight);
    }
    return row;
  });
  let match: (number | null)[];
  if (groups.length * oldIds.length <= MAX_HUNGARIAN_CELLS) {
    match = maximumWeightMatching(shared.map((row) => oldIds.map((_, c) => row.get(c) ?? 0)));
  } else {
    match = new Array<number | null>(groups.length).fill(null);
    const taken = new Set<number>();
    const pairs = shared.flatMap((row, g) => [...row].map(([c, speech]) => ({ g, c, speech }))).sort((a, b) => b.speech - a.speech);
    for (const { g, c } of pairs) {
      if (match[g] !== null || taken.has(c)) continue;
      match[g] = c;
      taken.add(c);
    }
  }
  return match.map((c, g) => (c !== null && (shared[g].get(c) ?? 0) > 0 ? oldIds[c] : null));
}

function assignmentOf(s: SegmentRecord): SegmentAssignment {
  return { segmentId: s.segmentId, speakerId: s.speakerId, confidence: s.speakerId === null ? null : s.confidence };
}

function addMember(speaker: Speaker, record: SegmentRecord): void {
  const e = record.embedding!;
  if (speaker.sum.length === 0) speaker.sum = new Float64Array(e.length);
  for (let d = 0; d < e.length; d++) speaker.sum[d] += record.weight * e[d];
  speaker.weight += record.weight;
  speaker.members.push(record);
  record.speakerId = speaker.id;
}

function speakerNumber(speaker: Speaker): number {
  return Number(speaker.id.slice(speaker.id.lastIndexOf('-') + 1));
}

function cosineToCentroid(e: Float32Array, speaker: Speaker): number {
  return cosine(e, speaker.sum);
}

function centroidSimilarity(a: Speaker, b: Speaker): number {
  return cosine(a.sum, b.sum);
}

function leaveOneOutSimilarity(speaker: Speaker, member: SegmentRecord): number {
  if (speaker.members.length < 2) return 1;
  const e = member.embedding!;
  const rest = new Float64Array(speaker.sum.length);
  for (let d = 0; d < rest.length; d++) rest[d] = speaker.sum[d] - member.weight * e[d];
  return clamp01(cosine(e, rest));
}

function centroidOf(records: SegmentRecord[]): Float64Array {
  const sum = new Float64Array(records[0].embedding!.length);
  for (const r of records) for (let d = 0; d < sum.length; d++) sum[d] += r.weight * r.embedding![d];
  return normalized(sum);
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function normalized(v: Float64Array): Float64Array {
  const norm = Math.sqrt(dot(v, v));
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

// ---------------------------------------------------------------------------
// Average-linkage agglomerative clustering (nearest-neighbour chain)
// ---------------------------------------------------------------------------

/** Merges of an agglomerative clustering, most similar first. Item i is cluster i; a merge joins b into a. */
export interface Dendrogram {
  n: number;
  merges: { a: number; b: number; similarity: number }[];
}

/**
 * Weighted average linkage on cosine distance between n items (nearest-neighbour chain: O(n²) time and
 * memory). The merges come out sorted by decreasing similarity, which for a reducible linkage such as
 * average linkage is the same dendrogram the naive closest-pair-first algorithm builds.
 */
export function averageLinkage(n: number, similarity: (i: number, j: number) => number, weights: number[]): Dendrogram {
  if (n < 2) return { n, merges: [] };
  // Condensed upper-triangular distance matrix, updated in place with the Lance–Williams formula.
  const dist = new Float32Array((n * (n - 1)) / 2);
  const at = (i: number, j: number) => (i < j ? i * n - (i * (i + 1)) / 2 + (j - i - 1) : j * n - (j * (j + 1)) / 2 + (i - j - 1));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) dist[at(i, j)] = 1 - similarity(i, j);

  const size = Float64Array.from(weights);
  const active = new Uint8Array(n).fill(1);
  const merges: Dendrogram['merges'] = [];
  const chain: number[] = [];
  let remaining = n;
  while (remaining > 1) {
    if (chain.length === 0) chain.push(active.indexOf(1));
    const a = chain[chain.length - 1];
    const previous = chain.length > 1 ? chain[chain.length - 2] : -1;
    let b = -1;
    let best = Infinity;
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === a) continue;
      const d = dist[at(a, k)];
      if (d < best || (d === best && k === previous)) {
        best = d;
        b = k;
      }
    }
    if (b === previous) {
      // a and b are each other's nearest neighbours: merge b into a (a's row becomes the merged cluster).
      chain.length -= 2;
      merges.push({ a, b, similarity: 1 - best });
      for (let k = 0; k < n; k++) {
        if (!active[k] || k === a || k === b) continue;
        dist[at(a, k)] = (size[a] * dist[at(a, k)] + size[b] * dist[at(b, k)]) / (size[a] + size[b]);
      }
      size[a] += size[b];
      active[b] = 0;
      remaining--;
    } else {
      chain.push(b);
    }
  }
  merges.sort((x, y) => y.similarity - x.similarity);
  return { n, merges };
}

/** Clusters (sorted item indices) after applying the first `count` merges of the dendrogram. */
export function cutTree(tree: Dendrogram, count: number): number[][] {
  const parent = Int32Array.from({ length: tree.n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (const { a, b } of tree.merges.slice(0, Math.max(0, count))) parent[find(b)] = find(a);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < tree.n; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(i);
    else groups.set(root, [i]);
  }
  return [...groups.values()];
}

/**
 * The largest number of merges after which at least `clusters` clusters have `minSpeech` or more speech,
 * or null if no cut has that many.
 */
function coarsestCutWithLargeClusters(tree: Dendrogram, speech: number[], minSpeech: number, clusters: number): number | null {
  const parent = Int32Array.from({ length: tree.n }, (_, i) => i);
  const total = Float64Array.from(speech);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  let large = speech.filter((s) => s >= minSpeech).length;
  let best = large >= clusters ? 0 : null;
  tree.merges.forEach(({ a, b }, m) => {
    const ra = find(a);
    const rb = find(b);
    large -= (total[ra] >= minSpeech ? 1 : 0) + (total[rb] >= minSpeech ? 1 : 0);
    parent[rb] = ra;
    total[ra] += total[rb];
    if (total[ra] >= minSpeech) large++;
    if (large >= clusters) best = m + 1;
  });
  return best;
}

// ---------------------------------------------------------------------------
// Hungarian assignment
// ---------------------------------------------------------------------------

/**
 * For a rows × cols matrix of non-negative scores, the row → column matching (each column used at most once)
 * that maximises the total score. Returns the matched column per row, or null for unmatched rows.
 */
export function maximumWeightMatching(score: number[][]): (number | null)[] {
  const rows = score.length;
  const cols = rows > 0 ? score[0].length : 0;
  const result: (number | null)[] = new Array(rows).fill(null);
  if (rows === 0 || cols === 0) return result;
  // Square cost matrix (minimisation), padded with zeros-score cells.
  const n = Math.max(rows, cols);
  let max = 0;
  for (const row of score) for (const v of row) max = Math.max(max, v);
  const cost = (i: number, j: number) => (i < rows && j < cols ? max - score[i][j] : max);

  // Kuhn–Munkres with potentials (1-indexed), O(n³).
  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1); // p[j] = row matched to column j
  const way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(Infinity);
    const used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  for (let j = 1; j <= n; j++) {
    const i = p[j] - 1;
    if (i >= 0 && i < rows && j - 1 < cols) result[i] = j - 1;
  }
  return result;
}

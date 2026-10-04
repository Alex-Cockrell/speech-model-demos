/**
 * "Refine with Teams transcript": our words and word timings, Teams' speaker names and turn boundaries.
 * OWNER: meeting agent.
 *
 * Call audio is one mixed stream and our segments are cut at pauses, so people talking over each other share a
 * line and a label. Teams hears each participant's microphone separately: its names are right even where its
 * words are not. Steps (all local, text only):
 *
 *  1. Words. Ours from every visible line (echo duplicates left out), in time order; Teams' from its turns, each
 *     turn's words spread over its time (to the next turn's start, at most ~8 characters per second).
 *  2. Clock offset. Word triples found exactly once in each transcript are anchors; the densest cluster of their
 *     time offsets gives the offset (and drift); too few agreeing anchors → not the same meeting. The anchors
 *     then map Teams word times onto our timeline (anchors.ts).
 *  3. Alignment. Banded DP with near matches (align.ts), then a second pass over what is left, which catches
 *     words of overlapping speakers that came out in a different order.
 *  4. Speakers. A word takes the speaker of the Teams word it aligned to; other words take their neighbours'
 *     speaker or that of the Teams turn covering their time. Noise is smoothed; changes snap to punctuation.
 *  5. Lines. Our lines split where the speaker changes; Teams words with no counterpart (≥ 3 in a row, usually
 *     crosstalk we missed) become lines of their own; close same-speaker lines of a source are merged.
 *
 * The result is a new transcript; the original is not touched.
 */
import type { AudioSourceKind, TranscriptWord } from '../../types';
import { cleanText, cleanTitle, compareSegments } from '../model';
import type { MeetingSegment, MeetingSpeaker, MeetingTranscript, TranscriptRefinement } from '../types';
import {
  PAIR_EXACT,
  PAIR_FUZZY,
  PAIR_NONE,
  PAIR_SUB,
  PASS1_OPTIONS,
  alignBanded,
  alignBandedSteps,
  createSimilarity,
  type Alignment,
  type BandedAlignOptions,
} from './align';
import { findAnchors, fitOffset, mapTeamsTimes, monotoneChain, type Anchor } from './anchors';
import {
  NO_SPEAKER,
  STRENGTH_ALIGNED,
  STRENGTH_INFERRED,
  STRENGTH_MATCHED,
  STRENGTH_NONE,
  UNNAMED_SPEAKER,
  smoothSpeakers,
  snapToPunctuation,
  speakerRuns,
  splitCorrectedText,
  type WordLabel,
} from './resegment';
import { Vocab, runningMax, tokenize } from './tokens';
import type { ParsedTeamsTranscript, TeamsTurn } from './types';

export const REFINE_SETTINGS = {
  /** Band of the main alignment: Teams words within ±20 s of ours (after the clock offset). */
  windowMs: 20_000,
  /** Band of the second pass over unpaired words. */
  residualWindowMs: 10_000,
  /** Anchor length in words. */
  anchorWords: 3,
  /** Anchor offsets this close to the model agree (Teams word times inside long turns are rough). */
  anchorToleranceMs: 10_000,
  /** Agreeing anchors needed: at least 4 and 2 % of the shorter transcript's words… */
  minAnchors: 4,
  minAnchorShare: 0.02,
  /** …and a quarter of all anchors found. */
  minInlierShare: 0.25,
  /** Teams words in a row with no counterpart before they become a line of their own. */
  teamsOnlyMinWords: 3,
  /** Same-speaker lines of one source this close are merged, up to this length. */
  mergeGapMs: 2_000,
  mergeMaxMs: 60_000,
  /** A line whose words match its speaker's Teams words less than this is "speaker uncertain". */
  lowConfidence: 0.5,
  /** Lines this far outside the time the Teams transcript covers keep their earlier speaker. */
  coverageMarginMs: 10_000,
  /** A Teams turn of at most this many words is an interjection ("yeah", "right") worth keeping. */
  interjectionMaxWords: 4,
  /** The alignment band shrinks if it would need more DP cells than this (memory: 1 byte per cell). */
  maxCells: 40_000_000,
};

/**
 * A substitution, or a lone match of a common word, counts only with an exact or near match into the same Teams
 * turn this many words away or closer.
 */
const SUPPORT_WORDS = 3;

/** Spreading a turn's words over its time: natural speech ≈ 15 characters/s; slower than 8 means a pause followed. */
const NATURAL_CPS = 15;
const SLOWEST_CPS = 8;

export type RefinePhase = 'matching' | 'aligning' | 'speakers';

export interface RefineProgress {
  phase: RefinePhase;
  /** 0..1 within the phase. */
  fraction: number;
}

export type RefineErrorCode = 'no-teams-text' | 'no-teams-speakers' | 'no-words' | 'not-same-meeting';

export class RefineError extends Error {
  readonly code: RefineErrorCode;
  constructor(code: RefineErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RefineOptions {
  /** Id of the new transcript. */
  id: string;
  now?: Date;
  /** Insert Teams-only lines (default true). */
  includeTeamsOnly?: boolean;
  onProgress?: (progress: RefineProgress) => void;
  /** Lets the page breathe (render, handle input) between chunks of work; called at most every ~25 ms. */
  pause?: () => Promise<void>;
  /** ms clock for the elapsed time (default performance.now). */
  clock?: () => number;
  settings?: Partial<typeof REFINE_SETTINGS>;
}

export interface RefineDiagnostics {
  oursTokens: number;
  teamsTokens: number;
  anchorCandidates: number;
  anchorInliers: number;
  chain: number;
  windowMs: number;
  cells: number;
  timingsMs: { prepare: number; anchors: number; align: number; build: number };
}

export interface RefineResult {
  transcript: MeetingTranscript;
  refinement: TranscriptRefinement;
  diagnostics: RefineDiagnostics;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

interface OurWord {
  /** Index into the source-segment list. */
  seg: number;
  text: string;
  startMs: number;
  endMs: number;
  confidence: number | null;
  /** Token range [tok0, tok1) in the time-ordered token arrays. */
  tok0: number;
  tok1: number;
}

interface SourceSegment {
  segment: MeetingSegment;
  words: OurWord[];
  /** The line had no word timings; its words were spread over its time. */
  synthetic: boolean;
}

/** Words spread over [startMs, endMs] by character count (lines without word timings). */
export function spreadWords(text: string, startMs: number, endMs: number): TranscriptWord[] {
  const raw = text.split(/\s+/).filter(Boolean);
  const total = raw.reduce((s, w) => s + w.length + 1, 0) || 1;
  const span = Math.max(0, endMs - startMs);
  let pos = 0;
  return raw.map((w) => {
    const start = startMs + (pos / total) * span;
    pos += w.length + 1;
    return { text: w, startMs: Math.round(start), endMs: Math.round(startMs + ((pos - 1) / total) * span), confidence: null };
  });
}

interface TeamsTokens {
  ids: Int32Array;
  /** Teams time of each token. */
  ms: Float64Array;
  turn: Int32Array;
  /** Index of the token's written word within its turn. */
  rawWord: Int32Array;
  /** Token range of each turn. */
  turnTok0: Int32Array;
  turnTok1: Int32Array;
  rawWords: string[][];
}

/**
 * Teams words with times: a turn lasts until the next later turn starts (or its cue ends), but no longer than
 * its text takes at 8 characters per second; its words are spread over that time by character position.
 */
export function teamsTokenTimes(turns: readonly TeamsTurn[], vocab: Vocab): TeamsTokens {
  const ids: number[] = [];
  const ms: number[] = [];
  const turnOf: number[] = [];
  const rawWordOf: number[] = [];
  const turnTok0 = new Int32Array(turns.length);
  const turnTok1 = new Int32Array(turns.length);
  const rawWords: string[][] = [];
  // Start of the next turn that starts later than each turn (turns sharing a start time look past each other).
  const nextLater = new Array<number | null>(turns.length).fill(null);
  for (let t = turns.length - 2; t >= 0; t--) {
    const next = turns[t + 1].startMs > turns[t].startMs ? turns[t + 1].startMs : nextLater[t + 1];
    nextLater[t] = next !== null && next > turns[t].startMs ? next : null;
  }
  turns.forEach((turn, t) => {
    const words = turn.text.split(/\s+/).filter(Boolean);
    rawWords.push(words);
    const chars = Math.max(1, words.reduce((s, w) => s + w.length + 1, 0) - 1);
    let end: number;
    if (turn.endMs !== null && turn.endMs > turn.startMs) {
      end = turn.endMs;
    } else {
      const natural = (chars / NATURAL_CPS) * 1000;
      const cap = Math.max(1500, (chars / SLOWEST_CPS) * 1000);
      const next = nextLater[t];
      end = next !== null ? Math.min(next, turn.startMs + cap) : turn.startMs + natural;
    }
    const span = Math.max(1, end - turn.startMs);
    turnTok0[t] = ids.length;
    let pos = 0;
    words.forEach((w, k) => {
      const tokens = tokenize(w);
      tokens.forEach((tok, q) => {
        ids.push(vocab.id(tok));
        ms.push(turn.startMs + ((pos + ((q + 0.5) / tokens.length) * w.length) / chars) * span);
        turnOf.push(t);
        rawWordOf.push(k);
      });
      pos += w.length + 1;
    });
    turnTok1[t] = ids.length;
  });
  return {
    ids: Int32Array.from(ids),
    ms: Float64Array.from(ms),
    turn: Int32Array.from(turnOf),
    rawWord: Int32Array.from(rawWordOf),
    turnTok0,
    turnTok1,
    rawWords,
  };
}

// ---------------------------------------------------------------------------
// The refinement
// ---------------------------------------------------------------------------

const RESIDUAL_OPTIONS: Omit<BandedAlignOptions, 'windowMs'> = {
  exactScore: 2,
  fuzzyMin: 0.75,
  mismatchScore: null,
  gapOurs: -0.05,
  gapTeams: -0.05,
  slackMs: 4000,
  timeWeight: 0.3,
  farPerSecond: 0.45,
};

function lowerBound(values: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** "Weekly sync (refined)", shortened so the suffix survives the title limit. */
export function refinedTitle(title: string): string {
  const suffix = ' (refined)';
  return cleanTitle(`${cleanTitle(title).slice(0, 120 - suffix.length).trim()}${suffix}`);
}

interface Piece {
  id: string;
  source: AudioSourceKind;
  /** Teams speaker index, UNNAMED_SPEAKER, or NO_SPEAKER when an earlier speaker id is kept. */
  speaker: number;
  /** For lines outside the Teams transcript: the earlier speaker id. */
  keptSpeakerId: string | null;
  keptConfidence: number | null;
  startMs: number;
  endMs: number;
  text: string;
  originalText: string | null;
  words: TranscriptWord[] | null;
  /** Our token indices (for confidence); empty for Teams-only lines. */
  tokens: number[];
  teamsOnly: boolean;
  outside: boolean;
  /** Original segment ids this line contains (echo duplicates point at them). */
  from: string[];
}

export async function refineWithTeams(
  original: MeetingTranscript,
  teams: ParsedTeamsTranscript,
  options: RefineOptions,
): Promise<RefineResult> {
  const S = { ...REFINE_SETTINGS, ...options.settings };
  const clock = options.clock ?? (() => performance.now());
  const started = clock();
  let lastPause = started;
  const breathe = async () => {
    if (options.pause && clock() - lastPause >= 25) {
      await options.pause();
      lastPause = clock();
    }
  };
  const report = (phase: RefinePhase, fraction: number) => options.onProgress?.({ phase, fraction });

  if (teams.turns.length === 0) {
    throw new RefineError('no-teams-text', 'Nothing in the Teams transcript could be read: no lines with a speaker and a time were found.');
  }
  if (teams.speakers.length === 0) {
    throw new RefineError('no-teams-speakers', 'The Teams transcript names no speakers, so it cannot fix the speaker labels.');
  }
  report('matching', 0);

  // ----- 1. words ------------------------------------------------------------
  const vocab = new Vocab();
  const sources: SourceSegment[] = [];
  const ordered = [...original.segments].sort(compareSegments);
  for (const segment of ordered) {
    if (segment.echoOf !== null || segment.origin === 'teams' || cleanText(segment.text) === '') continue;
    const usable = segment.words && segment.words.length > 0;
    const base = usable ? (segment.words as TranscriptWord[]) : spreadWords(segment.text, segment.startMs, segment.endMs);
    const index = sources.length;
    sources.push({
      segment,
      synthetic: !usable,
      words: base.map((w) => ({ seg: index, text: w.text, startMs: w.startMs, endMs: Math.max(w.startMs, w.endMs), confidence: w.confidence, tok0: 0, tok1: 0 })),
    });
  }
  const allWords = sources.flatMap((s) => s.words);
  const timeOrder = allWords.map((_, k) => k).sort((x, y) => allWords[x].startMs - allWords[y].startMs || x - y);
  const oursIds: number[] = [];
  const oursRaw: number[] = [];
  const oursWord: number[] = [];
  for (const k of timeOrder) {
    const w = allWords[k];
    const tokens = tokenize(w.text);
    w.tok0 = oursIds.length;
    tokens.forEach((tok, q) => {
      oursIds.push(vocab.id(tok));
      oursRaw.push(w.startMs + ((q + 0.5) / tokens.length) * (w.endMs - w.startMs));
      oursWord.push(k);
    });
    w.tok1 = oursIds.length;
  }
  const N = oursIds.length;
  if (N === 0) throw new RefineError('no-words', 'This transcript has no words to match with the Teams transcript.');
  const ours = Int32Array.from(oursIds);
  const oursMs = runningMax(oursRaw);
  const tt = teamsTokenTimes(teams.turns, vocab);
  const M = tt.ids.length;
  if (M === 0) throw new RefineError('no-teams-text', 'The Teams transcript has speakers and times but no words.');
  const speakerIndex = new Map(teams.speakers.map((name, i) => [name, i]));
  const turnSpeaker = teams.turns.map((t) => (t.speaker ? (speakerIndex.get(t.speaker) ?? UNNAMED_SPEAKER) : UNNAMED_SPEAKER));
  const tPrepared = clock();
  await breathe();

  // ----- 2. clock offset -----------------------------------------------------
  const pairs = findAnchors(ours, tt.ids, S.anchorWords, vocab.size);
  const anchors: Anchor[] = pairs.map((p) => ({ ...p, teamsMs: tt.ms[p.j], offsetMs: oursMs[p.i] - tt.ms[p.j] }));
  const tolerance = Math.max(S.anchorToleranceMs, teams.timeResolutionMs * 0.75);
  const needed = Math.max(S.minAnchors, Math.ceil(S.minAnchorShare * Math.min(N, M)));
  const fit = fitOffset(anchors, tolerance, needed);
  const agree = fit ? fit.inliers.length : 0;
  if (!fit || agree < needed || agree < S.minInlierShare * anchors.length) {
    throw new RefineError(
      'not-same-meeting',
      `These transcripts don't seem to be the same meeting: only ${agree} short passage${agree === 1 ? '' : 's'} of the Teams ` +
        `transcript match this recording at a consistent time (${needed} needed). Check that the Teams transcript is from ` +
        'this meeting and covers the time this recording ran.',
    );
  }
  const chain = monotoneChain([...fit.inliers, ...fit.extra]);
  const teamsMs = mapTeamsTimes(tt.ms, chain, fit.model);
  report('matching', 1);
  const tAnchors = clock();
  await breathe();

  // ----- 3. alignment --------------------------------------------------------
  const similarity = createSimilarity(vocab.words, 0.6);
  let windowMs = S.windowMs;
  while (windowMs > 2000 && estimateCells(oursMs, teamsMs, windowMs) > S.maxCells) windowMs = Math.round(windowMs * 0.7);
  const steps = alignBandedSteps(ours, oursMs, tt.ids, teamsMs, similarity, { ...PASS1_OPTIONS, windowMs });
  let pass1: Alignment;
  for (;;) {
    const step = steps.next();
    if (step.done) {
      pass1 = step.value;
      break;
    }
    report('aligning', step.value * 0.9);
    await breathe();
  }
  const partner = pass1.oursPartner;
  const kind = pass1.oursKind;
  const teamsPartner = pass1.teamsPartner;

  // Second pass over what is left (and what only paired with a different word): matches only.
  const restOurs: number[] = [];
  for (let i = 0; i < N; i++) if (kind[i] === PAIR_NONE || kind[i] === PAIR_SUB) restOurs.push(i);
  const restTeams: number[] = [];
  for (let j = 0; j < M; j++) if (teamsPartner[j] < 0 || kind[teamsPartner[j]] === PAIR_SUB) restTeams.push(j);
  if (restOurs.length > 0 && restTeams.length > 0) {
    const pass2 = alignBanded(
      Int32Array.from(restOurs, (i) => ours[i]),
      Float64Array.from(restOurs, (i) => oursMs[i]),
      Int32Array.from(restTeams, (j) => tt.ids[j]),
      Float64Array.from(restTeams, (j) => teamsMs[j]),
      similarity,
      { ...RESIDUAL_OPTIONS, windowMs: S.residualWindowMs },
    );
    for (let p = 0; p < restOurs.length; p++) {
      const q = pass2.oursPartner[p];
      if (q < 0) continue;
      const i = restOurs[p];
      const j = restTeams[q];
      if (partner[i] >= 0) teamsPartner[partner[i]] = -1;
      const previous = teamsPartner[j];
      if (previous >= 0) {
        partner[previous] = -1;
        kind[previous] = PAIR_NONE;
      }
      partner[i] = j;
      teamsPartner[j] = i;
      kind[i] = pass2.oursKind[p];
    }
  }
  // A common word ("the", "and") matched on its own inside someone's longer Teams turn says little: such words are
  // everywhere. It needs another match into the same turn within a few words, or a short turn of its own ("Yes.").
  const counts = new Int32Array(vocab.size);
  for (let i = 0; i < N; i++) counts[ours[i]]++;
  const commonCount = Math.max(3, Math.ceil(N * 0.002));
  const matchedBefore = Uint8Array.from(kind, (k) => (k === PAIR_EXACT || k === PAIR_FUZZY ? 1 : 0));
  // Neighbours within the same line of ours (the time-ordered token stream interleaves other lines' words).
  const lineTokens: number[][] = sources.map((s) => s.words.flatMap((w) => Array.from({ length: w.tok1 - w.tok0 }, (_, q) => w.tok0 + q)));
  const lineOf = new Int32Array(N);
  const posInLine = new Int32Array(N);
  lineTokens.forEach((list, line) =>
    list.forEach((i, p) => {
      lineOf[i] = line;
      posInLine[i] = p;
    }),
  );
  const supportedBy = (i: number, turn: number, matched: (k: number) => boolean): boolean => {
    const list = lineTokens[lineOf[i]];
    const p = posInLine[i];
    for (let d = 1; d <= SUPPORT_WORDS; d++) {
      for (const q of [p - d, p + d]) {
        const k = list[q];
        if (k !== undefined && matched(k) && tt.turn[partner[k]] === turn) return true;
      }
    }
    return false;
  };
  for (let i = 0; i < N; i++) {
    if (!matchedBefore[i]) continue;
    const word = vocab.words[ours[i]];
    if (word.length > 2 && counts[ours[i]] < commonCount) continue;
    const turn = tt.turn[partner[i]];
    if (tt.turnTok1[turn] - tt.turnTok0[turn] <= S.interjectionMaxWords) continue;
    if (supportedBy(i, turn, (k) => matchedBefore[k] === 1)) continue;
    teamsPartner[partner[i]] = -1;
    partner[i] = -1;
    kind[i] = PAIR_NONE;
  }
  // Two different words paired up are evidence only next to real matches in the same Teams turn (Teams misheard a
  // word in a passage that otherwise lines up). Elsewhere, e.g. our words where Teams has none, the alignment just
  // paired them with whatever lay in the band: dropped.
  for (let i = 0; i < N; i++) {
    if (kind[i] !== PAIR_SUB) continue;
    if (!supportedBy(i, tt.turn[partner[i]], (k) => kind[k] === PAIR_EXACT || kind[k] === PAIR_FUZZY)) {
      teamsPartner[partner[i]] = -1;
      partner[i] = -1;
      kind[i] = PAIR_NONE;
    }
  }
  report('aligning', 1);
  const tAligned = clock();
  await breathe();

  // ----- 4. speakers ---------------------------------------------------------
  report('speakers', 0);
  const turnCount = teams.turns.length;
  const turnStart = new Float64Array(turnCount).fill(NaN);
  const turnEnd = new Float64Array(turnCount).fill(NaN);
  let maxTurnSpan = 0;
  for (let t = 0; t < turnCount; t++) {
    if (tt.turnTok1[t] <= tt.turnTok0[t]) continue;
    turnStart[t] = teamsMs[tt.turnTok0[t]];
    turnEnd[t] = teamsMs[tt.turnTok1[t] - 1] + 400;
    maxTurnSpan = Math.max(maxTurnSpan, turnEnd[t] - turnStart[t]);
  }
  const turnsWithWords = [...Array(turnCount).keys()].filter((t) => !Number.isNaN(turnStart[t]));
  const turnStarts = Float64Array.from(turnsWithWords, (t) => turnStart[t]);
  const SLACK = 1500;
  /** Teams turns whose (mapped) time covers x, give or take SLACK. */
  const coveringTurns = (x: number): number[] => {
    const found: number[] = [];
    for (let k = lowerBound(turnStarts, x + SLACK + 1e-9) - 1; k >= 0 && turnStarts[k] >= x - maxTurnSpan - SLACK; k--) {
      const t = turnsWithWords[k];
      if (turnEnd[t] + SLACK >= x) found.push(t);
    }
    return found;
  };
  const nearestUnpairedTeams = (turnsToSearch: readonly number[], x: number): number | null => {
    let best: number | null = null;
    let bestDt = 3000;
    for (const t of turnsToSearch) {
      for (let j = tt.turnTok0[t]; j < tt.turnTok1[t]; j++) {
        if (teamsPartner[j] >= 0) continue;
        const dt = Math.abs(teamsMs[j] - x);
        if (dt < bestDt) {
          bestDt = dt;
          best = turnSpeaker[t];
        }
      }
    }
    return best;
  };

  const tokSpeaker = new Int32Array(N).fill(NO_SPEAKER);
  const tokStrength = new Uint8Array(N);
  const tokInterjection = new Uint8Array(N);
  /** Speaker of each token's Teams partner (for confidence), or NO_SPEAKER. */
  const partnerSpeaker = new Int32Array(N).fill(NO_SPEAKER);
  for (let i = 0; i < N; i++) {
    const j = partner[i];
    if (j < 0) continue;
    const t = tt.turn[j];
    tokSpeaker[i] = partnerSpeaker[i] = turnSpeaker[t];
    const matched = kind[i] === PAIR_EXACT || kind[i] === PAIR_FUZZY;
    tokStrength[i] = matched ? STRENGTH_MATCHED : STRENGTH_ALIGNED;
    if (matched && tt.turnTok1[t] - tt.turnTok0[t] <= S.interjectionMaxWords) tokInterjection[i] = 1;
  }
  const coverStart = teamsMs[0] - S.coverageMarginMs;
  const coverEnd = teamsMs[M - 1] + S.coverageMarginMs;

  // Which source each Teams speaker is heard on: where their matched words are (the people in the room on the
  // microphone, remote participants on the call audio).
  const sourceOfToken = (i: number): AudioSourceKind => sources[allWords[oursWord[i]].seg].segment.source;
  const speakerSourceVotes = new Map<number, Record<AudioSourceKind, number>>();
  for (let i = 0; i < N; i++) {
    if ((kind[i] !== PAIR_EXACT && kind[i] !== PAIR_FUZZY) || tokSpeaker[i] < 0) continue;
    const votes = speakerSourceVotes.get(tokSpeaker[i]) ?? { mic: 0, system: 0 };
    votes[sourceOfToken(i)]++;
    speakerSourceVotes.set(tokSpeaker[i], votes);
  }
  const mainSource = (speaker: number): AudioSourceKind | null => {
    const votes = speakerSourceVotes.get(speaker);
    if (!votes || votes.mic + votes.system === 0) return null;
    return votes.mic > votes.system ? 'mic' : 'system';
  };

  const pieces: Piece[] = [];
  let segmentsSplit = 0;
  let outsideTeams = 0;
  let correctionsSpread = 0;
  let correctionsKeptInFirstPiece = 0;

  for (let s = 0; s < sources.length; s++) {
    if (s % 200 === 0) {
      report('speakers', s / sources.length);
      await breathe();
    }
    const { segment, words, synthetic } = sources[s];
    const outside = segment.endMs < coverStart || segment.startMs > coverEnd;
    // The segment's tokens in order, with inferred speakers for unpaired ones.
    const tokens: number[] = [];
    const firstTokenOfWord: number[] = [];
    for (const w of words) {
      firstTokenOfWord.push(tokens.length);
      for (let i = w.tok0; i < w.tok1; i++) tokens.push(i);
    }
    const inferred = new Int32Array(tokens.length).fill(NO_SPEAKER);
    if (!outside) {
      let prevStrong = NO_SPEAKER;
      const nextStrong = new Int32Array(tokens.length).fill(NO_SPEAKER);
      for (let q = tokens.length - 1, next = NO_SPEAKER; q >= 0; q--) {
        nextStrong[q] = next;
        if (tokStrength[tokens[q]] >= STRENGTH_ALIGNED) next = tokSpeaker[tokens[q]];
      }
      for (let q = 0; q < tokens.length; q++) {
        const i = tokens[q];
        if (tokStrength[i] >= STRENGTH_ALIGNED) {
          prevStrong = tokSpeaker[i];
          continue;
        }
        inferred[q] = inferSpeaker(prevStrong, nextStrong[q], coveringTurns(oursMs[i]), oursMs[i], segment.source);
      }
    }
    // Word labels by weighted vote of their tokens.
    const labels: WordLabel[] = words.map((w, k) => {
      const votes = new Map<number, number>();
      let interjection = false;
      let bestStrength = STRENGTH_NONE;
      for (let i = w.tok0; i < w.tok1; i++) {
        const q = firstTokenOfWord[k] + (i - w.tok0);
        const strength = tokStrength[i] >= STRENGTH_ALIGNED ? tokStrength[i] : inferred[q] !== NO_SPEAKER ? STRENGTH_INFERRED : STRENGTH_NONE;
        const speaker = tokStrength[i] >= STRENGTH_ALIGNED ? tokSpeaker[i] : inferred[q];
        if (speaker === NO_SPEAKER) continue;
        votes.set(speaker, (votes.get(speaker) ?? 0) + (strength === STRENGTH_MATCHED ? 1 : strength === STRENGTH_ALIGNED ? 0.5 : 0.25));
      }
      let speaker = NO_SPEAKER;
      let best = 0;
      for (const [candidate, v] of votes) {
        if (v > best) {
          best = v;
          speaker = candidate;
        }
      }
      for (let i = w.tok0; i < w.tok1; i++) {
        if (tokSpeaker[i] !== speaker || tokStrength[i] < STRENGTH_ALIGNED) continue;
        bestStrength = Math.max(bestStrength, tokStrength[i]);
        if (tokInterjection[i]) interjection = true;
      }
      if (speaker !== NO_SPEAKER && bestStrength === STRENGTH_NONE) bestStrength = STRENGTH_INFERRED;
      return { speaker, strength: bestStrength, interjection, startMs: w.startMs, endMs: w.endMs, text: w.text };
    });

    if (outside || labels.every((l) => l.speaker === NO_SPEAKER)) {
      outsideTeams++;
      pieces.push(keptPiece(segment, tokens));
      continue;
    }

    const speakers = snapToPunctuation(labels, smoothSpeakers(labels));
    const runs = speakerRuns(speakers);
    if (runs.length === 1) {
      pieces.push({
        id: segment.id,
        source: segment.source,
        speaker: runs[0].speaker,
        keptSpeakerId: null,
        keptConfidence: null,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
        originalText: segment.originalText,
        words: segment.words,
        tokens,
        teamsOnly: false,
        outside: false,
        from: [segment.id],
      });
      continue;
    }
    segmentsSplit++;
    const pieceOfWord = new Array<number>(words.length);
    runs.forEach((run, p) => {
      for (let k = run.start; k < run.end; k++) pieceOfWord[k] = p;
    });
    let texts = runs.map((run) =>
      words
        .slice(run.start, run.end)
        .map((w) => w.text)
        .join(' '),
    );
    let firstOriginal: string | null = null;
    if (segment.originalText !== null) {
      const spread = splitCorrectedText(
        segment.text,
        words.map((w) => w.text),
        pieceOfWord,
        runs.length,
      );
      if (spread) {
        correctionsSpread++;
        texts = spread;
      } else {
        // The correction cannot be placed word by word: it stays whole in the first piece.
        correctionsKeptInFirstPiece++;
        firstOriginal = segment.originalText;
        texts = [segment.text, ...texts.slice(1)];
      }
    }
    runs.forEach((run, p) => {
      const slice = words.slice(run.start, run.end);
      const recognized = slice.map((w) => w.text).join(' ');
      const text = cleanText(texts[p]);
      const pieceTokens: number[] = [];
      for (const w of slice) for (let i = w.tok0; i < w.tok1; i++) pieceTokens.push(i);
      pieces.push({
        id: `${segment.id}~${p + 1}`,
        source: segment.source,
        speaker: run.speaker,
        keptSpeakerId: null,
        keptConfidence: null,
        startMs: p === 0 ? segment.startMs : slice[0].startMs,
        endMs: p === runs.length - 1 ? segment.endMs : slice[slice.length - 1].endMs,
        text,
        originalText: p === 0 && firstOriginal !== null ? firstOriginal : text !== recognized ? recognized : null,
        words: synthetic ? null : slice.map((w) => ({ text: w.text, startMs: w.startMs, endMs: w.endMs, confidence: w.confidence })),
        tokens: pieceTokens,
        teamsOnly: false,
        outside: false,
        from: [segment.id],
      });
    });
  }

  /**
   * Speaker for one unpaired token: its neighbours' speaker when the Teams turns around agree, else the Teams
   * turn covering its time (preferring speakers heard on the token's own source, then the one with unpaired
   * words nearest in time).
   */
  function inferSpeaker(prev: number, next: number, coveringAll: readonly number[], x: number, source: AudioSourceKind): number {
    const sameSource = coveringAll.filter((t) => {
      const main = mainSource(turnSpeaker[t]);
      return main === null || main === source;
    });
    const covering = sameSource.length > 0 ? sameSource : coveringAll;
    const coveringSpeakers = new Set(covering.map((t) => turnSpeaker[t]));
    const neighbour = prev !== NO_SPEAKER && (next === NO_SPEAKER || next === prev) ? prev : prev === NO_SPEAKER ? next : NO_SPEAKER;
    if (neighbour !== NO_SPEAKER && (coveringSpeakers.size === 0 || coveringSpeakers.has(neighbour))) return neighbour;
    if (coveringSpeakers.size === 1) return [...coveringSpeakers][0];
    if (coveringSpeakers.size > 1) {
      const nearest = nearestUnpairedTeams(covering, x);
      if (nearest !== null) return nearest;
      if (coveringSpeakers.has(prev)) return prev;
      if (coveringSpeakers.has(next)) return next;
      return turnSpeaker[covering[0]];
    }
    return prev !== NO_SPEAKER ? prev : next;
  }

  function keptPiece(segment: MeetingSegment, tokens: number[]): Piece {
    return {
      id: segment.id,
      source: segment.source,
      speaker: NO_SPEAKER,
      keptSpeakerId: segment.speakerId,
      keptConfidence: segment.speakerConfidence,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      originalText: segment.originalText,
      words: segment.words,
      tokens,
      teamsOnly: false,
      outside: true,
      from: [segment.id],
    };
  }

  // ----- 5. Teams-only lines -------------------------------------------------
  const sourceOf = (speaker: number): AudioSourceKind =>
    mainSource(speaker) ?? (original.sources.includes('system') || !original.sources.includes('mic') ? 'system' : 'mic');
  if (options.includeTeamsOnly ?? true) {
    // Our weakly attributed tokens (not matched word for word), for "is this a garbled counterpart?".
    const weakPrefix = new Int32Array(N + 1);
    for (let i = 0; i < N; i++) weakPrefix[i + 1] = weakPrefix[i] + (kind[i] === PAIR_EXACT || kind[i] === PAIR_FUZZY ? 0 : 1);
    const oursFirst = oursMs[0];
    const oursLast = oursMs[N - 1];
    const timelineEnd = Math.max(original.durationMs, oursLast);
    let inserted = 0;
    for (let t = 0; t < turnCount; t++) {
      let runStart = -1;
      for (let j = tt.turnTok0[t]; j <= tt.turnTok1[t]; j++) {
        const free = j < tt.turnTok1[t] && teamsPartner[j] < 0;
        if (free && runStart < 0) runStart = j;
        if (free || runStart < 0) continue;
        const first = runStart;
        const last = j - 1;
        runStart = -1;
        const firstWord = tt.rawWord[first];
        const lastWord = tt.rawWord[last];
        const wordCount = lastWord - firstWord + 1;
        if (wordCount < S.teamsOnlyMinWords) continue;
        const startMs = teamsMs[first];
        const endMs = teamsMs[last] + 400;
        if (startMs < 0 || startMs > timelineEnd || endMs < oursFirst - S.coverageMarginMs || startMs > oursLast + S.coverageMarginMs) continue;
        const weak = weakPrefix[lowerBound(oursMs, endMs + 1000)] - weakPrefix[lowerBound(oursMs, startMs - 1000)];
        if (weak >= 0.5 * (last - first + 1)) continue; // our words there are a garbled version, not missing
        const speaker = turnSpeaker[t];
        const raw = tt.rawWords[t].slice(firstWord, lastWord + 1);
        // Each written word starts at its first token; words without tokens ("—") at the previous word's start.
        const firstToken = new Map<number, number>();
        for (let q = last; q >= first; q--) firstToken.set(tt.rawWord[q], q);
        const wordStarts: number[] = [];
        raw.forEach((_, k) => {
          const q = firstToken.get(firstWord + k);
          wordStarts.push(q !== undefined ? teamsMs[q] : (wordStarts[k - 1] ?? startMs));
        });
        const words: TranscriptWord[] = raw.map((w, k) => ({
          text: w,
          startMs: Math.round(wordStarts[k]),
          endMs: Math.round(k + 1 < raw.length ? wordStarts[k + 1] : endMs),
          confidence: null,
        }));
        pieces.push({
          id: `teams-${++inserted}`,
          source: sourceOf(speaker),
          speaker,
          keptSpeakerId: null,
          keptConfidence: null,
          startMs: Math.round(startMs),
          endMs: Math.round(endMs),
          text: cleanText(raw.join(' ')),
          originalText: null,
          words,
          tokens: [],
          teamsOnly: true,
          outside: false,
          from: [],
        });
      }
    }
  }

  // ----- 6. merge close same-speaker lines ----------------------------------
  pieces.sort((a, b) => compareSegments(a, b));
  const merged: Piece[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    const sameSpeaker =
      last &&
      last.source === piece.source &&
      last.teamsOnly === piece.teamsOnly &&
      last.outside === piece.outside &&
      (piece.outside ? last.keptSpeakerId !== null && last.keptSpeakerId === piece.keptSpeakerId : last.speaker === piece.speaker && piece.speaker >= 0);
    if (
      last &&
      sameSpeaker &&
      piece.startMs - last.endMs <= S.mergeGapMs &&
      Math.max(last.endMs, piece.endMs) - last.startMs <= S.mergeMaxMs
    ) {
      const edited = last.originalText !== null || piece.originalText !== null;
      merged[merged.length - 1] = {
        ...last,
        endMs: Math.max(last.endMs, piece.endMs),
        text: `${last.text} ${piece.text}`,
        originalText: edited ? `${last.originalText ?? last.text} ${piece.originalText ?? piece.text}` : null,
        words: last.words && piece.words ? [...last.words, ...piece.words] : null,
        tokens: [...last.tokens, ...piece.tokens],
        from: [...last.from, ...piece.from],
        keptConfidence: null,
      };
      continue;
    }
    merged.push(piece);
  }

  // ----- 7. speakers, confidence, echo duplicates ----------------------------
  const speakerNames = new Map<string, string>();
  const originalNames = new Map(original.speakers.map((sp) => [sp.id, sp.name]));
  const teamsSpeakerId = (speaker: number, source: AudioSourceKind): string => {
    const id = `${source}-t${speaker + 1}`;
    speakerNames.set(id, teams.speakers[speaker]);
    return id;
  };
  const segments: MeetingSegment[] = [];
  let lowConfidence = 0;
  for (const p of merged) {
    let speakerId: string | null;
    let confidence: number | null;
    let uncertain = false;
    if (p.outside) {
      speakerId = p.keptSpeakerId;
      confidence = p.keptConfidence;
      if (speakerId !== null && !speakerNames.has(speakerId)) speakerNames.set(speakerId, originalNames.get(speakerId) ?? '');
    } else if (p.teamsOnly) {
      speakerId = p.speaker >= 0 ? teamsSpeakerId(p.speaker, p.source) : null;
      confidence = null;
    } else {
      speakerId = p.speaker >= 0 ? teamsSpeakerId(p.speaker, p.source) : null;
      let score = 0;
      let ownTurn = false;
      for (const i of p.tokens) {
        if (partnerSpeaker[i] !== p.speaker || p.speaker < 0) continue;
        score += kind[i] === PAIR_SUB ? 0.5 : 1;
        if (tokInterjection[i]) ownTurn = true;
      }
      let share = p.tokens.length > 0 ? score / p.tokens.length : 0;
      // A line of one or two words ("and", "yes") that only matched inside someone's longer turn is weak evidence:
      // such words occur everywhere. Matching a short turn of its own ("Yeah." as a Teams line) is not.
      if (p.tokens.length <= 2 && !ownTurn) share *= 0.45;
      // A speaker otherwise heard on the other source (a remote participant on the microphone line) is doubtful.
      const heardOn = p.speaker >= 0 ? mainSource(p.speaker) : null;
      if (heardOn !== null && heardOn !== p.source) share *= 0.4;
      confidence = Math.round(share * 1000) / 1000;
      uncertain = confidence < S.lowConfidence;
      if (uncertain) lowConfidence++;
    }
    segments.push({
      id: p.id,
      source: p.source,
      startMs: p.startMs,
      endMs: p.endMs,
      text: p.text,
      words: p.words,
      speakerId,
      speakerConfidence: confidence,
      echoOf: null,
      speakerManual: false,
      originalText: p.originalText,
      ...(p.teamsOnly ? { origin: 'teams' as const } : {}),
      ...(uncertain ? { speakerUncertain: true } : {}),
    });
  }
  // Echo duplicates stay hidden, pointing at the line that now holds their call-audio words.
  for (const segment of original.segments) {
    if (segment.echoOf === null) continue;
    const holders = merged.filter((p) => p.from.includes(segment.echoOf as string));
    let target = segment.echoOf;
    let bestOverlap = -Infinity;
    for (const h of holders) {
      const overlap = Math.min(h.endMs, segment.endMs) - Math.max(h.startMs, segment.startMs);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        target = h.id;
      }
    }
    segments.push({ ...segment, echoOf: target, speakerId: null, speakerConfidence: null });
  }
  segments.sort(compareSegments);

  // Speaker numbers in order of first appearance; names from Teams (lines outside it keep their earlier speaker).
  const speakers: MeetingSpeaker[] = [];
  const known = new Set<string>();
  for (const segment of segments) {
    const id = segment.speakerId;
    if (id === null || segment.echoOf !== null || known.has(id)) continue;
    known.add(id);
    const number = speakers.length + 1;
    speakers.push({ id, name: speakerNames.get(id) || `Speaker ${number}`, source: segment.source, number });
  }

  const now = options.now ?? new Date();
  let matched = 0;
  let aligned = 0;
  for (let i = 0; i < N; i++) {
    if (kind[i] === PAIR_EXACT || kind[i] === PAIR_FUZZY) matched++;
    if (kind[i] !== PAIR_NONE) aligned++;
  }
  const tBuilt = clock();
  const refinement: TranscriptRefinement = {
    source: 'teams',
    fromTranscriptId: original.id,
    fromTitle: original.title,
    fileName: teams.fileName,
    input: teams.input,
    turns: teams.turns.length,
    speakers: teams.speakers.length,
    clockTimes: teams.clockTimes,
    offsetMs: Math.round(fit.model.offsetMs),
    driftMsPerHour: Math.round(fit.model.driftPerMs * 3_600_000),
    anchorsUsed: chain.length,
    anchorsFound: anchors.length,
    wordsMatched: Math.round((matched / N) * 1000) / 1000,
    wordsAligned: Math.round((aligned / N) * 1000) / 1000,
    segmentsSplit,
    teamsOnlyInserted: segments.filter((s) => s.origin === 'teams').length,
    lowConfidence,
    outsideTeams,
    correctionsSpread,
    correctionsKeptInFirstPiece,
    elapsedMs: Math.round(tBuilt - started),
    refinedAt: now.toISOString(),
  };
  const transcript: MeetingTranscript = {
    ...original,
    id: options.id,
    title: refinedTitle(original.title),
    updatedAt: now.toISOString(),
    speakers,
    segments,
    refinement,
  };
  report('speakers', 1);
  return {
    transcript,
    refinement,
    diagnostics: {
      oursTokens: N,
      teamsTokens: M,
      anchorCandidates: anchors.length,
      anchorInliers: fit.inliers.length,
      chain: chain.length,
      windowMs,
      cells: pass1.cells,
      timingsMs: {
        prepare: Math.round(tPrepared - started),
        anchors: Math.round(tAnchors - tPrepared),
        align: Math.round(tAligned - tAnchors),
        build: Math.round(tBuilt - tAligned),
      },
    },
  };
}

/**
 * Gives the page a turn (rendering, input) between chunks of work: scheduler.yield() where the browser has it,
 * else a message-channel task (not throttled like setTimeout in a background tab).
 */
export function yieldToPage(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler && typeof scheduler.yield === 'function') return scheduler.yield();
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** DP cells a band of ±windowMs needs (to keep memory bounded on very dense transcripts). */
export function estimateCells(oursMs: ArrayLike<number>, teamsMs: ArrayLike<number>, windowMs: number): number {
  let cells = 0;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < oursMs.length; i++) {
    while (lo < teamsMs.length && teamsMs[lo] < oursMs[i] - windowMs) lo++;
    if (hi < lo) hi = lo;
    while (hi < teamsMs.length && teamsMs[hi] <= oursMs[i] + windowMs) hi++;
    cells += hi - lo + 2;
  }
  return cells;
}

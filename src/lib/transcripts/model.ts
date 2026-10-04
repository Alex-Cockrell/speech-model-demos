/**
 * Pure transcript operations for the meeting mode. OWNER: meeting agent.
 *
 * A TranscriptDoc is the transcript plus the speaker registry behind it. Every function returns a new document
 * (or the same one when nothing changed) and never mutates its input, so React can compare by identity.
 *
 * Speaker numbering: a speaker id gets the next number the first time it is shown ('Speaker 1', 'Speaker 2', …,
 * one sequence across microphone and call audio) and keeps it. Numbers are never reused or renumbered, so a
 * label never silently starts meaning someone else; merges and re-identification can leave gaps.
 */
import type { AudioSourceKind, ModelSummary } from '../types';
import type { MeetingSegment, MeetingSpeaker, MeetingTranscript } from './types';

export interface SpeakerRegistry {
  /** Every speaker shown in this transcript so far, also ones that currently have no lines: names and numbers stay with their ids. */
  known: Readonly<Record<string, MeetingSpeaker>>;
  /** Ids the user merged away → the id they were merged into (kept resolved, never a chain). Engine results are mapped through it. */
  aliases: Readonly<Record<string, string>>;
  nextNumber: number;
}

export interface TranscriptDoc {
  /** segments sorted by compareSegments; speakers = the registry entries that have visible lines, by number. */
  transcript: MeetingTranscript;
  registry: SpeakerRegistry;
}

/** One automatic speaker decision (same shape as SpeakerAssignment from the speaker engine). */
export interface AssignmentInput {
  segmentId: string;
  speakerId: string | null;
  confidence: number | null;
}

/** Reassignment target: a speaker id, null for "Unknown", or a new speaker for this line's source. */
export type SpeakerTarget = string | null | { newSpeaker: true };

export const UNKNOWN_SPEAKER = 'Unknown';
const MAX_NAME_LENGTH = 60;

export function defaultSpeakerName(n: number): string {
  return `Speaker ${n}`;
}

const SOURCE_RANK: Record<AudioSourceKind, number> = { mic: 0, system: 1 };

/** Timeline order: start time, then microphone before call audio, then id (stable for equal starts). */
export function compareSegments(
  a: Pick<MeetingSegment, 'startMs' | 'source' | 'id'>,
  b: Pick<MeetingSegment, 'startMs' | 'source' | 'id'>,
): number {
  return a.startMs - b.startMs || SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** First index whose element sorts after `item` (binary search). */
function insertionIndex(segments: readonly MeetingSegment[], item: MeetingSegment): number {
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareSegments(segments[mid], item) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function cleanName(name: string): string {
  return cleanText(name).slice(0, MAX_NAME_LENGTH).trim();
}

/** Speakers that have at least one visible (non-echo) line, by number. */
function activeSpeakers(segments: readonly MeetingSegment[], registry: SpeakerRegistry): MeetingSpeaker[] {
  const ids = new Set<string>();
  for (const s of segments) if (s.speakerId !== null && s.echoOf === null) ids.add(s.speakerId);
  const speakers: MeetingSpeaker[] = [];
  for (const id of ids) {
    const known = registry.known[id];
    if (known) speakers.push(known);
  }
  return speakers.sort((a, b) => a.number - b.number);
}

function sameSpeakers(a: readonly MeetingSpeaker[], b: readonly MeetingSpeaker[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

function finish(doc: TranscriptDoc, segments: MeetingSegment[], registry: SpeakerRegistry): TranscriptDoc {
  const computed = activeSpeakers(segments, registry);
  const speakers = sameSpeakers(computed, doc.transcript.speakers) ? doc.transcript.speakers : computed;
  return { registry, transcript: { ...doc.transcript, segments, speakers } };
}

function resolveAlias(registry: SpeakerRegistry, id: string): string {
  return registry.aliases[id] ?? id;
}

/** Registers `id` (next number, default name) unless it is known already. */
function ensureSpeaker(registry: SpeakerRegistry, id: string, source: AudioSourceKind): SpeakerRegistry {
  if (registry.known[id]) return registry;
  const number = registry.nextNumber;
  const speaker: MeetingSpeaker = { id, name: defaultSpeakerName(number), source, number };
  return { ...registry, known: { ...registry.known, [id]: speaker }, nextNumber: number + 1 };
}

function indexOfSegment(doc: TranscriptDoc, segmentId: string): number {
  return doc.transcript.segments.findIndex((s) => s.id === segmentId);
}

export function findSegment(doc: TranscriptDoc, segmentId: string): MeetingSegment | null {
  return doc.transcript.segments.find((s) => s.id === segmentId) ?? null;
}

function replaceSegment(doc: TranscriptDoc, index: number, segment: MeetingSegment, registry = doc.registry): TranscriptDoc {
  const segments = doc.transcript.segments.slice();
  segments[index] = segment;
  return finish(doc, segments, registry);
}

// ---------------------------------------------------------------------------
// Creating documents
// ---------------------------------------------------------------------------

export interface NewTranscriptInit {
  id: string;
  title: string;
  /** ISO */
  createdAt: string;
  sources: AudioSourceKind[];
  models: { asr: ModelSummary | null; speaker: ModelSummary | null };
  app: { version: string; commit: string | null };
}

export function createDoc(init: NewTranscriptInit): TranscriptDoc {
  return {
    transcript: {
      schemaVersion: 1,
      id: init.id,
      title: init.title,
      createdAt: init.createdAt,
      updatedAt: init.createdAt,
      durationMs: 0,
      sources: [...init.sources],
      speakers: [],
      segments: [],
      stats: null,
      models: init.models,
      app: init.app,
    },
    registry: { known: {}, aliases: {}, nextNumber: 1 },
  };
}

/** A saved transcript as an editable document (no aliases: those only matter while the speaker engine still runs). */
export function docFromTranscript(transcript: MeetingTranscript): TranscriptDoc {
  const known: Record<string, MeetingSpeaker> = {};
  let nextNumber = 1;
  for (const s of transcript.speakers) {
    known[s.id] = s;
    nextNumber = Math.max(nextNumber, s.number + 1);
  }
  let registry: SpeakerRegistry = { known, aliases: {}, nextNumber };
  const segments = [...transcript.segments].sort(compareSegments);
  // A line pointing at a speaker the list lacks (hand-edited JSON, older data) still gets a name.
  for (const s of segments) if (s.speakerId !== null) registry = ensureSpeaker(registry, s.speakerId, s.source);
  return finish({ transcript: { ...transcript, speakers: [] }, registry }, segments, registry);
}

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

/** Inserts a finalized segment at its place on the timeline (replaces a segment with the same id). */
export function addSegment(doc: TranscriptDoc, segment: MeetingSegment): TranscriptDoc {
  const segments = doc.transcript.segments.filter((s) => s.id !== segment.id);
  segments.splice(insertionIndex(segments, segment), 0, segment);
  let registry = doc.registry;
  if (segment.speakerId !== null) registry = ensureSpeaker(registry, segment.speakerId, segment.source);
  return finish(doc, segments, registry);
}

/** Applies one automatic speaker decision. Lines set by hand and echo duplicates keep what they have. */
export function applyAssignment(doc: TranscriptDoc, a: AssignmentInput): TranscriptDoc {
  const index = indexOfSegment(doc, a.segmentId);
  if (index < 0) return doc;
  const segment = doc.transcript.segments[index];
  if (segment.speakerManual || segment.echoOf !== null) return doc;
  const speakerId = a.speakerId === null ? null : resolveAlias(doc.registry, a.speakerId);
  const confidence = speakerId === null ? null : a.confidence;
  const registry = speakerId === null ? doc.registry : ensureSpeaker(doc.registry, speakerId, segment.source);
  if (segment.speakerId === speakerId && segment.speakerConfidence === confidence && registry === doc.registry) return doc;
  return replaceSegment(doc, index, { ...segment, speakerId, speakerConfidence: confidence }, registry);
}

/**
 * Applies a re-identification (recluster) result. Ids that survive keep their numbers and user-given names;
 * new ids are numbered in order of their first line; merged-away ids still map to their merge target.
 * Lines set by hand and echo duplicates are left alone; segments missing from the result keep their speaker.
 */
export function applyRecluster(doc: TranscriptDoc, assignments: readonly AssignmentInput[]): TranscriptDoc {
  const byId = new Map(assignments.map((a) => [a.segmentId, a]));
  let registry = doc.registry;
  let changed = false;
  const segments = doc.transcript.segments.map((segment) => {
    const a = byId.get(segment.id);
    if (!a || segment.speakerManual || segment.echoOf !== null) return segment;
    const speakerId = a.speakerId === null ? null : resolveAlias(registry, a.speakerId);
    if (speakerId !== null) registry = ensureSpeaker(registry, speakerId, segment.source);
    const confidence = speakerId === null ? null : a.confidence;
    if (segment.speakerId === speakerId && segment.speakerConfidence === confidence) return segment;
    changed = true;
    return { ...segment, speakerId, speakerConfidence: confidence };
  });
  if (!changed && registry === doc.registry) return doc;
  return finish(doc, changed ? segments : doc.transcript.segments.slice(), registry);
}

/** Marks a microphone line as an echo duplicate of a call line (or clears the mark). An echo line has no speaker. */
export function markEcho(doc: TranscriptDoc, segmentId: string, echoOf: string | null): TranscriptDoc {
  const index = indexOfSegment(doc, segmentId);
  if (index < 0) return doc;
  const segment = doc.transcript.segments[index];
  if (segment.echoOf === echoOf) return doc;
  const next: MeetingSegment =
    echoOf === null
      ? { ...segment, echoOf: null }
      : { ...segment, echoOf, speakerId: null, speakerConfidence: null, speakerManual: false };
  return replaceSegment(doc, index, next);
}

// ---------------------------------------------------------------------------
// User edits
// ---------------------------------------------------------------------------

/** Renames a speaker everywhere. An empty name restores the default 'Speaker N'. */
export function renameSpeaker(doc: TranscriptDoc, speakerId: string, name: string): TranscriptDoc {
  const speaker = doc.registry.known[speakerId];
  if (!speaker) return doc;
  const clean = cleanName(name) || defaultSpeakerName(speaker.number);
  if (clean === speaker.name) return doc;
  const registry: SpeakerRegistry = { ...doc.registry, known: { ...doc.registry.known, [speakerId]: { ...speaker, name: clean } } };
  return finish(doc, doc.transcript.segments.slice(), registry);
}

/**
 * Moves every line of `fromId` to `intoId` (same source only: clustering never mixes sources) and remembers
 * the merge, so later automatic results for `fromId` land on `intoId` too. `intoId` keeps its name and number.
 */
export function mergeSpeakers(doc: TranscriptDoc, fromId: string, intoId: string): TranscriptDoc {
  const { known } = doc.registry;
  const from = known[fromId];
  const into = known[intoId];
  if (fromId === intoId || !from || !into || from.source !== into.source) return doc;
  const segments = doc.transcript.segments.map((s) => (s.speakerId === fromId ? { ...s, speakerId: intoId, speakerConfidence: null } : s));
  const aliases: Record<string, string> = {};
  for (const [id, target] of Object.entries(doc.registry.aliases)) aliases[id] = target === fromId ? intoId : target;
  aliases[fromId] = intoId;
  return finish(doc, segments, { ...doc.registry, aliases });
}

function newSpeakerId(registry: SpeakerRegistry, source: AudioSourceKind): string {
  for (let n = 1; ; n++) {
    const id = `${source}-u${n}`;
    if (!registry.known[id] && !registry.aliases[id]) return id;
  }
}

/**
 * Sets the speaker of one line by hand (another speaker of the same source, a new speaker, or Unknown).
 * The choice sticks: re-identification leaves it alone. A line reassigned this way is no longer treated as an echo
 * and no longer marked "speaker uncertain".
 */
export function reassignSegment(doc: TranscriptDoc, segmentId: string, target: SpeakerTarget): TranscriptDoc {
  const index = indexOfSegment(doc, segmentId);
  if (index < 0) return doc;
  const segment = doc.transcript.segments[index];
  let registry = doc.registry;
  let speakerId: string | null;
  if (target === null) {
    speakerId = null;
  } else if (typeof target === 'object') {
    speakerId = newSpeakerId(registry, segment.source);
    registry = ensureSpeaker(registry, speakerId, segment.source);
  } else {
    const speaker = registry.known[target];
    if (!speaker || speaker.source !== segment.source) return doc;
    speakerId = speaker.id;
  }
  if (segment.speakerId === speakerId && segment.speakerManual && segment.echoOf === null) return doc;
  // A speaker chosen by hand is no longer uncertain (refined transcripts).
  const { speakerUncertain: _uncertain, ...rest } = segment;
  return replaceSegment(doc, index, { ...rest, speakerId, speakerConfidence: null, speakerManual: true, echoOf: null }, registry);
}

/**
 * Corrects the text of one line. Whitespace is collapsed; empty text is ignored. The first correction keeps the
 * recognized text in originalText (words keep the recognized timing); editing back to it clears the mark.
 */
export function editSegmentText(doc: TranscriptDoc, segmentId: string, text: string): TranscriptDoc {
  const index = indexOfSegment(doc, segmentId);
  if (index < 0) return doc;
  const segment = doc.transcript.segments[index];
  const clean = cleanText(text);
  if (!clean || clean === segment.text) return doc;
  const original = segment.originalText ?? segment.text;
  return replaceSegment(doc, index, { ...segment, text: clean, originalText: clean === original ? null : original });
}

/** Sets the title; an empty title is ignored. */
export function setTitle(doc: TranscriptDoc, title: string): TranscriptDoc {
  const clean = cleanTitle(title);
  if (!clean || clean === doc.transcript.title) return doc;
  return { ...doc, transcript: { ...doc.transcript, title: clean } };
}

export function cleanTitle(title: string): string {
  return cleanText(title).slice(0, 120).trim();
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function visibleSegments(segments: readonly MeetingSegment[], showEcho: boolean): readonly MeetingSegment[] {
  return showEcho ? segments : segments.filter((s) => s.echoOf === null);
}

export function echoCount(segments: readonly MeetingSegment[]): number {
  let n = 0;
  for (const s of segments) if (s.echoOf !== null) n++;
  return n;
}

export interface SpeakerUsage {
  lines: number;
  talkMs: number;
}

/** Lines and speaking time per speaker id ('' = Unknown), over visible lines. */
export function speakerUsage(segments: readonly MeetingSegment[]): Map<string, SpeakerUsage> {
  const usage = new Map<string, SpeakerUsage>();
  for (const s of segments) {
    if (s.echoOf !== null) continue;
    const key = s.speakerId ?? '';
    const u = usage.get(key) ?? { lines: 0, talkMs: 0 };
    usage.set(key, { lines: u.lines + 1, talkMs: u.talkMs + Math.max(0, s.endMs - s.startMs) });
  }
  return usage;
}

/** Display name of a line's speaker. */
export function speakerName(registry: SpeakerRegistry, speakerId: string | null): string {
  return speakerId === null ? UNKNOWN_SPEAKER : (registry.known[speakerId]?.name ?? UNKNOWN_SPEAKER);
}

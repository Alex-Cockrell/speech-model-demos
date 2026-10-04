/**
 * Meeting transcripts as the meeting mode keeps, saves and exports them. OWNER: meeting agent.
 *
 * These extend the shared contracts in ../types (a MeetingTranscript is a valid Transcript); the extra fields
 * carry what the meeting UI needs on top: echo duplicates, hand-made speaker choices, text corrections and the
 * speaker numbering behind the default names and colors.
 */
import type { AudioSourceKind, Transcript, TranscriptSegment, TranscriptSpeaker } from '../types';

export interface MeetingSegment extends TranscriptSegment {
  /**
   * Microphone segments only: the call-audio segment this one repeats because the microphone picked the call up
   * from the laptop's speakers. Such lines are hidden by default and never sent to speaker clustering.
   */
  echoOf: string | null;
  /** The speaker was chosen by hand: re-identification and late automatic assignments leave it alone. */
  speakerManual: boolean;
  /** Recognized text before the user's first correction; null while the text is untouched. */
  originalText: string | null;
  /**
   * 'teams': a line inserted from the Teams transcript where our recording has no words (usually people talking
   * over each other). Its text and timing are Teams'. Absent on our own lines.
   */
  origin?: 'teams';
  /** Refined lines only: few of the line's words matched the speaker's words in the Teams transcript. */
  speakerUncertain?: boolean;
}

/** Input layouts of a Teams transcript (see lib/transcripts/teams/types.ts). */
export type RefinementInputKind = 'paste' | 'txt' | 'vtt' | 'docx';

/** How a transcript was refined with a Teams transcript (stored on the refined copy; the original is untouched). */
export interface TranscriptRefinement {
  source: 'teams';
  /** The transcript this copy was made from. */
  fromTranscriptId: string;
  fromTitle: string;
  /** The opened file's name; null when the Teams transcript was pasted. */
  fileName: string | null;
  input: RefinementInputKind;
  turns: number;
  /** Speaker names in the Teams transcript. */
  speakers: number;
  /** Teams times are times of day (10:32 AM) rather than offsets from the start of the Teams transcript. */
  clockTimes: boolean;
  /** Our time = Teams time + offsetMs (+ drift): where the Teams timeline's 0:00 falls on this recording. */
  offsetMs: number;
  /** Clock drift between the two timelines, in ms per hour of meeting (0 when not measurable). */
  driftMsPerHour: number;
  /** Passages (word triples found once in each transcript) that agree on the offset, and all such passages. */
  anchorsUsed: number;
  anchorsFound: number;
  /** Share of our words matched to a Teams word (exactly or nearly). */
  wordsMatched: number;
  /** Share of our words paired with a Teams word at the same place (matched, or a different word). */
  wordsAligned: number;
  /** Our lines split because the speaker changes inside them. */
  segmentsSplit: number;
  /** Lines inserted from the Teams transcript (words our recording does not have). */
  teamsOnlyInserted: number;
  lowConfidence: number;
  /** Lines outside the time the Teams transcript covers: they keep their earlier speaker. */
  outsideTeams: number;
  /** Corrected lines that were split: spread over the pieces, or (when that was impossible) kept in the first piece. */
  correctionsSpread: number;
  correctionsKeptInFirstPiece: number;
  elapsedMs: number;
  /** ISO */
  refinedAt: string;
}

export interface MeetingSpeaker extends TranscriptSpeaker {
  /** 1-based order of first appearance in the meeting, one sequence across sources. Picks the default name and the color; never reused. */
  number: number;
}

export interface MeetingTranscript extends Transcript {
  /** Speakers that have at least one visible line, by number. */
  speakers: MeetingSpeaker[];
  /** Ordered by startMs (then source, then id). */
  segments: MeetingSegment[];
  /** Present on a copy refined with a Teams transcript. */
  refinement?: TranscriptRefinement;
}

/**
 * 'recording'   → saved while the meeting runs (every ~10 s); stays so if the page closes mid-meeting.
 * 'complete'    → saved after Stop.
 * 'interrupted' → a 'recording' transcript that was opened and edited after its meeting was cut off.
 */
export type TranscriptStatus = 'recording' | 'complete' | 'interrupted';

/** What the saved list shows; stored next to each transcript so listing never reads whole transcripts. */
export interface TranscriptSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  sources: AudioSourceKind[];
  /** Speakers with at least one visible line. */
  speakerCount: number;
  /** Visible lines (echo duplicates excluded). */
  segmentCount: number;
  /** Hidden echo duplicates (the export controls offer to include them). */
  echoLines: number;
  status: TranscriptStatus;
  /** Date.now() of the last save. A 'recording' entry that stopped being saved belongs to a meeting that was cut off. */
  savedAtMs: number;
  /** A copy refined with a Teams transcript (absent otherwise). */
  refined?: boolean;
  /** Lines inserted from the Teams transcript (the export controls offer to leave them out); absent when none. */
  teamsLines?: number;
}

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
}

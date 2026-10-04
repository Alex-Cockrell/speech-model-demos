/**
 * A Microsoft Teams transcript as the refinement reads it. OWNER: meeting agent.
 *
 * Teams hears every participant's microphone separately, so its speaker names are right even when its words are
 * not; our transcript has the better words. Whatever form the Teams transcript arrives in (pasted from the
 * transcript pane, a downloaded .docx or .vtt, a .txt), the parsers reduce it to turns: who spoke, from when, what.
 */

import type { RefinementInputKind } from '../types';

/** How the Teams transcript came in: pasted, or a .txt, .vtt or .docx file. */
export type TeamsInputKind = RefinementInputKind;

/**
 * Which layout the text had:
 *   'speaker-time'  → "Alice Smith   0:03" (or name and time on two lines) followed by the text: the transcript
 *                     pane, the current .docx download, text copied from it.
 *   'timed-blocks'  → "0:0:3.120 --> 0:0:7.880", then the name, then the text: the older .docx download.
 *   'webvtt'        → the .vtt download: cues with <v Speaker Name> voice tags.
 */
export type TeamsLayout = 'speaker-time' | 'timed-blocks' | 'webvtt';

export interface TeamsTurn {
  /** As Teams shows it; '' when the transcript names nobody for this line. */
  speaker: string;
  /** On the Teams timeline: from the transcript's 0:00, or the time of day when it shows clock times. */
  startMs: number;
  /** Only cues (.vtt, timed blocks) have an end; the speaker + time layout only says when a turn starts. */
  endMs: number | null;
  text: string;
}

export interface ParsedTeamsTranscript {
  input: TeamsInputKind;
  /** null when nothing could be read. */
  layout: TeamsLayout | null;
  /** In transcript order (times never go backwards, see warnings). */
  turns: TeamsTurn[];
  /** Distinct non-empty speaker names, in order of first appearance. */
  speakers: string[];
  /** Plain-language notes about what was skipped or repaired. */
  warnings: string[];
  /** The times are times of day (e.g. "10:32 AM"), not offsets from the start of the transcript. */
  clockTimes: boolean;
  /** Precision of the turn times: 1000 for m:ss, 60000 for clock times without seconds, 1 for cue times. */
  timeResolutionMs: number;
  fileName: string | null;
  /** The meeting title line of a .docx header, when there is one. */
  title: string | null;
}

/** A parse that found nothing (input kind and file name kept for the message). */
export function emptyParse(input: TeamsInputKind, fileName: string | null, warnings: string[] = []): ParsedTeamsTranscript {
  return { input, layout: null, turns: [], speakers: [], warnings, clockTimes: false, timeResolutionMs: 1000, fileName, title: null };
}

/** Distinct non-empty names in order of first appearance. */
export function speakersOf(turns: readonly TeamsTurn[]): string[] {
  const seen = new Set<string>();
  for (const t of turns) if (t.speaker) seen.add(t.speaker);
  return [...seen];
}

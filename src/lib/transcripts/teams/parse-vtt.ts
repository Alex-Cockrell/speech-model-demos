/**
 * Cue layouts of a Teams transcript. OWNER: meeting agent.
 *
 * The .vtt download (WebVTT):
 *
 *   WEBVTT
 *
 *   91b3f3c3-44c6-4a8b-8c0a-add105d816bd/32-0
 *   00:00:10.087 --> 00:00:13.130
 *   <v John Smith>Hello, I am the interviewer.</v>
 *
 * Cue ids are a GUID with "/n-n" (older files: none or numbers), the closing </v> is sometimes missing, a cue
 * can span several lines, and consecutive cues often have the same speaker. Before 2023, times were written
 * "0:0:3.120 --> 0:0:7.880".
 *
 * The older .docx download used the same timing lines, then the speaker's name, then the text:
 *
 *   0:0:0.0 --> 0:0:1.250
 *   Jane Doe
 *   Hi I'm Jane Doe, CEO
 *
 * Other tools' WebVTT ("Alice Smith: text" in the cue) is read too when the prefix recurs.
 */
import { cleanText } from '../model';
import { dropRepeatedTurns, isNameLike, isSystemLine as isSystemLineLike, makeTimesMonotonic } from './parse-text';
import { emptyParse, speakersOf, type ParsedTeamsTranscript, type TeamsInputKind, type TeamsTurn } from './types';

const TS = String.raw`(?:\d{1,3}:)?\d{1,3}:\d{1,2}(?:[.,]\d{1,3})?`;
export const TIMING_RE = new RegExp(`^\\s*(${TS})\\s*-->\\s*(${TS})(?:\\s.*)?$`);

/** "00:00:10.087", "0:0:2.90", "01:02.5" → ms */
export function parseCueTime(text: string): number | null {
  const parts = text.trim().replace(',', '.').split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const sec = Number(parts[parts.length - 1]);
  const min = Number(parts[parts.length - 2]);
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (![sec, min, hours].every(Number.isFinite) || sec >= 60 || min < 0 || hours < 0) return null;
  return Math.round(((hours * 60 + min) * 60 + sec) * 1000);
}

/** WebVTT text: tags removed, the usual character references decoded. */
function decodeCueText(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lrm;|&rlm;/g, '')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

interface Cue {
  startMs: number;
  endMs: number;
  lines: string[];
}

/** Looks like a cue identifier rather than text: a GUID (with Teams' "/32-0"), a number, "n-n". */
function looksLikeCueId(line: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/\d+-\d+)?$/i.test(line) || /^\d+(?:-\d+)?$/.test(line);
}

/**
 * In WebVTT a blank line ends a cue. In text from a .docx (timed blocks) empty paragraphs can sit anywhere, so
 * there a cue runs until the next timing line.
 */
function readCues(text: string, blankEndsCue: boolean): Cue[] {
  const lines = text.split('\n');
  const cues: Cue[] = [];
  let current: Cue | null = null;
  let inNote = false;
  for (const raw of lines) {
    const line = raw.trim();
    const timing = TIMING_RE.exec(line);
    if (timing) {
      const startMs = parseCueTime(timing[1]);
      const endMs = parseCueTime(timing[2]);
      // A cue id written without a blank line before it ended up in the previous cue's text.
      if (current && current.lines.length > 0 && looksLikeCueId(current.lines[current.lines.length - 1])) current.lines.pop();
      inNote = false;
      current = startMs === null || endMs === null ? null : { startMs, endMs: Math.max(startMs, endMs), lines: [] };
      if (current) cues.push(current);
      continue;
    }
    if (line === '') {
      if (blankEndsCue) current = null;
      inNote = false;
      continue;
    }
    if (current && !blankEndsCue && isSystemLineLike(line)) continue;
    if (!current) {
      if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(line)) inNote = true;
      continue; // header, cue ids, notes
    }
    if (!inNote) current.lines.push(line);
  }
  return cues;
}

/** Voice spans of one cue: "<v A>hi</v> <v B>yes</v>" → two; no voice tag → one with speaker null. */
function voiceSpans(payload: string): { speaker: string | null; text: string }[] {
  const re = /<v(?:\.[^\s>]*)*(?:\s+([^>]*))?>/g;
  const spans: { speaker: string | null; text: string }[] = [];
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  let speaker: string | null = null;
  let any = false;
  while ((m = re.exec(payload))) {
    const before = payload.slice(lastIndex, m.index);
    if (any || before.trim()) spans.push({ speaker, text: before });
    speaker = cleanText(decodeCueText(m[1] ?? ''));
    lastIndex = m.index + m[0].length;
    any = true;
  }
  spans.push({ speaker, text: payload.slice(lastIndex) });
  return spans
    .map((s) => ({ speaker: s.speaker, text: cleanText(decodeCueText(s.text)) }))
    .filter((s) => s.text !== '');
}

/**
 * Parses WebVTT or the older timed-block layout. `text` must already be normalized (normalizeInputText).
 * Returns null when there are no timing lines at all.
 */
export function parseCueText(text: string, input: TeamsInputKind, fileName: string | null): ParsedTeamsTranscript | null {
  const hasVoices = /<v[\s.>]/.test(text);
  const isWebVtt = /^\s*WEBVTT/.test(text) || hasVoices;
  const cues = readCues(text, /^\s*WEBVTT/.test(text));
  if (cues.length === 0) return null;
  const warnings: string[] = [];

  // Without voice tags: is the first line of a multi-line cue a speaker name (old .docx), or does the text start
  // with "Name: " (other tools)? Only names that recur count, so a short first line of text is not taken for one.
  const firstLines = new Map<string, number>();
  const prefixes = new Map<string, number>();
  if (!hasVoices) {
    for (const cue of cues) {
      if (cue.lines.length >= 2 && isNameLike(cleanText(cue.lines[0]), false)) {
        firstLines.set(cue.lines[0], (firstLines.get(cue.lines[0]) ?? 0) + 1);
      }
      const prefix = /^([^:]{1,64}):\s+\S/.exec(cue.lines.join(' '));
      if (prefix && isNameLike(prefix[1].trim(), true)) prefixes.set(prefix[1].trim(), (prefixes.get(prefix[1].trim()) ?? 0) + 1);
    }
  }
  // A name that recurs establishes the layout; then every name-like first line (or prefix) counts, as long as
  // most cues have one.
  const multiLine = cues.filter((c) => c.lines.length >= 2).length;
  const accepted = (counts: Map<string, number>, eligible: number): Set<string> => {
    const total = [...counts.values()].reduce((s, n) => s + n, 0);
    const recurs = [...counts.values()].some((n) => n >= 2);
    return new Set((recurs && total >= eligible * 0.6) || cues.length <= 2 ? counts.keys() : []);
  };
  const nameLines = accepted(firstLines, multiLine);
  const namePrefixes = accepted(prefixes, cues.length);

  let turns: TeamsTurn[] = [];
  let unnamed = 0;
  for (const cue of cues) {
    if (hasVoices) {
      for (const span of voiceSpans(cue.lines.join('\n'))) {
        if (!span.speaker) unnamed++;
        turns.push({ speaker: span.speaker ?? '', startMs: cue.startMs, endMs: cue.endMs, text: span.text });
      }
      continue;
    }
    let speaker = '';
    let body = cue.lines;
    if (cue.lines.length >= 2 && nameLines.has(cue.lines[0])) {
      speaker = cleanText(cue.lines[0]);
      body = cue.lines.slice(1);
    }
    let joined = cleanText(decodeCueText(body.join(' ')));
    if (!speaker) {
      const prefix = /^([^:]{1,64}):\s+(.*)$/.exec(joined);
      if (prefix && namePrefixes.has(prefix[1].trim())) {
        speaker = prefix[1].trim();
        joined = prefix[2];
      }
    }
    if (!joined) continue;
    if (!speaker) unnamed++;
    turns.push({ speaker, startMs: cue.startMs, endMs: cue.endMs, text: joined });
  }
  if (turns.length === 0) return emptyParse(input, fileName);

  warnings.push(...makeTimesMonotonic(turns, false));
  const repeats = dropRepeatedTurns(turns);
  turns = repeats.turns;
  if (repeats.dropped > 0) warnings.push(`${repeats.dropped} repeated line${repeats.dropped === 1 ? ' was' : 's were'} dropped.`);
  if (unnamed > 0) {
    warnings.push(
      unnamed === turns.length
        ? 'No speaker names were found, so speakers cannot be taken from this transcript.'
        : `${unnamed} line${unnamed === 1 ? ' has' : 's have'} no speaker name.`,
    );
  }
  return {
    input,
    layout: isWebVtt ? 'webvtt' : 'timed-blocks',
    turns,
    speakers: speakersOf(turns),
    warnings,
    clockTimes: false,
    timeResolutionMs: 1,
    fileName,
    title: null,
  };
}

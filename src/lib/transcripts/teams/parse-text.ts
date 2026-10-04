/**
 * The "speaker + time" layout of a Teams transcript: what the transcript pane puts on the clipboard (new Teams,
 * Recap → Transcript, the in-meeting pane, Teams on the web) and what the current .docx download contains.
 * OWNER: meeting agent.
 *
 * Every turn starts with a header naming the speaker and when the turn starts; the text follows until the next
 * header. Seen in the wild (see the report for sources):
 *
 *   Jason Helmick   1:49              .docx and text copied from it: name, three spaces, m:ss (h:mm:ss after an hour)
 *   Alice Smith                       transcript pane: name and time on separate lines, often an avatar line ("AS")
 *   0:03                              before the name
 *   Alice Smith 3 minutes 5 seconds   screen-reader text copied along with the visible time (glued or not):
 *   3:05                              "Alice Smith 3 minutes 5 seconds3:05"
 *   [0:03] Alice Smith: text          what transcript scrapers (and this app's own text export) write
 *
 * plus a header block (title, date, duration), "Alice Smith started transcription" / "stopped transcription"
 * lines, blank lines and names such as "Sydney Smith (She/Her)", "Michael Greene (POWERSHELL)" or "MC 4-800".
 * When in doubt a line is text: a header needs a recognizable time next to a name-like line.
 */
import { cleanText } from '../model';
import { emptyParse, speakersOf, type ParsedTeamsTranscript, type TeamsInputKind, type TeamsTurn } from './types';

// ---------------------------------------------------------------------------
// Text cleanup and times
// ---------------------------------------------------------------------------

/** BOM, Windows line ends, non-breaking spaces, zero-width and bidi marks (Teams and Word sprinkle them in). */
export function normalizeInputText(text: string): string {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[   ]/g, ' ')
    .replace(/[​-‍⁠﻿‎‏‪-‮⁦-⁩]/g, '');
}

export interface ParsedTime {
  ms: number;
  /** A time of day (10:32 AM), not an offset from the start of the transcript. */
  clock: boolean;
  /** 1000 when seconds are shown, 60000 for clock times without seconds. */
  resolutionMs: number;
}

/** m:ss, mm:ss or h:mm:ss (optional fraction): an offset from the start of the transcript. */
const T_OFFSET = String.raw`(?:\d{1,3}:)?\d{1,3}:\d{2}(?:[.,]\d{1,3})?`;
/** 10:32 AM, 10:32:05 pm, 9:05 a.m. */
const T_CLOCK = String.raw`\d{1,2}:\d{2}(?::\d{2})?\s?[AaPp]\.?\s?[Mm]\.?`;
const T_ANY = `(?:${T_CLOCK}|${T_OFFSET})`;

const OFFSET_RE = /^(?:(\d{1,3}):)?(\d{1,3}):(\d{1,2})(?:[.,](\d{1,3}))?$/;
const CLOCK_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s?([AaPp])\.?\s?[Mm]\.?$/;

export function parseTime(text: string): ParsedTime | null {
  const s = text.trim();
  const clock = CLOCK_RE.exec(s);
  if (clock) {
    const h = Number(clock[1]);
    const m = Number(clock[2]);
    const sec = clock[3] === undefined ? 0 : Number(clock[3]);
    if (h < 1 || h > 12 || m > 59 || sec > 59) return null;
    const pm = clock[4].toLowerCase() === 'p';
    return { ms: (((h % 12) + (pm ? 12 : 0)) * 3600 + m * 60 + sec) * 1000, clock: true, resolutionMs: clock[3] === undefined ? 60_000 : 1000 };
  }
  const o = OFFSET_RE.exec(s);
  if (!o) return null;
  const h = o[1] === undefined ? 0 : Number(o[1]);
  const m = Number(o[2]);
  const sec = Number(o[3]);
  if (sec > 59 || (o[1] !== undefined && m > 59)) return null;
  const frac = o[4] === undefined ? 0 : Number(`0.${o[4]}`);
  return { ms: Math.round((h * 3600 + m * 60 + sec + frac) * 1000), clock: false, resolutionMs: o[4] === undefined ? 1000 : 1 };
}

/** Screen-reader time ("3 minutes 5 seconds", "1 hour 2 minutes 0 seconds") copied along with the pane's text. */
const A11Y_UNIT = String.raw`\d+\s*(?:hours?|hrs?|minutes?|mins?|seconds?|secs?)\b`;
const A11Y = String.raw`(?:${A11Y_UNIT}[\s,]*(?:and\s+)?){1,3}`;
const A11Y_PART_RE = /(\d+)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/gi;

export function parseA11yDuration(text: string): number | null {
  let ms = 0;
  let any = false;
  for (const m of text.matchAll(A11Y_PART_RE)) {
    any = true;
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    ms += unit.startsWith('h') ? n * 3_600_000 : unit.startsWith('m') ? n * 60_000 : n * 1000;
  }
  return any ? ms : null;
}

const TIME_ONLY_RE = new RegExp(`^(${T_ANY})$`);
const A11Y_ONLY_RE = new RegExp(`^(${A11Y})\\s*(${T_ANY})?$`, 'i');

// ---------------------------------------------------------------------------
// Header lines
// ---------------------------------------------------------------------------

/** Speaker name as Teams shows it: markdown emphasis, trailing colons and a stray screen-reader time removed. */
export function cleanSpeakerName(raw: string): string {
  const trailing = /[\s*_:\-–—·|]+$/;
  let name = raw.trim().replace(/^[\s*_]+/, '').replace(trailing, '');
  name = name.replace(new RegExp(`\\s*${A11Y}\\s*$`, 'i'), '').replace(trailing, '');
  return cleanText(name);
}

/**
 * Could this be a participant's display name? strict: also the shape of names (starts with a capital or digit,
 * at most five words, "Last, First" is the only comma).
 */
export function isNameLike(name: string, strict: boolean): boolean {
  if (!name || name.length > 64) return false;
  if (!/\p{L}/u.test(name)) return false;
  if (/https?:\/\/|www\./i.test(name)) return false;
  if (/[!?…;]$/.test(name)) return false;
  // A sentence break inside ("Thanks. Bob") is text; an initial ("J. Smith") is not a sentence.
  if (/(?<!(?:^|\s)\p{L})[.!?]\s/u.test(name)) return false;
  const words = name.split(/\s+/);
  if (words.length > (strict ? 5 : 8)) return false;
  if (name.endsWith('.') && words.length > 3) return false;
  if (strict) {
    if (!/^[\p{Lu}\p{Lt}\d(["'“]/u.test(name)) return false;
    const commas = (name.match(/,/g) ?? []).length;
    if (commas > 1 || (commas === 1 && !/^[^,]+, [^,]+$/.test(name))) return false;
    // Every word outside parentheses is capitalized, a number, or a name particle ("van", "de"): "Meet me at" is not.
    const outside = name.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').split(/\s+/).filter(Boolean);
    if (!outside.every((w) => /^[\p{Lu}\p{Lt}\d"'“(]/u.test(w) || NAME_PARTICLES.has(w.toLowerCase()))) return false;
  }
  return true;
}

const NAME_PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'dos', 'du', 'la', 'le', 'bin', 'ibn', 'al', 'el', 'ten', 'ter', 'y', 'zu']);

/** "AS" before "Alice Smith": the avatar's initials, copied as a line of their own. */
export function isInitialsOf(line: string, name: string): boolean {
  if (!/^[\p{Lu}\d]{1,3}$/u.test(line)) return false;
  const initials = new Set(
    name
      .split(/[\s,\-()[\]/]+/)
      .filter(Boolean)
      .map((w) => w[0].toUpperCase()),
  );
  return [...line].every((ch) => initials.has(ch));
}

const SYSTEM_LINE_RE = /\b(?:started|stopped|paused|resumed)\s+(?:the\s+)?(?:transcription|recording)\b|^(?:transcription|recording)\s+(?:has\s+)?(?:started|stopped)\b/i;

/** "Jason Helmick started transcription", "Recording stopped". */
export function isSystemLine(line: string): boolean {
  return line.length <= 120 && SYSTEM_LINE_RE.test(line);
}

const DATE_LINE_RE = /^(?:\p{L}+\.? \d{1,2},? \d{4}|\d{1,2}\.? \p{L}+\.? \d{4}|\d{1,4}[./-]\d{1,2}[./-]\d{1,4})(?:,? .*)?$/u;
const DURATION_LINE_RE = /^(?=\d)(?:\d+\s*h\s*)?(?:\d+\s*m(?:in)?\s*)?(?:\d+\s*s(?:ec)?)?$/i;

/** Lines of the .docx header block: date, duration, "Transcript", "<title>-20260716_092905-Meeting Recording". */
function isHeaderBlockLine(line: string): boolean {
  return (
    DATE_LINE_RE.test(line) ||
    DURATION_LINE_RE.test(line) ||
    /^transcript$/i.test(line) ||
    /meeting recording$/i.test(line) ||
    /^#\s/.test(line)
  );
}

interface Header {
  name: string;
  time: ParsedTime;
  /** Text on the header line itself ("[0:03] Alice Smith: text"). */
  inline: string;
  /** Index of the first line after the header. */
  next: number;
}

// Header forms, tried in this order.
/** "[0:03] Alice Smith: text" */
const H_TIME_FIRST = new RegExp(`^\\[?(${T_ANY})\\]?\\s+([^:]{1,64}?):\\s+(.+)$`);
/** "Alice Smith [0:03]", "Alice Smith (0:03): text" */
const H_BRACKETED = new RegExp(`^(.{1,80}?)\\s*[\\[(](${T_ANY})[\\])]\\s*:?\\s*(.*)$`);
/** "Alice Smith   0:03   text" (a table row copied from Word) */
const H_SPACED_INLINE = new RegExp(`^(.{1,80}?)(?:\\s{2,}|\\t)\\s*(${T_ANY})(?:\\s{2,}|\\t)\\s*(.+)$`);
/** "Alice Smith   0:03" (the .docx: three spaces), "Alice Smith<TAB>0:03" */
const H_SPACED = new RegExp(`^(.{1,80}?)(?:\\s{2,}|\\t)\\s*(${T_ANY})$`);
/** "Alice Smith 3 minutes 5 seconds3:05", "Alice Smith 3 minutes 5 seconds" */
const H_A11Y = new RegExp(`^(.{1,80}?)\\s*(${A11Y})\\s*(${T_ANY})?$`, 'i');
/** "Alice Smith3:05" (name and time copied without a separator) */
const H_GLUED = new RegExp(`^(.{1,64}?[\\p{L})\\]])(${T_ANY})$`, 'u');
/** "Alice Smith 0:03": only for names already known from unambiguous headers (text can end in a time too). */
const H_SINGLE_SPACE = new RegExp(`^(.{1,64}?)\\s(${T_ANY})$`);

function nextNonBlank(lines: readonly string[], from: number, maxSkip: number): number {
  for (let i = from; i < lines.length && i <= from + maxSkip; i++) if (lines[i] !== '') return i;
  return -1;
}

/** Time-only and screen-reader-only lines right after a header repeat its time: consumed with it. */
function skipTimeLines(lines: readonly string[], from: number, time: ParsedTime | null): { next: number; time: ParsedTime | null } {
  let next = from;
  let t = time;
  for (let n = 0; n < 2; n++) {
    const i = nextNonBlank(lines, next, 1);
    if (i < 0) break;
    const timeOnly = TIME_ONLY_RE.exec(lines[i]);
    const a11yOnly = timeOnly ? null : A11Y_ONLY_RE.exec(lines[i]);
    if (!timeOnly && !a11yOnly) break;
    if (!t) {
      if (timeOnly) t = parseTime(timeOnly[1]);
      else if (a11yOnly) t = a11yOnly[2] ? parseTime(a11yOnly[2]) : msTime(parseA11yDuration(a11yOnly[1]));
    }
    next = i + 1;
  }
  return { next, time: t };
}

function msTime(ms: number | null): ParsedTime | null {
  return ms === null ? null : { ms, clock: false, resolutionMs: 1000 };
}

function header(nameRaw: string, time: ParsedTime | null, inline: string, next: number, strict: boolean): Header | null {
  const name = cleanSpeakerName(nameRaw);
  if (!time || !isNameLike(name, strict)) return null;
  return { name, time, inline: inline.trim(), next };
}

function matchHeader(lines: readonly string[], k: number, known: ReadonlySet<string> | null): Header | null {
  const line = lines[k].replace(/^[*_]+|[*_]+$/g, '').trim();
  let m: RegExpExecArray | null;

  if ((m = H_TIME_FIRST.exec(line))) {
    const h = header(m[2], parseTime(m[1]), m[3], k + 1, true);
    if (h) return h;
  }
  if ((m = H_BRACKETED.exec(line))) {
    const h = header(m[1], parseTime(m[2]), m[3], k + 1, false);
    if (h) return h.inline ? h : { ...h, ...skipTimeLines(lines, k + 1, h.time), time: h.time };
  }
  if ((m = H_SPACED_INLINE.exec(line))) {
    const h = header(m[1], parseTime(m[2]), m[3], k + 1, false);
    if (h) return h;
  }
  if ((m = H_SPACED.exec(line))) {
    const h = header(m[1], parseTime(m[2]), '', k + 1, false);
    if (h) return { ...h, next: skipTimeLines(lines, k + 1, h.time).next };
  }
  // Teams always says the seconds ("0 minutes 7 seconds"); "it took 5 minutes" is text. Without a visible time
  // next to it ("We waited 3 minutes 5 seconds" is text too), only a name known from other headers counts.
  if ((m = H_A11Y.exec(line)) && (m[3] || /sec/i.test(m[2]))) {
    const visible = m[3] ? parseTime(m[3]) : null;
    const after = skipTimeLines(lines, k + 1, visible);
    const strong = after.time !== null;
    const name = cleanSpeakerName(m[1]);
    if (strong || known?.has(name) || (known?.has(LAYOUT_ESTABLISHED) && isNameLike(name, true))) {
      const h = header(m[1], after.time ?? msTime(parseA11yDuration(m[2])), '', after.next, !visible);
      if (h) return h;
    }
  }
  if ((m = H_GLUED.exec(line))) {
    const h = header(m[1], parseTime(m[2]), '', k + 1, true);
    if (h) return { ...h, next: skipTimeLines(lines, k + 1, h.time).next };
  }
  // Name on this line, time (or screen-reader time) on the next one.
  const n = nextNonBlank(lines, k + 1, 1);
  if (n >= 0 && (TIME_ONLY_RE.test(lines[n]) || A11Y_ONLY_RE.test(lines[n]))) {
    const after = skipTimeLines(lines, k + 1, null);
    const h = header(line, after.time, '', after.next, false);
    if (h && !/[.!?:,;]$/.test(h.name)) return h;
  }
  if (known && (m = H_SINGLE_SPACE.exec(line))) {
    // Once the text is known to use "Name 0:03" headers, any well-formed name counts, not only repeated ones.
    const name = cleanSpeakerName(m[1]);
    if (known.has(name) || (known.has(LAYOUT_ESTABLISHED) && isNameLike(name, true))) {
      const h = header(m[1], parseTime(m[2]), '', k + 1, false);
      if (h) return { ...h, next: skipTimeLines(lines, k + 1, h.time).next };
    }
  }
  return null;
}

/**
 * Marker in the known-name set: the text uses headers without a clear separator ("Name 0:03", "Name 3 minutes
 * 5 seconds") throughout, so any well-formed name in that shape is a header.
 */
const LAYOUT_ESTABLISHED = '\u0000layout';

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

interface RawTurn {
  speaker: string;
  time: ParsedTime;
  lines: string[];
}

interface Scan {
  turns: RawTurn[];
  preamble: string[];
  skippedSystemLines: number;
}

function scan(lines: readonly string[], known: ReadonlySet<string> | null): Scan {
  const turns: RawTurn[] = [];
  const preamble: string[] = [];
  let current: RawTurn | null = null;
  /** Index (in `lines`) of the last line added to the current turn's text or the preamble. */
  let lastTextLine = -1;
  let skippedSystemLines = 0;
  for (let k = 0; k < lines.length; ) {
    const line = lines[k];
    if (line === '') {
      k++;
      continue;
    }
    if (isSystemLine(line)) {
      skippedSystemLines++;
      k++;
      continue;
    }
    const h = matchHeader(lines, k, known);
    if (h) {
      // An avatar line ("AS") just before the name belongs to the header, not to the previous turn.
      if (lastTextLine >= 0 && nextNonBlank(lines, lastTextLine + 1, 2) === k && isInitialsOf(lines[lastTextLine], h.name)) {
        if (current && current.lines.length > 0) current.lines.pop();
        else if (!current) preamble.pop();
      }
      current = { speaker: h.name, time: h.time, lines: h.inline ? [h.inline] : [] };
      turns.push(current);
      lastTextLine = -1;
      k = h.next;
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
    lastTextLine = k;
    k++;
  }
  return { turns, preamble, skippedSystemLines };
}

/**
 * Names that head several "Name 0:03" (single space) or "Name 3 minutes 5 seconds" lines, for a text without any
 * unambiguous header.
 */
function recurringNames(lines: readonly string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    let raw: string | null = null;
    const single = H_SINGLE_SPACE.exec(line);
    if (single && parseTime(single[2])) raw = single[1];
    const a11y = raw === null ? H_A11Y.exec(line) : null;
    if (a11y && /sec/i.test(a11y[2])) raw = a11y[1];
    if (raw === null) continue;
    const name = cleanSpeakerName(raw);
    if (isNameLike(name, true)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = new Set([...counts].filter(([, n]) => n >= 2).map(([name]) => name));
  if (names.size > 0) names.add(LAYOUT_ESTABLISHED);
  return names;
}

/**
 * Times as one rising timeline: clock times that pass midnight continue past 24:00, and a transcript whose times
 * start over (two transcripts pasted one after the other) is moved after the first one. Returns the warnings.
 */
export function makeTimesMonotonic(turns: TeamsTurn[], clock: boolean): string[] {
  const warnings: string[] = [];
  let shift = 0;
  let latest = -Infinity;
  let restarts = 0;
  for (const turn of turns) {
    let t = turn.startMs + shift;
    if (clock && t < latest - 12 * 3_600_000) {
      shift += 24 * 3_600_000;
      t += 24 * 3_600_000;
    }
    if (t < latest - 60_000) {
      const jump = latest - t + 1000;
      shift += jump;
      t += jump;
      restarts++;
    }
    const delta = t - turn.startMs;
    turn.startMs = t;
    if (turn.endMs !== null) turn.endMs += delta;
    latest = Math.max(latest, t);
  }
  if (restarts > 0) {
    warnings.push(
      `The times start over ${restarts === 1 ? 'once' : `${restarts} times`} (several transcripts pasted together?); the later parts are matched separately.`,
    );
  }
  return warnings;
}

/** Drops exact repeats of a turn (same speaker, time and text), which overlapping copies of a long transcript produce. */
export function dropRepeatedTurns(turns: TeamsTurn[]): { turns: TeamsTurn[]; dropped: number } {
  const seen = new Set<string>();
  const kept: TeamsTurn[] = [];
  for (const t of turns) {
    const key = `${t.speaker}\u0000${t.startMs}\u0000${t.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(t);
  }
  return { turns: kept, dropped: turns.length - kept.length };
}

/** Parses the speaker + time layout. `text` must already be normalized (normalizeInputText). */
export function parseSpeakerTimeText(text: string, input: TeamsInputKind, fileName: string | null): ParsedTeamsTranscript {
  const lines = text.split('\n').map((l) => l.trim());
  let result = scan(lines, null);
  const strongNames = new Set(result.turns.map((t) => t.speaker));
  // Second pass: "Name 0:03" with a single space is a header only for names that head unambiguous lines elsewhere.
  const known = strongNames.size > 0 ? strongNames : recurringNames(lines);
  if (known.size > 0) result = scan(lines, known);
  if (result.turns.length === 0) return emptyParse(input, fileName);

  const clock = result.turns.some((t) => t.time.clock);
  const warnings: string[] = [];
  if (clock && result.turns.some((t) => !t.time.clock)) {
    warnings.push('Some lines show clock times and others times from the start of the transcript; the matching may be off.');
  }
  const resolutionMs = Math.max(...result.turns.map((t) => t.time.resolutionMs));
  let turns: TeamsTurn[] = [];
  let empty = 0;
  for (const raw of result.turns) {
    const body = cleanText(raw.lines.join(' '));
    if (!body) {
      empty++;
      continue;
    }
    turns.push({ speaker: raw.speaker, startMs: raw.time.ms, endMs: null, text: body });
  }
  warnings.push(...makeTimesMonotonic(turns, clock));
  const repeats = dropRepeatedTurns(turns);
  turns = repeats.turns;
  if (repeats.dropped > 0) warnings.push(`${repeats.dropped} repeated line${repeats.dropped === 1 ? ' was' : 's were'} dropped.`);
  if (empty > 0) warnings.push(`${empty} speaker line${empty === 1 ? ' had' : 's had'} no text and ${empty === 1 ? 'was' : 'were'} skipped.`);

  const contentPreamble = result.preamble.filter((l) => !isHeaderBlockLine(l) && !isSystemLine(l));
  if (contentPreamble.length > 2) {
    warnings.push(`${contentPreamble.length} lines before the first speaker were skipped.`);
  }
  const titleLine = result.preamble.find((l) => l !== '' && !DATE_LINE_RE.test(l) && !DURATION_LINE_RE.test(l) && !/^transcript$/i.test(l));
  const title = titleLine ? cleanText(titleLine.replace(/^#\s*/, '').replace(/[-_ ]*\d{8}_\d{6}[-_ ]*Meeting Recording$/i, '').replace(/[- ]*Meeting Recording$/i, '')) || null : null;

  return {
    input,
    layout: 'speaker-time',
    turns,
    speakers: speakersOf(turns),
    warnings,
    clockTimes: clock,
    timeResolutionMs: resolutionMs,
    fileName,
    title,
  };
}

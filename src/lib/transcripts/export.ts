/**
 * Transcript export: Markdown, plain text, JSON, WebVTT and SRT. OWNER: meeting agent.
 *
 * Times are offsets from the start of the meeting. Echo duplicates (microphone lines repeating the call audio)
 * are left out unless includeEcho is set.
 */
import type { ModelSummary } from '../types';
import { UNKNOWN_SPEAKER } from './model';
import type { MeetingSegment, MeetingTranscript } from './types';

export type ExportFormat = 'markdown' | 'text' | 'json' | 'vtt' | 'srt';

export interface ExportFormatInfo {
  id: ExportFormat;
  label: string;
  extension: string;
  mime: string;
}

export const EXPORT_FORMATS: readonly ExportFormatInfo[] = [
  { id: 'markdown', label: 'Markdown', extension: 'md', mime: 'text/markdown;charset=utf-8' },
  { id: 'text', label: 'Plain text', extension: 'txt', mime: 'text/plain;charset=utf-8' },
  { id: 'json', label: 'JSON', extension: 'json', mime: 'application/json;charset=utf-8' },
  { id: 'vtt', label: 'WebVTT subtitles', extension: 'vtt', mime: 'text/vtt;charset=utf-8' },
  { id: 'srt', label: 'SRT subtitles', extension: 'srt', mime: 'application/x-subrip;charset=utf-8' },
];

export interface ExportOptions {
  /** Include microphone lines hidden as duplicates of the call audio. Default false. */
  includeEcho?: boolean;
  /** Locale and time zone of the date line; default: the browser's. */
  locale?: string;
  timeZone?: string;
}

const ECHO_NOTE = '(duplicate of call audio)';

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function split(ms: number): { h: number; m: number; s: number; ms: number } {
  const total = Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0));
  return {
    h: Math.floor(total / 3_600_000),
    m: Math.floor(total / 60_000) % 60,
    s: Math.floor(total / 1000) % 60,
    ms: total % 1000,
  };
}

/** hh:mm:ss, whole seconds rounded down (00:01:23). */
export function formatHms(ms: number): string {
  const t = split(Math.floor(Math.max(0, ms) / 1000) * 1000);
  return `${pad(t.h)}:${pad(t.m)}:${pad(t.s)}`;
}

/** m:ss below an hour, h:mm:ss from an hour on (the live transcript's [mm:ss] column). */
export function formatOffset(ms: number): string {
  const t = split(Math.floor(Math.max(0, ms) / 1000) * 1000);
  return t.h > 0 ? `${t.h}:${pad(t.m)}:${pad(t.s)}` : `${pad(t.m)}:${pad(t.s)}`;
}

/** 00:01:23.456 */
export function formatVttTime(ms: number): string {
  const t = split(ms);
  return `${pad(t.h)}:${pad(t.m)}:${pad(t.s)}.${pad(t.ms, 3)}`;
}

/** 00:01:23,456 */
export function formatSrtTime(ms: number): string {
  const t = split(ms);
  return `${pad(t.h)}:${pad(t.m)}:${pad(t.s)},${pad(t.ms, 3)}`;
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/** Backslash-escapes the characters that would start Markdown formatting, links or HTML. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>#|~]/g, '\\$&');
}

/** Cue text: &, < and > as entities (also keeps "-->" out of a cue). */
export function escapeVtt(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** SRT has no escaping; a "-->" inside text would read as a timing line to some players. */
function escapeSrt(text: string): string {
  return text.replace(/-->/g, '→');
}

/** One line, no blank lines inside a cue or list item. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

interface Line {
  segment: MeetingSegment;
  speaker: string;
  text: string;
  echo: boolean;
}

function lines(t: MeetingTranscript, includeEcho: boolean): Line[] {
  const names = new Map(t.speakers.map((s) => [s.id, s.name]));
  return t.segments
    .filter((s) => includeEcho || s.echoOf === null)
    .map((segment) => ({
      segment,
      speaker: oneLine((segment.speakerId !== null ? names.get(segment.speakerId) : undefined) ?? UNKNOWN_SPEAKER),
      text: oneLine(segment.text),
      echo: segment.echoOf !== null,
    }));
}

/** Named speakers with at least one exported line, by number. */
function participants(t: MeetingTranscript, exported: readonly Line[]): string[] {
  const used = new Set(exported.map((l) => l.segment.speakerId));
  return [...new Set(t.speakers.filter((s) => used.has(s.id)).map((s) => oneLine(s.name)))];
}

export function formatDate(iso: string, options: ExportOptions = {}): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(options.locale, { dateStyle: 'full', timeStyle: 'short', timeZone: options.timeZone });
}

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

export function toMarkdown(t: MeetingTranscript, options: ExportOptions = {}): string {
  const exported = lines(t, options.includeEcho ?? false);
  const people = participants(t, exported);
  const out = [
    `# ${escapeMarkdown(oneLine(t.title))}`,
    '',
    `- **Date:** ${escapeMarkdown(formatDate(t.createdAt, options))}`,
    `- **Duration:** ${formatHms(t.durationMs)}`,
    `- **Participants:** ${people.length > 0 ? people.map(escapeMarkdown).join(', ') : 'none identified'}`,
    '',
  ];
  for (const l of exported) {
    const note = l.echo ? ` _${ECHO_NOTE}_` : '';
    out.push(`**${escapeMarkdown(l.speaker)}** (${formatHms(l.segment.startMs)}): ${escapeMarkdown(l.text)}${note}`, '');
  }
  return out.join('\n');
}

export function toPlainText(t: MeetingTranscript, options: ExportOptions = {}): string {
  const exported = lines(t, options.includeEcho ?? false);
  const people = participants(t, exported);
  const out = [
    oneLine(t.title),
    `Date: ${formatDate(t.createdAt, options)}`,
    `Duration: ${formatHms(t.durationMs)}`,
    `Participants: ${people.length > 0 ? people.join(', ') : 'none identified'}`,
    '',
  ];
  for (const l of exported) {
    out.push(`[${formatHms(l.segment.startMs)}] ${l.speaker}: ${l.text}${l.echo ? ` ${ECHO_NOTE}` : ''}`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * How a model ran, without saying which model it was: transcripts get shared, so the export leaves out the model
 * names, repositories, revisions and library versions that the stored transcript keeps.
 */
function exportedModel(m: ModelSummary | null) {
  return m && { backend: m.backend, quantization: m.quantization, loadKind: m.loadKind, runsSinceLoad: m.runsSinceLoad };
}

/** The Transcript object itself (with the meeting fields), minus echo lines unless asked for. */
export function toJson(t: MeetingTranscript, options: ExportOptions = {}): string {
  const segments = options.includeEcho ? t.segments : t.segments.filter((s) => s.echoOf === null);
  const models = { asr: exportedModel(t.models.asr), speaker: exportedModel(t.models.speaker) };
  return `${JSON.stringify({ ...t, segments, models }, null, 2)}\n`;
}

/** Cue end: never before its start (VTT and SRT players reject such cues). */
function cueEnd(segment: MeetingSegment): number {
  return Math.max(segment.endMs, segment.startMs + 1);
}

export function toWebVtt(t: MeetingTranscript, options: ExportOptions = {}): string {
  const out = ['WEBVTT', '', 'NOTE', escapeVtt(`${oneLine(t.title)} · ${formatDate(t.createdAt, options)}`), ''];
  lines(t, options.includeEcho ?? false).forEach((l, i) => {
    out.push(
      String(i + 1),
      `${formatVttTime(l.segment.startMs)} --> ${formatVttTime(cueEnd(l.segment))}`,
      escapeVtt(`${l.speaker}: ${l.text}${l.echo ? ` ${ECHO_NOTE}` : ''}`),
      '',
    );
  });
  return out.join('\n');
}

export function toSrt(t: MeetingTranscript, options: ExportOptions = {}): string {
  const out: string[] = [];
  lines(t, options.includeEcho ?? false).forEach((l, i) => {
    out.push(
      String(i + 1),
      `${formatSrtTime(l.segment.startMs)} --> ${formatSrtTime(cueEnd(l.segment))}`,
      escapeSrt(`${l.speaker}: ${l.text}${l.echo ? ` ${ECHO_NOTE}` : ''}`),
      '',
    );
  });
  return out.join('\n');
}

export function exportTranscript(t: MeetingTranscript, format: ExportFormat, options: ExportOptions = {}): string {
  switch (format) {
    case 'markdown':
      return toMarkdown(t, options);
    case 'text':
      return toPlainText(t, options);
    case 'json':
      return toJson(t, options);
    case 'vtt':
      return toWebVtt(t, options);
    case 'srt':
      return toSrt(t, options);
  }
}

export function formatInfo(format: ExportFormat): ExportFormatInfo {
  return EXPORT_FORMATS.find((f) => f.id === format) ?? EXPORT_FORMATS[0];
}

/** "Meeting 4 Oct 2026, 14:30" → "Meeting 4 Oct 2026, 14-30.md": no characters Windows forbids in file names. */
export function exportFileName(title: string, format: ExportFormat): string {
  const base =
    oneLine(title)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .replace(/^[\s.]+|[\s.]+$/g, '')
      .slice(0, 120)
      .trim() || 'transcript';
  return `${base}.${formatInfo(format).extension}`;
}

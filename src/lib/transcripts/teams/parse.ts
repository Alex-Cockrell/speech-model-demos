/**
 * Entry points for reading a Teams transcript: pasted text or a dropped/opened file (.txt, .vtt, .docx).
 * OWNER: meeting agent.
 *
 * The layout is detected from the content, not the file name: a .txt can hold a pasted transcript or a .vtt;
 * a .docx holds either the current speaker + time layout or the older timed blocks.
 */
import { DocxError, isZip, readDocxText } from './docx';
import { normalizeInputText, parseSpeakerTimeText } from './parse-text';
import { TIMING_RE, parseCueText } from './parse-vtt';
import { emptyParse, type ParsedTeamsTranscript, type TeamsInputKind } from './types';

/** Larger files are not transcripts (a two-hour .docx transcript is well under 1 MB). */
export const MAX_TEAMS_FILE_BYTES = 25 * 1024 * 1024;

export class TeamsFileError extends Error {}

function timingLineCount(text: string, limit: number): number {
  let n = 0;
  for (const line of text.split('\n')) {
    if (TIMING_RE.test(line) && ++n >= limit) break;
  }
  return n;
}

/** Parses Teams transcript text in whichever layout it has. */
export function parseTeamsText(text: string, input: TeamsInputKind = 'paste', fileName: string | null = null): ParsedTeamsTranscript {
  const norm = normalizeInputText(text);
  if (norm.trim() === '') return emptyParse(input, fileName);
  const webVtt = /^\s*WEBVTT/.test(norm);
  if (webVtt) return parseCueText(norm, input, fileName) ?? emptyParse(input, fileName);
  const cues = timingLineCount(norm, 2) >= 2 || /<v[\s.]/.test(norm) ? parseCueText(norm, input, fileName) : null;
  if (cues && cues.turns.length > 0 && cues.speakers.length > 0) return cues;
  const spoken = parseSpeakerTimeText(norm, input, fileName);
  if (spoken.turns.length > 0) return spoken;
  return cues && cues.turns.length > 0 ? cues : spoken;
}

/** UTF-8 unless the file starts with a UTF-16 byte order mark (Notepad's "Unicode"). */
export function decodeTextFile(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  return new TextDecoder('utf-8').decode(bytes);
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Reads a dropped or opened file. Throws TeamsFileError with a readable message when the file cannot be read. */
export async function parseTeamsFile(name: string, bytes: Uint8Array): Promise<ParsedTeamsTranscript> {
  if (bytes.length > MAX_TEAMS_FILE_BYTES) {
    throw new TeamsFileError('This file is too large to be a meeting transcript. Use the .docx or .vtt file Teams downloads.');
  }
  const ext = extension(name);
  if (ext === 'docx' || isZip(bytes)) {
    try {
      return parseTeamsText(await readDocxText(bytes), 'docx', name);
    } catch (e) {
      if (e instanceof DocxError) throw new TeamsFileError(e.message);
      throw e;
    }
  }
  if (ext === 'doc') {
    throw new TeamsFileError('Old Word (.doc) files cannot be read. Download the transcript again as .docx, or open it in Word and paste the text.');
  }
  if (bytes.includes(0) && !(bytes[0] === 0xff || bytes[0] === 0xfe)) {
    throw new TeamsFileError('This file is not text, a .vtt or a Word document. Open the .docx or .vtt file Teams downloads, or paste the transcript.');
  }
  return parseTeamsText(decodeTextFile(bytes), ext === 'vtt' ? 'vtt' : 'txt', name);
}

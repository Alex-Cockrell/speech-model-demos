/**
 * Read-aloud input: turns a pasted document or generated response (Markdown or plain text) into blocks of
 * speakable text. Pure (no DOM, no kokoro-js), so it runs on the main thread and in tests.
 *
 * Every character of a block's text keeps the offset of the source character it came from, so a spoken piece
 * maps back to a range of the original input (pieces.ts computes those ranges).
 *
 * Markdown rules (a pragmatic CommonMark subset, tuned for listening rather than rendering):
 * - Headings, paragraphs, list items, block quotes and table rows become separate blocks; a block always ends a
 *   sentence, so list items and headings are read as sentences of their own.
 * - Emphasis, strikethrough and inline-code markers are removed; inline code text is kept.
 * - Links are read as their text, images as their alt text; bare URLs and autolinks are read as their host name
 *   ("github.com"); reference definitions, HTML comments, HTML tags, front matter and horizontal rules are dropped.
 * - Fenced code blocks are not read: each becomes a short spoken note, "Code block omitted: 12 lines of Python."
 *   Reading code aloud is rarely useful, and skipping it silently would make "as shown above" confusing.
 * - Tables: a short "Table: A, B, C." announcement, then every row as "A: x; B: y; C: z." so each value is heard
 *   with its column name (what screen readers do when navigating tables).
 * - Indented (4-space) code blocks are NOT recognised: pasted plain text often has indented paragraphs.
 * - Emoji are removed; whitespace is collapsed.
 *
 * Plain text keeps only the structure that is unambiguous without Markdown: paragraphs (blank lines), bullet or
 * numbered lines as list items, URL shortening, emoji removal and whitespace collapsing.
 *
 * In both modes a line break inside a paragraph is a soft wrap (a space), except after a short line with no
 * closing punctuation that is followed by a capitalised line ("Agenda\nWe discussed…"): that line becomes its
 * own block, so it is not run into the next sentence.
 */

export type DocFormat = 'markdown' | 'plain';
export type FormatChoice = DocFormat | 'auto';
export type BlockKind = 'heading' | 'paragraph' | 'list-item' | 'table-row' | 'code';

export interface DocBlock {
  kind: BlockKind;
  /** Heading level (1–6) or list nesting depth (0 = top level); 0 otherwise. */
  level: number;
  /** List marker shown in the reader ('•', '3.', '☐', '☑'), 'table' for a table announcement; null otherwise. */
  marker: string | null;
  /** Ordered-list number, spoken before the item ("3, …"); null otherwise. */
  ordinal: number | null;
  /** Inside a block quote. */
  quote: boolean;
  /** Normalized text, shown in the reader. Never empty, no leading/trailing whitespace, no newlines. */
  text: string;
  /** Source offset of every character of `text` (same length as `text`). */
  offsets: Int32Array;
  /** Source range of the lines this block came from. */
  sourceStart: number;
  sourceEnd: number;
}

export interface DocNotes {
  codeBlocks: number;
  tables: number;
  images: number;
  links: number;
  urls: number;
}

export interface ReadDocument {
  format: DocFormat;
  blocks: DocBlock[];
  /** What normalization removed or replaced, for the UI. */
  notes: DocNotes;
  sourceLength: number;
}

/** Inputs larger than this are refused by the UI: 1 M characters is roughly 20 hours of speech. */
export const MAX_SOURCE_CHARS = 1_000_000;

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

const STRONG_MARKDOWN = [
  /^\s{0,3}(```|~~~)/m, // fenced code
  /^\s{0,3}#{1,6}\s+\S/m, // ATX heading
  /\[[^\]\n]+\]\([^)\s]+(?:\s+"[^"]*")?\)/, // inline link
  /^\s*\|?\s*:?-{3,}:?\s*\|/m, // table delimiter row
];
const WEAK_MARKDOWN = [
  /^\s{0,3}[-*+]\s+\S/m, // bullet list
  /(\*\*|__)\S[^\n]*?\S\1/, // strong emphasis
  /^\s{0,3}>\s?\S/m, // block quote
  /`[^`\n]+`/, // inline code
  /^\s{0,3}\d{1,3}[.)]\s+\S/m, // ordered list
];

/** Markdown when the text has one strong Markdown signal or two weak ones. */
export function detectFormat(source: string): DocFormat {
  if (STRONG_MARKDOWN.some((re) => re.test(source))) return 'markdown';
  return WEAK_MARKDOWN.filter((re) => re.test(source)).length >= 2 ? 'markdown' : 'plain';
}

/** Format implied by a file name; null when the extension says nothing. */
export function formatForFileName(name: string): DocFormat | null {
  if (/\.(md|markdown|mdown|mkd)$/i.test(name)) return 'markdown';
  if (/\.(txt|text)$/i.test(name)) return 'plain';
  return null;
}

// ---------------------------------------------------------------------------
// Text builder with source offsets
// ---------------------------------------------------------------------------

const WHITESPACE = /\s/;
const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}︎️‍⃣]/u;

/** Appends characters with their source offsets, collapsing whitespace and dropping emoji. */
class TextBuilder {
  private readonly chars: string[] = [];
  private readonly offs: number[] = [];
  private pendingSpace: number | null = null;

  get length(): number {
    return this.chars.length;
  }

  push(ch: string, offset: number): void {
    if (WHITESPACE.test(ch)) {
      if (this.chars.length > 0 && this.pendingSpace === null) this.pendingSpace = offset;
      return;
    }
    if (this.pendingSpace !== null) {
      this.chars.push(' ');
      this.offs.push(this.pendingSpace);
      this.pendingSpace = null;
    }
    this.chars.push(ch);
    this.offs.push(offset);
  }

  /** Source text: character i of `text` came from offsets[i]. Emoji (whole code points) are skipped. */
  pushSource(text: string, offsets: ArrayLike<number>, from = 0, to = text.length): void {
    let i = from;
    while (i < to) {
      const cp = text.codePointAt(i) ?? 0;
      const width = cp > 0xffff ? 2 : 1;
      const ch = text.slice(i, i + width);
      if (!EMOJI.test(ch)) {
        if (width === 1) this.push(ch, offsets[i]);
        else this.pushPair(ch, offsets[i]);
      }
      i += width;
    }
  }

  /** Text that is not in the source (labels, notes), mapped linearly onto the source range [from, to). */
  pushSynthetic(text: string, from: number, to = from + 1): void {
    const span = Math.max(0, to - 1 - from);
    const last = Math.max(1, text.length - 1);
    for (let i = 0; i < text.length; i++) this.push(text[i], from + Math.round((i * span) / last));
  }

  space(offset: number): void {
    this.push(' ', offset);
  }

  build(): { text: string; offsets: Int32Array } {
    return { text: this.chars.join(''), offsets: Int32Array.from(this.offs) };
  }

  /** A surrogate pair stays together; both halves map to the same offset. */
  private pushPair(pair: string, offset: number): void {
    this.push(pair[0], offset);
    this.chars.push(pair[1]);
    this.offs.push(offset);
  }
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

interface Line {
  /** Content after block-quote markers (no line terminator). */
  text: string;
  /** Source offset of text[0]. */
  start: number;
  /** Source offset just past the line content. */
  end: number;
  quote: boolean;
}

function splitLines(source: string, stripQuotes: boolean): Line[] {
  const lines: Line[] = [];
  const re = /[^\r\n]*(\r\n|\r|\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const raw = match[0];
    const terminator = match[1];
    const content = raw.slice(0, raw.length - terminator.length);
    const start = match.index;
    if (raw.length === 0) break;
    let text = content;
    let offset = start;
    let quote = false;
    if (stripQuotes) {
      const q = /^(\s{0,3}>\s?)+/.exec(text);
      if (q) {
        quote = true;
        text = text.slice(q[0].length);
        offset += q[0].length;
      }
    }
    lines.push({ text, start: offset, end: start + content.length, quote });
    if (terminator === '') break;
  }
  return lines;
}

const isBlank = (line: Line) => line.text.trim() === '';
const indentOf = (text: string) => {
  let n = 0;
  for (const ch of text) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4 - (n % 4);
    else break;
  }
  return n;
};

// ---------------------------------------------------------------------------
// Inline processing
// ---------------------------------------------------------------------------

/** Raw inline content: text (soft line breaks as '\n') plus the source offset of every character. */
interface Raw {
  text: string;
  offsets: number[];
}

function rawFromLines(lines: { text: string; start: number }[], trimStart: number[] = []): Raw {
  let text = '';
  const offsets: number[] = [];
  lines.forEach((line, i) => {
    const skip = trimStart[i] ?? 0;
    if (i > 0) {
      text += '\n';
      offsets.push(line.start + skip);
    }
    for (let k = skip; k < line.text.length; k++) {
      text += line.text[k];
      offsets.push(line.start + k);
    }
  });
  return { text, offsets };
}

function sliceRaw(raw: Raw, from: number, to: number): Raw {
  return { text: raw.text.slice(from, to), offsets: raw.offsets.slice(from, to) };
}

const URL_AT = /^(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"'`]+/i;
const AUTOLINK_AT = /^<((?:https?|ftp):\/\/[^\s<>]+|mailto:[^\s<>]+|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/i;
const HTML_TAG_AT = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s[^<>]*)?\/?>/;
const HTML_COMMENT_AT = /^<!--[\s\S]*?-->/;
const ENTITY_AT = /^&(amp|lt|gt|quot|apos|nbsp|#39|#x27|mdash|ndash|hellip|rsquo|lsquo|rdquo|ldquo);/;
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#x27': "'",
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
/** Trailing characters that end a sentence or clause rather than belong to a URL (')' is handled by balance). */
const URL_TRAILING = /[.,;:!?'"\]}]+$/;

/** Host name of a URL, without "www." (what is read instead of the whole URL). */
function urlHost(url: string): { host: string; index: number } {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/?#\s]*@)?([^/?#:\s]+)/i.exec(url);
  const full = m ? m[1] : url;
  const index = m ? m[0].length - full.length : 0;
  return full.toLowerCase().startsWith('www.') ? { host: full.slice(4), index: index + 4 } : { host: full, index };
}

/** Length of the URL starting at text[i], excluding trailing punctuation and unbalanced closing parentheses. */
function urlLength(text: string, i: number): number {
  const m = URL_AT.exec(text.slice(i));
  if (!m) return 0;
  let url = m[0];
  // Drop trailing punctuation, and a trailing ')' only when unbalanced: "(see https://x.org/Foo_(bar))."
  for (let previous = ''; previous !== url; ) {
    previous = url;
    url = url.replace(URL_TRAILING, '');
    if (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
  }
  return url.length;
}

function runLength(text: string, i: number, ch: string): number {
  let n = 0;
  while (text[i + n] === ch) n++;
  return n;
}

const isWs = (c: string) => c === '' || WHITESPACE.test(c);
const isPunct = (c: string) => /[\p{P}\p{S}]/u.test(c);
const isAlnum = (c: string) => /[\p{L}\p{N}]/u.test(c);

/** CommonMark flanking rules, simplified: is the delimiter run at i an emphasis marker (to be removed)? */
function isEmphasisRun(text: string, i: number, run: number, ch: string): boolean {
  const prev = i > 0 ? text[i - 1] : '';
  const next = text[i + run] ?? '';
  const left = !isWs(next) && (!isPunct(next) || isWs(prev) || isPunct(prev));
  const right = !isWs(prev) && (!isPunct(prev) || isWs(next) || isPunct(next));
  if (ch === '~') return run >= 2 && (left || right);
  if (ch === '_' && isAlnum(prev) && isAlnum(next)) return false; // snake_case
  if (ch === '*' && /\d/.test(prev) && /\d/.test(next)) return false; // 2*3
  return left || right;
}

interface LinkMatch {
  labelStart: number;
  labelEnd: number;
  end: number;
}

/** [label](destination "title") or [label][ref] starting at text[i] === '['. */
function matchLink(text: string, i: number): LinkMatch | null {
  let depth = 0;
  let close = -1;
  for (let k = i; k < text.length; k++) {
    const c = text[k];
    if (c === '\\') {
      k++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) {
      close = k;
      break;
    }
  }
  if (close < 0) return null;
  const after = text[close + 1];
  if (after === '[') {
    const refEnd = text.indexOf(']', close + 2);
    return refEnd < 0 ? null : { labelStart: i + 1, labelEnd: close, end: refEnd + 1 };
  }
  if (after !== '(') return null;
  let k = close + 2;
  while (k < text.length && /[ \t\n]/.test(text[k])) k++;
  if (text[k] === '<') {
    const gt = text.indexOf('>', k);
    if (gt < 0) return null;
    k = gt + 1;
  } else {
    let parens = 0;
    while (k < text.length && !/\s/.test(text[k])) {
      if (text[k] === '\\') k++;
      else if (text[k] === '(') parens++;
      else if (text[k] === ')') {
        if (parens === 0) break;
        parens--;
      }
      k++;
    }
  }
  while (k < text.length && /[ \t\n]/.test(text[k])) k++;
  const quote = text[k];
  if (quote === '"' || quote === "'" || quote === '(') {
    const closing = quote === '(' ? ')' : quote;
    const end = text.indexOf(closing, k + 1);
    if (end < 0) return null;
    k = end + 1;
    while (k < text.length && /[ \t\n]/.test(text[k])) k++;
  }
  return text[k] === ')' ? { labelStart: i + 1, labelEnd: close, end: k + 1 } : null;
}

/** Markdown inline content → readable text. */
function inlineMarkdown(raw: Raw, out: TextBuilder, notes: DocNotes): void {
  const { text, offsets } = raw;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const rest = () => text.slice(i);

    if (ch === '\\') {
      const next = text[i + 1];
      if (next === '\n') {
        out.space(offsets[i]); // hard line break
        i += 2;
        continue;
      }
      if (next !== undefined && ASCII_PUNCT.test(next)) {
        out.push(next, offsets[i + 1]);
        i += 2;
        continue;
      }
    }

    if (ch === '`') {
      const run = runLength(text, i, '`');
      let close = -1;
      for (let k = text.indexOf('`', i + run); k >= 0; k = text.indexOf('`', k + runLength(text, k, '`'))) {
        if (runLength(text, k, '`') === run) {
          close = k;
          break;
        }
      }
      if (close < 0) {
        i += run; // unmatched backticks: drop them
        continue;
      }
      let from = i + run;
      let to = close;
      if (to - from >= 2 && text[from] === ' ' && text[to - 1] === ' ') {
        from++;
        to--;
      }
      out.pushSource(text, offsets, from, to);
      i = close + run;
      continue;
    }

    if (ch === '!' && text[i + 1] === '[') {
      const link = matchLink(text, i + 1);
      if (link) {
        notes.images++;
        inlineMarkdown(sliceRaw(raw, link.labelStart, link.labelEnd), out, notes);
        i = link.end;
        continue;
      }
    }

    if (ch === '[') {
      const footnote = /^\[\^[^\]\s]+\]/.exec(rest());
      if (footnote) {
        i += footnote[0].length;
        continue;
      }
      const link = matchLink(text, i);
      if (link) {
        notes.links++;
        inlineMarkdown(sliceRaw(raw, link.labelStart, link.labelEnd), out, notes);
        i = link.end;
        continue;
      }
    }

    if (ch === '<') {
      const comment = HTML_COMMENT_AT.exec(rest());
      if (comment) {
        i += comment[0].length;
        continue;
      }
      const auto = AUTOLINK_AT.exec(rest());
      if (auto) {
        const target = auto[1];
        notes.urls++;
        if (/^mailto:/i.test(target)) out.pushSource(text, offsets, i + 8, i + 1 + target.length);
        else if (target.includes('@') && !target.includes('://')) out.pushSource(text, offsets, i + 1, i + 1 + target.length);
        else {
          const { host, index } = urlHost(target);
          out.pushSource(text, offsets, i + 1 + index, i + 1 + index + host.length);
        }
        i += auto[0].length;
        continue;
      }
      const tag = HTML_TAG_AT.exec(rest());
      if (tag) {
        if (/^(br|p|div|li|tr|hr)$/i.test(tag[1])) out.space(offsets[i]);
        i += tag[0].length;
        continue;
      }
    }

    if (ch === '&') {
      const entity = ENTITY_AT.exec(rest());
      if (entity) {
        out.pushSynthetic(ENTITIES[entity[1]], offsets[i], offsets[i + entity[0].length - 1] + 1);
        i += entity[0].length;
        continue;
      }
    }

    if ((ch === 'h' || ch === 'H' || ch === 'w' || ch === 'W' || ch === 'f' || ch === 'F') && (i === 0 || !isAlnum(text[i - 1]))) {
      const length = urlLength(text, i);
      if (length > 0) {
        notes.urls++;
        const { host, index } = urlHost(text.slice(i, i + length));
        out.pushSource(text, offsets, i + index, i + index + host.length);
        i += length;
        continue;
      }
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      const run = runLength(text, i, ch);
      if (isEmphasisRun(text, i, run, ch)) {
        i += run;
        continue;
      }
      out.pushSource(text, offsets, i, i + run);
      i += run;
      continue;
    }

    // Everything else, emoji filtering included.
    const cp = text.codePointAt(i) ?? 0;
    const width = cp > 0xffff ? 2 : 1;
    out.pushSource(text, offsets, i, i + width);
    i += width;
  }
}

/** Plain-text inline content: only URL shortening, emoji removal and whitespace collapsing. */
function inlinePlain(raw: Raw, out: TextBuilder, notes: DocNotes): void {
  const { text, offsets } = raw;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if ((ch === 'h' || ch === 'H' || ch === 'w' || ch === 'W' || ch === 'f' || ch === 'F') && (i === 0 || !isAlnum(text[i - 1]))) {
      const length = urlLength(text, i);
      if (length > 0) {
        notes.urls++;
        const { host, index } = urlHost(text.slice(i, i + length));
        out.pushSource(text, offsets, i + index, i + index + host.length);
        i += length;
        continue;
      }
    }
    const cp = text.codePointAt(i) ?? 0;
    const width = cp > 0xffff ? 2 : 1;
    out.pushSource(text, offsets, i, i + width);
    i += width;
  }
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

/** Any indentation: fences inside list items are common, and indented code blocks are not supported anyway. */
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const ATX = /^\s{0,3}(#{1,6})(?:[ \t]+|$)/;
const SETEXT = /^\s{0,3}(=+|-+)\s*$/;
const THEMATIC = /^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_ITEM = /^(\s*)([-*+•●▪‣◦·]|\d{1,9}[.)])[ \t]+(?=\S)/;
const TASK = /^\[([ xX])\][ \t]+/;
const REF_DEF = /^\s{0,3}\[[^\]^][^\]]*\]:\s*\S+/;
const TABLE_DELIM = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const FRONT_MATTER_KEY = /^[A-Za-z_][\w-]*\s*:/;
/** A sentence or clause already ends here, so a following capitalised line is not a new block by itself. */
const ENDS_CLAUSE = /[.!?…:;,]["'”’)\]]*$/;
const ENDS_SENTENCE = /[.!?…]["'”’)\]]*$/;
const STARTS_SENTENCE = /^["'“‘(\[]?[\p{Lu}\d]/u;
/** Lines up to this long without closing punctuation look like titles or labels, not wrapped prose. */
const SHORT_LINE = 60;

const LANGUAGE_NAMES: Record<string, string> = {
  js: 'JavaScript',
  javascript: 'JavaScript',
  jsx: 'JavaScript',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TypeScript',
  py: 'Python',
  python: 'Python',
  sh: 'shell',
  bash: 'shell',
  shell: 'shell',
  zsh: 'shell',
  console: 'shell',
  ps: 'PowerShell',
  ps1: 'PowerShell',
  powershell: 'PowerShell',
  json: 'JSON',
  jsonc: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  html: 'HTML',
  xml: 'XML',
  css: 'CSS',
  scss: 'CSS',
  sql: 'SQL',
  go: 'Go',
  rust: 'Rust',
  rs: 'Rust',
  java: 'Java',
  kotlin: 'Kotlin',
  cs: 'C sharp',
  csharp: 'C sharp',
  cpp: 'C plus plus',
  'c++': 'C plus plus',
  c: 'C',
  rb: 'Ruby',
  ruby: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  diff: 'diff',
  text: 'text',
  txt: 'text',
  md: 'Markdown',
  markdown: 'Markdown',
  mermaid: 'diagram',
};

function codeNote(language: string, lines: number): string {
  const lang = language ? (LANGUAGE_NAMES[language.toLowerCase()] ?? language) : null;
  const count = `${lines} line${lines === 1 ? '' : 's'}`;
  return lang ? `Code block omitted: ${count} of ${lang}.` : `Code block omitted: ${count}.`;
}

interface Collector {
  format: DocFormat;
  blocks: DocBlock[];
  notes: DocNotes;
}

function addBlock(
  c: Collector,
  kind: BlockKind,
  build: (out: TextBuilder) => void,
  meta: { level?: number; marker?: string | null; ordinal?: number | null; quote: boolean; sourceStart: number; sourceEnd: number },
): void {
  const out = new TextBuilder();
  build(out);
  const { text, offsets } = out.build();
  if (text.trim() === '') return;
  c.blocks.push({
    kind,
    level: meta.level ?? 0,
    marker: meta.marker ?? null,
    ordinal: meta.ordinal ?? null,
    quote: meta.quote,
    text,
    offsets,
    sourceStart: meta.sourceStart,
    sourceEnd: meta.sourceEnd,
  });
}

function inline(c: Collector, raw: Raw, out: TextBuilder): void {
  if (c.format === 'markdown') inlineMarkdown(raw, out, c.notes);
  else inlinePlain(raw, out, c.notes);
}

/** A short capitalised line without closing punctuation: a title or label ("Agenda", "Action items"). */
function isLabelLine(text: string): boolean {
  return text.length <= SHORT_LINE && !ENDS_CLAUSE.test(text) && STARTS_SENTENCE.test(text);
}

/**
 * Paragraph lines → one or more paragraph blocks. Lines are joined as soft wraps, except that a label line stands
 * alone when it follows a finished sentence or precedes a capitalised line ("Agenda\nWe discussed…").
 */
function addParagraph(c: Collector, lines: Line[], kind: BlockKind = 'paragraph', level = 0): void {
  let group: Line[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const lines = group;
    group = [];
    const raw = rawFromLines(
      lines,
      lines.map((l) => l.text.length - l.text.trimStart().length),
    );
    addBlock(c, kind, (out) => inline(c, raw, out), {
      level,
      quote: lines[0].quote,
      sourceStart: lines[0].start,
      sourceEnd: lines[lines.length - 1].end,
    });
  };
  for (const line of lines) {
    const previous = group[group.length - 1];
    if (previous) {
      const prevText = previous.text.trim();
      const text = line.text.trim();
      const afterLabel = prevText.length <= SHORT_LINE && !ENDS_CLAUSE.test(prevText) && STARTS_SENTENCE.test(text);
      const labelAfterSentence = isLabelLine(text) && ENDS_SENTENCE.test(prevText);
      if (afterLabel || labelAfterSentence) flush();
    }
    group.push(line);
  }
  flush();
}

function parseTable(c: Collector, lines: Line[]): void {
  const cells = (line: Line): Raw[] => {
    const raw = rawFromLines([line]);
    const text = raw.text;
    let from = 0;
    let to = text.length;
    while (from < to && /\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to - 1])) to--;
    if (text[from] === '|') from++;
    if (to > from && text[to - 1] === '|' && text[to - 2] !== '\\') to--;
    const out: Raw[] = [];
    let start = from;
    for (let k = from; k <= to; k++) {
      if (k === to || (text[k] === '|' && text[k - 1] !== '\\')) {
        out.push(sliceRaw(raw, start, k));
        start = k + 1;
      }
    }
    return out;
  };
  const cellText = (raw: Raw): { text: string; offsets: Int32Array } => {
    const out = new TextBuilder();
    inline(c, raw, out);
    return out.build();
  };
  c.notes.tables++;
  const header = cells(lines[0]).map(cellText);
  const names = header.map((h) => h.text.trim());
  const quote = lines[0].quote;
  if (names.some((n) => n !== '')) {
    addBlock(
      c,
      'table-row',
      (out) => {
        out.pushSynthetic('Table: ', lines[0].start);
        header
          .filter((h) => h.text.trim() !== '')
          .forEach((h, i) => {
            if (i > 0) out.pushSynthetic(', ', h.offsets[0]);
            out.pushSource(h.text, h.offsets);
          });
      },
      { marker: 'table', quote, sourceStart: lines[0].start, sourceEnd: lines[1]?.end ?? lines[0].end },
    );
  }
  for (const line of lines.slice(2)) {
    const row = cells(line).map(cellText);
    addBlock(
      c,
      'table-row',
      (out) => {
        let first = true;
        row.forEach((cell, i) => {
          if (cell.text.trim() === '') return;
          if (!first) out.pushSynthetic(names[i] ? '; ' : ', ', cell.offsets[0]);
          first = false;
          if (names[i]) out.pushSynthetic(`${names[i]}: `, cell.offsets[0]);
          out.pushSource(cell.text, cell.offsets);
        });
      },
      { quote, sourceStart: line.start, sourceEnd: line.end },
    );
  }
}

function skipFrontMatter(lines: Line[]): number {
  if (lines.length < 3 || lines[0].text.trim() !== '---') return 0;
  for (let i = 1; i < Math.min(lines.length, 200); i++) {
    const t = lines[i].text.trim();
    if (t === '---' || t === '...') return i > 1 && FRONT_MATTER_KEY.test(lines[1].text.trim()) ? i + 1 : 0;
  }
  return 0;
}

function parseMarkdown(c: Collector, source: string): void {
  const lines = splitLines(source, true);
  let paragraph: Line[] = [];
  let item: { lines: Line[]; trims: number[]; indent: number; marker: string; ordinal: number | null; depth: number } | null = null;
  const listIndents: number[] = [];

  const closeParagraph = () => {
    if (paragraph.length > 0) addParagraph(c, paragraph);
    paragraph = [];
  };
  const closeItem = () => {
    if (!item) return;
    const it = item;
    item = null;
    const raw = rawFromLines(it.lines, it.trims);
    addBlock(c, 'list-item', (out) => inline(c, raw, out), {
      level: it.depth,
      marker: it.marker,
      ordinal: it.ordinal,
      quote: it.lines[0].quote,
      sourceStart: it.lines[0].start,
      sourceEnd: it.lines[it.lines.length - 1].end,
    });
  };
  const closeAll = () => {
    closeParagraph();
    closeItem();
  };

  let i = skipFrontMatter(lines);
  while (i < lines.length) {
    const line = lines[i];
    const text = line.text;

    if (isBlank(line)) {
      closeAll();
      i++;
      continue;
    }

    const fence = FENCE.exec(text);
    if (fence) {
      closeAll();
      const marker = fence[2];
      let j = i + 1;
      const closing = new RegExp(`^\\s*${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
      while (j < lines.length && !closing.test(lines[j].text)) j++;
      const bodyLines = Math.max(0, j - i - 1);
      const end = j < lines.length ? lines[j].end : lines[lines.length - 1].end;
      c.notes.codeBlocks++;
      addBlock(c, 'code', (out) => out.pushSynthetic(codeNote(fence[3], bodyLines), line.start, end), {
        quote: line.quote,
        sourceStart: line.start,
        sourceEnd: end,
      });
      i = Math.min(lines.length, j + 1);
      continue;
    }

    if (/^\s{0,3}<!--/.test(text) && !/-->/.test(text.slice(text.indexOf('<!--') + 4))) {
      closeAll();
      let j = i + 1;
      while (j < lines.length && !lines[j].text.includes('-->')) j++;
      i = j + 1;
      continue;
    }

    if (paragraph.length > 0 && !item && SETEXT.exec(text)) {
      const level = text.trim().startsWith('=') ? 1 : 2;
      const heading = paragraph;
      paragraph = [];
      const raw = rawFromLines(
        heading,
        heading.map((l) => l.text.length - l.text.trimStart().length),
      );
      addBlock(c, 'heading', (out) => inline(c, raw, out), {
        level,
        quote: heading[0].quote,
        sourceStart: heading[0].start,
        sourceEnd: line.end,
      });
      i++;
      continue;
    }

    if (THEMATIC.test(text)) {
      closeAll();
      i++;
      continue;
    }

    const atx = ATX.exec(text);
    if (atx) {
      closeAll();
      let content = text.slice(atx[0].length);
      const closingHashes = /(?:^|[ \t]+)#+[ \t]*$/.exec(content);
      if (closingHashes) content = content.slice(0, closingHashes.index);
      const raw = rawFromLines([{ text: content, start: line.start + atx[0].length }]);
      addBlock(c, 'heading', (out) => inline(c, raw, out), {
        level: atx[1].length,
        quote: line.quote,
        sourceStart: line.start,
        sourceEnd: line.end,
      });
      i++;
      continue;
    }

    if (text.includes('|') && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1].text) && lines[i + 1].text.includes('-')) {
      closeAll();
      let j = i + 2;
      while (j < lines.length && !isBlank(lines[j]) && lines[j].text.includes('|')) j++;
      parseTable(c, lines.slice(i, j));
      i = j;
      continue;
    }

    if (REF_DEF.test(text)) {
      closeAll();
      i++;
      continue;
    }

    const list = LIST_ITEM.exec(text);
    if (list) {
      closeAll();
      const indent = indentOf(list[1]);
      while (listIndents.length > 0 && listIndents[listIndents.length - 1] > indent) listIndents.pop();
      if (listIndents.length === 0 || listIndents[listIndents.length - 1] < indent) listIndents.push(indent);
      let skip = list[0].length;
      let marker = /\d/.test(list[2]) ? `${parseInt(list[2], 10)}.` : '•';
      const ordinal = /\d/.test(list[2]) ? parseInt(list[2], 10) : null;
      const task = TASK.exec(text.slice(skip));
      if (task) {
        marker = task[1] === ' ' ? '☐' : '☑';
        skip += task[0].length;
      }
      item = { lines: [line], trims: [skip], indent, marker, ordinal: task ? null : ordinal, depth: listIndents.length - 1 };
      i++;
      continue;
    }

    if (item) {
      // Continuation of a list item: indented, or a lazy wrap. An unindented capitalised line after a short
      // unpunctuated item is a new paragraph instead ("- item\nNext paragraph" without a blank line).
      const prev = item.lines[item.lines.length - 1].text.trim();
      const lazyParagraph = indentOf(text) < 2 && prev.length <= SHORT_LINE && !ENDS_CLAUSE.test(prev) && STARTS_SENTENCE.test(text.trim());
      if (!lazyParagraph) {
        item.lines.push(line);
        item.trims.push(text.length - text.trimStart().length);
        i++;
        continue;
      }
      closeItem();
    }

    if (paragraph.length > 0 && paragraph[paragraph.length - 1].quote !== line.quote) closeParagraph();
    listIndents.length = 0;
    paragraph.push(line);
    i++;
  }
  closeAll();
}

const PLAIN_ITEM = /^(\s*)([-*+•●▪‣◦·]|\d{1,3}[.)])[ \t]+(?=\S)/;

function parsePlain(c: Collector, source: string): void {
  const lines = splitLines(source, false);
  let paragraph: Line[] = [];
  let item: { lines: Line[]; trims: number[]; marker: string; ordinal: number | null } | null = null;
  const closeParagraph = () => {
    if (paragraph.length > 0) addParagraph(c, paragraph);
    paragraph = [];
  };
  const closeItem = () => {
    if (!item) return;
    const it = item;
    item = null;
    const raw = rawFromLines(it.lines, it.trims);
    addBlock(c, 'list-item', (out) => inline(c, raw, out), {
      marker: it.marker,
      ordinal: it.ordinal,
      quote: false,
      sourceStart: it.lines[0].start,
      sourceEnd: it.lines[it.lines.length - 1].end,
    });
  };
  for (const line of lines) {
    if (isBlank(line)) {
      closeParagraph();
      closeItem();
      continue;
    }
    const list = PLAIN_ITEM.exec(line.text);
    if (list) {
      closeParagraph();
      closeItem();
      const ordinal = /\d/.test(list[2]) ? parseInt(list[2], 10) : null;
      item = { lines: [line], trims: [list[0].length], marker: ordinal === null ? '•' : `${ordinal}.`, ordinal };
      continue;
    }
    if (item) {
      // A wrapped list item continues; a capitalised line after a short one starts a paragraph.
      const prev = item.lines[item.lines.length - 1].text.trim();
      if (prev.length <= SHORT_LINE && !ENDS_CLAUSE.test(prev) && STARTS_SENTENCE.test(line.text.trim())) {
        closeItem();
        paragraph.push(line);
      } else {
        item.lines.push(line);
        item.trims.push(line.text.length - line.text.trimStart().length);
      }
      continue;
    }
    paragraph.push(line);
  }
  closeParagraph();
  closeItem();
}

/** Parse and normalize a document. `format` 'auto' detects Markdown (see detectFormat). */
export function parseDocument(source: string, format: FormatChoice = 'auto'): ReadDocument {
  const resolved = format === 'auto' ? detectFormat(source) : format;
  const c: Collector = { format: resolved, blocks: [], notes: { codeBlocks: 0, tables: 0, images: 0, links: 0, urls: 0 } };
  if (resolved === 'markdown') parseMarkdown(c, source);
  else parsePlain(c, source);
  return { format: resolved, blocks: c.blocks, notes: c.notes, sourceLength: source.length };
}

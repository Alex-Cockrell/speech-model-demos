/**
 * Incremental sentence splitter: a faithful port of kokoro-js 1.2.1's TextSplitterStream (Apache-2.0,
 * https://github.com/hexgrad/kokoro/tree/main/kokoro.js), so text is cut into utterances exactly as before.
 * push() text, close() at the end; iterate (async) to receive sentences as they complete.
 */

function isSentenceTerminator(c: string, includeNewlines = true): boolean {
  return '.!?…。？！'.includes(c) || (includeNewlines && c === '\n');
}

function getTokenFromBuffer(buffer: string, start: number): string {
  let end = start;
  while (end < buffer.length && !/\s/.test(buffer[end])) ++end;
  return buffer.substring(start, end);
}

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'sgt', 'col', 'gen', 'rep', 'sen', 'gov', 'lt', 'maj', 'capt', 'st', 'mt',
  'etc', 'co', 'inc', 'ltd', 'dept', 'vs', 'p', 'pg', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept',
  'oct', 'nov', 'dec', 'sun', 'mon', 'tu', 'tue', 'tues', 'wed', 'th', 'thu', 'thur', 'thurs', 'fri', 'sat',
]);

function isAbbreviation(token: string): boolean {
  token = token.replace(/['’]s$/i, '').replace(/\.+$/, '');
  return ABBREVIATIONS.has(token.toLowerCase());
}

const MATCHING: Map<string, string> = new Map([
  [')', '('], [']', '['], ['}', '{'], ['》', '《'], ['〉', '〈'], ['›', '‹'], ['»', '«'], ['〉', '〈'], ['」', '「'],
  ['』', '『'], ['〕', '〔'], ['】', '【'],
]);
const OPENING = new Set(MATCHING.values());

function updateStack(c: string, stack: string[], i: number, buffer: string): void {
  if (c === '"' || c === "'") {
    // An apostrophe between letters (don't, it's) is not a quote.
    if (c === "'" && i > 0 && i < buffer.length - 1 && /[A-Za-z]/.test(buffer[i - 1]) && /[A-Za-z]/.test(buffer[i + 1])) return;
    if (stack.length && stack.at(-1) === c) stack.pop();
    else stack.push(c);
    return;
  }
  if (OPENING.has(c)) {
    stack.push(c);
    return;
  }
  const opener = MATCHING.get(c);
  if (opener && stack.length && stack.at(-1) === opener) stack.pop();
}

export class TextSplitterStream implements AsyncIterable<string>, Iterable<string> {
  private buffer = '';
  private queue: string[] = [];
  private resolver: (() => void) | null = null;
  private closed = false;

  push(...texts: string[]): void {
    for (const text of texts) {
      this.buffer += text;
      this.process();
    }
  }

  close(): void {
    if (this.closed) throw new Error('Stream is already closed.');
    this.closed = true;
    this.flush();
  }

  /** Emits whatever is buffered as a sentence. */
  flush(): void {
    const remainder = this.buffer.trim();
    if (remainder.length > 0) this.queue.push(remainder);
    this.buffer = '';
    this.resolve();
  }

  /** The queue of completed sentences (mutable: callers may enqueue a ready-made utterance). */
  get sentences(): string[] {
    return this.queue;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    if (this.resolver) throw new Error('Another iterator is already active.');
    for (;;) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.closed) {
        break;
      } else {
        await new Promise<void>((resolve) => {
          this.resolver = resolve;
        });
      }
    }
  }

  [Symbol.iterator](): Iterator<string> {
    this.flush();
    const iterator = this.queue[Symbol.iterator]();
    this.queue = [];
    return iterator;
  }

  private resolve(): void {
    if (this.resolver) {
      this.resolver();
      this.resolver = null;
    }
  }

  private process(): void {
    let sentenceStart = 0;
    const buffer = this.buffer;
    const len = buffer.length;
    let i = 0;
    const stack: string[] = [];

    const scanBoundary = (idx: number): { end: number; nextNonSpace: number } => {
      let end = idx;
      while (end + 1 < len && isSentenceTerminator(buffer[end + 1], false)) ++end;
      while (end + 1 < len && '"\')]}」』'.includes(buffer[end + 1])) ++end;
      let nextNonSpace = end + 1;
      while (nextNonSpace < len && /\s/.test(buffer[nextNonSpace])) ++nextNonSpace;
      return { end, nextNonSpace };
    };

    while (i < len) {
      const c = buffer[i];
      updateStack(c, stack, i, buffer);
      if (stack.length === 0 && isSentenceTerminator(c)) {
        const currentSegment = buffer.slice(sentenceStart, i);
        // A numbered list marker ("1.") is not a sentence end.
        if (/(^|\n)\d+$/.test(currentSegment)) {
          ++i;
          continue;
        }
        const { end: boundaryEnd, nextNonSpace } = scanBoundary(i);
        // No whitespace after the punctuation (e.g. "3.14", "e.g.x"): not a boundary.
        if (i === nextNonSpace - 1 && c !== '\n') {
          ++i;
          continue;
        }
        // Wait for more text before deciding.
        if (nextNonSpace === len) break;

        let tokenStart = i - 1;
        while (tokenStart >= 0 && /\S/.test(buffer[tokenStart])) tokenStart--;
        tokenStart = Math.max(sentenceStart, tokenStart + 1);
        const token = getTokenFromBuffer(buffer, tokenStart);
        if (!token) {
          ++i;
          continue;
        }
        // URLs and e-mail addresses.
        if ((/https?[,:]\/\//.test(token) || token.includes('@')) && !isSentenceTerminator(token.at(-1)!)) {
          i = tokenStart + token.length;
          continue;
        }
        if (isAbbreviation(token)) {
          ++i;
          continue;
        }
        // Initials followed by a capitalised word (J. R. R. Tolkien).
        if (/^([A-Za-z]\.)+$/.test(token) && nextNonSpace < len && /[A-Z]/.test(buffer[nextNonSpace])) {
          ++i;
          continue;
        }
        // A period followed by a lowercase letter.
        if (c === '.' && nextNonSpace < len && /[a-z]/.test(buffer[nextNonSpace])) {
          ++i;
          continue;
        }
        const sentence = buffer.substring(sentenceStart, boundaryEnd + 1).trim();
        if (sentence === '...' || sentence === '…') {
          ++i;
          continue;
        }
        if (sentence) this.queue.push(sentence);
        i = sentenceStart = boundaryEnd + 1;
      } else {
        ++i;
      }
    }
    this.buffer = buffer.substring(sentenceStart);
    if (this.queue.length > 0) this.resolve();
  }
}

/** Worker-only: imports kokoro-js. */
import { TextSplitterStream } from 'kokoro-js';
import type { TtsSettings } from '../types';

/** 'clause' mode breaks after , ; : followed by whitespace, keeping the punctuation with its clause. */
const CLAUSE_BREAK = /(?<=[,;:])\s+/;

/**
 * Builds the already-closed TextSplitterStream handed to KokoroTTS.stream().
 *
 * kokoro-js 1.2.1's stream(string) never closes its internal splitter: the final sentence is never yielded and
 * the generator never finishes. Its split_pattern pieces are also trimmed and re-joined without whitespace before
 * sentence splitting, so they do not produce separate chunks. Passing our own closed splitter avoids both.
 * In 'clause' mode, flush() after each clause emits it as its own chunk; sentence boundaries inside a clause
 * still split as usual.
 */
export function splitterFor(text: string, mode: TtsSettings['split']): TextSplitterStream {
  const splitter = new TextSplitterStream();
  if (mode === 'clause') {
    for (const clause of text.split(CLAUSE_BREAK)) {
      splitter.push(clause);
      splitter.flush();
    }
  } else {
    splitter.push(text);
  }
  splitter.close();
  return splitter;
}

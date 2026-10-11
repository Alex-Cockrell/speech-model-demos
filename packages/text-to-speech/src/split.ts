/** Builds the splitters handed to KokoroModel.stream(). */
import { TextSplitterStream } from './kokoro/splitter.js';
import type { TtsSettings } from './types.js';

/** 'clause' mode breaks after , ; : followed by whitespace, keeping the punctuation with its clause. */
const CLAUSE_BREAK = /(?<=[,;:])\s+/;

/**
 * Builds the already-closed TextSplitterStream handed to KokoroModel.stream() (which iterates it until closed).
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

/**
 * An already-closed TextSplitterStream that yields `text` as exactly one utterance (read aloud plans its own
 * pieces, see pieces.ts). push() would run the sentence detection on the text again; the `sentences`
 * getter returns the splitter's internal queue, so the piece is queued as is. Closing it is still required:
 * stream() iterates the splitter until it is closed.
 */
export function singlePieceSplitter(text: string): TextSplitterStream {
  const splitter = new TextSplitterStream();
  splitter.sentences.push(text);
  splitter.close();
  return splitter;
}

/**
 * Streaming text → reader pieces, for speaking an LLM reply while it is still arriving.
 *
 * Each update re-parses the whole buffer (parseDocument + planReading; linear and fast for chat-sized replies) and
 * commits every planned sentence except the last sentence of the last block, which may still grow. That boundary is
 * stable: splitSentences only ends a sentence once the next sentence's first character has arrived, and a sentence
 * that is not the last of its block keeps its spoken text whatever follows. The last block counts as closed (so its
 * last sentence commits too) once the buffer ends with a blank line outside a code fence. Progress is tracked by the
 * number of committed sentences, not offsets, so later inline changes (a link's URL arriving) cannot re-speak text.
 *
 * Held back further while the structure is ambiguous: an unclosed code fence (the block is announced only once it
 * closes), possible front matter (a leading `---`), and a trailing line containing `|` (it may become a table row).
 * end() commits everything left.
 */
import { parseDocument, type DocFormat } from './document.js';
import { planReading, type PlannedPiece, type SplitMode } from './pieces.js';
import type { ReaderPiece } from './reader.js';

export interface StreamingTextOptions {
  /** 'markdown' (default) cleans up markdown for listening; 'plain' reads the text as is. */
  format?: DocFormat;
  split?: SplitMode;
  /** Receives newly committed pieces, in order. */
  onPieces: (pieces: ReaderPiece[]) => void;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export class StreamingTextPlanner {
  private source = '';
  private committedSentences = 0;
  private ended = false;
  private readonly format: DocFormat;
  private readonly split: SplitMode;
  private readonly onPieces: (pieces: ReaderPiece[]) => void;

  constructor(options: StreamingTextOptions) {
    this.format = options.format ?? 'markdown';
    this.split = options.split ?? 'sentence';
    this.onPieces = options.onPieces;
  }

  /** The text received so far. */
  get text(): string {
    return this.source;
  }

  /** Appends a delta (e.g. the tokens just streamed). */
  push(delta: string): void {
    if (this.ended) throw new Error('push() after end(): the text has already ended.');
    if (!delta) return;
    const before = this.source;
    this.source += delta;
    // A sentence can only complete once whitespace has arrived after it; skip the re-parse otherwise.
    if (/\s/.test(delta) || /\s$/.test(before)) this.update(false);
  }

  /** The text is complete: commits whatever is left. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.update(true);
  }

  private update(final: boolean): void {
    const doc = parseDocument(this.source, this.format);
    const plan = planReading(doc.blocks, { split: this.split });
    let commit = plan.sentences.length;
    if (!final) {
      if (this.holdEverything()) return;
      const lastBlock = doc.blocks.length - 1;
      const lastBlockOpen = !this.lastBlockClosed() || this.trailingLineMayBeTable();
      if (lastBlockOpen && lastBlock >= 0) {
        // The last block's last sentence may still grow; a trailing table-ish line holds its whole block.
        const sentences = plan.blockSentences[lastBlock] ?? [];
        const held = this.trailingLineMayBeTable() ? sentences[0] : sentences[sentences.length - 1];
        if (held !== undefined) commit = Math.min(commit, held);
      }
    }
    if (commit <= this.committedSentences) return;
    const pieces: PlannedPiece[] = [];
    for (let s = this.committedSentences; s < commit; s++) {
      const sentence = plan.sentences[s];
      pieces.push(...plan.pieces.slice(sentence.firstPiece, sentence.firstPiece + sentence.pieceCount));
    }
    this.committedSentences = commit;
    const fresh = pieces.filter((p) => p.text.trim().length > 0).map((p) => ({ text: p.text, chars: p.chars }));
    if (fresh.length > 0) this.onPieces(fresh);
  }

  /** Possible front matter, or an unclosed code fence: nothing after it is certain yet. */
  private holdEverything(): boolean {
    if (this.format !== 'markdown') return false;
    if (/^---[ \t]*(\n|$)/.test(this.source) && !/^---[ \t]*\n[\s\S]*?\n(---|\.\.\.)[ \t]*(\n|$)/.test(this.source)) return true;
    return false;
  }

  /** The buffer ends with a blank line, outside any open code fence. */
  private lastBlockClosed(): boolean {
    if (!/\n[ \t]*\n\s*$/.test(this.source)) return false;
    return this.format !== 'markdown' || !this.insideFence();
  }

  private insideFence(): boolean {
    let open: string | null = null;
    for (const line of this.source.split('\n')) {
      const m = FENCE.exec(line);
      if (!m) continue;
      const marker = m[1];
      if (open === null) open = marker;
      else if (marker[0] === open[0] && marker.length >= open.length) open = null;
    }
    return open !== null;
  }

  private trailingLineMayBeTable(): boolean {
    if (this.format !== 'markdown') return false;
    const lines = this.source.replace(/\s+$/, '').split('\n');
    return lines[lines.length - 1]?.includes('|') ?? false;
  }
}

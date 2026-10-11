'use client';

import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { DocBlock } from '@localspeech/text-to-speech';
import type { PlannedSentence, ReadingPlan } from '@localspeech/text-to-speech';
import { cx } from '../ui';
import styles from './ReadAloud.module.css';

export type ReaderCommand = 'toggle' | 'prev' | 'next';

interface Props {
  plan: ReadingPlan;
  /** Sentence / piece being read (or waited for); null when nothing is playing. */
  activeSentence: number | null;
  activePiece: number | null;
  /** Playback is waiting for generation (start, seek or stall): the active sentence is shown as pending. */
  waiting: boolean;
  /** Where Play starts when stopped. */
  cursor: number | null;
  onSentence: (sentence: number) => void;
  onCommand: (command: ReaderCommand) => void;
}

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

/**
 * The document as it is read: blocks of clickable sentences, the active one highlighted and kept in view.
 * Scrolling by hand stops the follow until "Back to current sentence".
 */
export const ReaderText = memo(function ReaderText({ plan, activeSentence, activePiece, waiting, cursor, onSentence, onCommand }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const target = activeSentence ?? cursor;

  useEffect(() => {
    const container = box.current;
    if (!container || target === null || !following) return;
    const element = container.querySelector<HTMLElement>(`[data-s="${target}"]`);
    if (!element) return;
    const outer = container.getBoundingClientRect();
    const inner = element.getBoundingClientRect();
    const margin = Math.min(64, container.clientHeight / 5);
    if (inner.top >= outer.top + margin && inner.bottom <= outer.bottom - margin) return;
    const top = container.scrollTop + (inner.top - outer.top) - container.clientHeight / 3;
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    container.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  }, [target, following]);

  const stopFollowing = () => {
    if (activeSentence !== null) setFollowing(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const command: ReaderCommand | null =
      event.key === ' ' || event.key === 'k' ? 'toggle' : event.key === 'ArrowLeft' || event.key === 'j' ? 'prev' : event.key === 'ArrowRight' || event.key === 'l' ? 'next' : null;
    if (command) {
      event.preventDefault();
      onCommand(command);
    } else if (SCROLL_KEYS.has(event.key)) stopFollowing();
  };

  // Stable, so the memoised blocks only re-render when their own highlight changes.
  const clickSentence = useCallback(
    (index: number) => {
      // Selecting text with the mouse also ends in a click; do not jump then.
      if (window.getSelection()?.toString()) return;
      setFollowing(true);
      onSentence(index);
    },
    [onSentence],
  );

  return (
    <div className={styles.readerWrap}>
      <div
        ref={box}
        className={styles.reader}
        tabIndex={0}
        role="document"
        aria-label="Document being read. Space: play or pause. Left and right arrows: previous or next sentence."
        onWheel={stopFollowing}
        onTouchMove={stopFollowing}
        onKeyDown={onKeyDown}
      >
        {plan.blocks.map((block, b) => {
          const sentences = plan.blockSentences[b];
          const inBlock = (index: number | null) => (index !== null && sentences.includes(index) ? index : -1);
          return (
            <BlockView
              key={b}
              block={block}
              sentences={sentences}
              plan={plan}
              activeSentence={inBlock(activeSentence)}
              activePiece={inBlock(activeSentence) >= 0 ? activePiece : null}
              waiting={waiting && inBlock(activeSentence) >= 0}
              cursor={activeSentence === null ? inBlock(cursor) : -1}
              onSentence={clickSentence}
            />
          );
        })}
      </div>
      {!following && activeSentence !== null && (
        <button type="button" className={styles.followButton} onClick={() => setFollowing(true)}>
          Back to current sentence
        </button>
      )}
    </div>
  );
});

interface BlockProps {
  block: DocBlock;
  sentences: number[];
  plan: ReadingPlan;
  /** Active sentence if it is in this block, else -1 (keeps other blocks memoised). */
  activeSentence: number;
  activePiece: number | null;
  waiting: boolean;
  cursor: number;
  onSentence: (sentence: number) => void;
}

const BlockView = memo(function BlockView({ block, sentences, plan, activeSentence, activePiece, waiting, cursor, onSentence }: BlockProps) {
  const content: ReactNode[] = [];
  let at = 0;
  for (const index of sentences) {
    const sentence = plan.sentences[index];
    if (sentence.start > at) content.push(block.text.slice(at, sentence.start));
    content.push(
      <SentenceView
        key={index}
        text={block.text}
        sentence={sentence}
        plan={plan}
        active={index === activeSentence}
        activePiece={index === activeSentence ? activePiece : null}
        waiting={waiting && index === activeSentence}
        cursor={index === cursor}
        onSentence={onSentence}
      />,
    );
    at = sentence.end;
  }
  if (at < block.text.length) content.push(block.text.slice(at));

  const quote = block.quote && styles.quote;
  switch (block.kind) {
    case 'heading':
      return <p className={cx(styles.block, styles.heading, styles[`h${Math.min(block.level, 3)}`], quote)}>{content}</p>;
    case 'list-item':
      return (
        <div className={cx(styles.block, styles.listItem, quote)} style={{ marginLeft: `${block.level * 1.4}em` }}>
          <span className={styles.marker} aria-hidden="true">
            {block.marker}
          </span>
          <span>{content}</span>
        </div>
      );
    case 'table-row':
      return <div className={cx(styles.block, styles.tableRow, block.marker === 'table' && styles.tableHead, quote)}>{content}</div>;
    case 'code':
      return (
        <div className={cx(styles.block, quote)}>
          <span className={styles.codeNote}>
            <span aria-hidden="true">{'</>'}</span>
            <span>{content}</span>
          </span>
        </div>
      );
    default:
      return <p className={cx(styles.block, quote)}>{content}</p>;
  }
});

function SentenceView({
  text,
  sentence,
  plan,
  active,
  activePiece,
  waiting,
  cursor,
  onSentence,
}: {
  text: string;
  sentence: PlannedSentence;
  plan: ReadingPlan;
  active: boolean;
  activePiece: number | null;
  waiting: boolean;
  cursor: boolean;
  onSentence: (sentence: number) => void;
}) {
  const className = cx(styles.sentence, active && styles.current, waiting && styles.waiting, cursor && styles.cursor);
  let body: ReactNode = text.slice(sentence.start, sentence.end);
  if (active && sentence.pieceCount > 1 && activePiece !== null) {
    // A long sentence read in several pieces: mark the piece being spoken.
    const parts: ReactNode[] = [];
    let at = sentence.start;
    for (let p = sentence.firstPiece; p < sentence.firstPiece + sentence.pieceCount; p++) {
      const piece = plan.pieces[p];
      if (piece.start > at) parts.push(text.slice(at, piece.start));
      parts.push(
        <span key={p} className={cx(p === activePiece && styles.currentPiece)}>
          {text.slice(piece.start, piece.end)}
        </span>,
      );
      at = piece.end;
    }
    if (at < sentence.end) parts.push(text.slice(at, sentence.end));
    body = parts;
  }
  return (
    <span data-s={sentence.index} className={className} aria-current={active ? 'true' : undefined} onClick={() => onSentence(sentence.index)}>
      {body}
    </span>
  );
}

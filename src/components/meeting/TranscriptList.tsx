'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isLiveEcho, type LiveCandidate } from '@/lib/transcripts/echo';
import { compareSegments, visibleSegments } from '@/lib/transcripts/model';
import type { MeetingSegment, MeetingSpeaker } from '@/lib/transcripts/types';
import { cx } from '../ui';
import { OpenLine, SegmentLine, type EditMode, type LineActions } from './SegmentRow';
import type { DocState, OpenSegment } from './state';
import styles from './Meeting.module.css';

type Row = { kind: 'final'; segment: MeetingSegment } | { kind: 'open'; open: OpenSegment };

/** Final lines and still-open segments merged on the timeline. */
function mergeRows(segments: readonly MeetingSegment[], open: readonly OpenSegment[]): Row[] {
  const rows: Row[] = [];
  const pending = [...open].sort((a, b) => a.startMs - b.startMs);
  let j = 0;
  for (const segment of segments) {
    while (j < pending.length && compareSegments({ ...pending[j], id: pending[j].segmentId }, segment) < 0) {
      rows.push({ kind: 'open', open: pending[j++] });
    }
    rows.push({ kind: 'final', segment });
  }
  while (j < pending.length) rows.push({ kind: 'open', open: pending[j++] });
  return rows;
}

/** Call lines that can overlap a live microphone segment: segments are at most ~30 s long. */
const CALL_LOOKBACK_MS = 60_000;

/**
 * Live microphone text that already repeats the call audio around it is an echo still being spoken: with
 * duplicates hidden it is not shown either (its final text gets the definitive check).
 */
function withoutLiveEchoes(open: readonly OpenSegment[], segments: readonly MeetingSegment[]): readonly OpenSegment[] {
  const mics = open.filter((o) => o.source === 'mic' && o.text.trim() !== '');
  if (mics.length === 0) return open;
  const earliest = Math.min(...mics.map((o) => o.startMs)) - CALL_LOOKBACK_MS;
  const calls: LiveCandidate[] = open
    .filter((o) => o.source === 'system')
    .map((o) => ({ id: o.segmentId, startMs: o.startMs, endMs: null, text: o.text }));
  for (let i = segments.length - 1; i >= 0 && segments[i].startMs >= earliest; i--) {
    const s = segments[i];
    if (s.source === 'system') calls.push({ id: s.id, startMs: s.startMs, endMs: s.endMs, text: s.text });
  }
  if (calls.length === 0) return open;
  const hidden = new Set(
    mics.filter((o) => isLiveEcho({ id: o.segmentId, startMs: o.startMs, endMs: null, text: o.text }, calls)).map((o) => o.segmentId),
  );
  return hidden.size === 0 ? open : open.filter((o) => !hidden.has(o.segmentId));
}

/** Distance from the bottom that still counts as "at the live end". */
const STICK_PX = 48;

const NO_CHOICES: readonly MeetingSpeaker[] = [];

/**
 * The transcript. While `follow` is on (a running meeting) it sticks to the newest line unless the user scrolled
 * up; "Jump to live" goes back. Rows are memoized, so a partial update re-renders only its own line.
 */
export function TranscriptList({
  state,
  open,
  follow,
  showEcho,
  actions,
  emptyText,
}: {
  state: DocState;
  open: readonly OpenSegment[];
  follow: boolean;
  showEcho: boolean;
  actions: Omit<LineActions, 'setEditing'>;
  emptyText: string;
}) {
  const { doc, pendingSpeakers } = state;
  const docId = doc.transcript.id;
  const segments = doc.transcript.segments;
  const known = doc.registry.known;
  const speakers = doc.transcript.speakers;
  const [editing, setEditingState] = useState<{ id: string; mode: EditMode } | null>(null);
  const rows = useMemo(
    () => mergeRows(visibleSegments(segments, showEcho), showEcho ? open : withoutLiveEchoes(open, segments)),
    [segments, showEcho, open],
  );

  const setEditing = useCallback((segmentId: string | null, mode: EditMode = 'speaker') => {
    setEditingState(segmentId === null ? null : { id: segmentId, mode });
  }, []);
  const lineActions = useMemo<LineActions>(() => ({ ...actions, setEditing }), [actions, setEditing]);

  // A different transcript on screen: close any editor.
  const [shownDoc, setShownDoc] = useState(docId);
  if (shownDoc !== docId) {
    setShownDoc(docId);
    setEditingState(null);
  }

  const scrollRef = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || el.clientHeight === 0) return; // hidden (another tab is open)
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    stuck.current = atEnd;
    setShowJump(!atEnd);
  };

  // After every render: keep the newest line in view while following (not while the user edits a line).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && follow && stuck.current && !editing) el.scrollTop = el.scrollHeight;
  });

  // Becoming visible again (tab switch) or resizing: back to the live end if we were there.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (follow && stuck.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [follow]);

  // A new transcript starts at the top (saved) or the live end (running meeting).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    stuck.current = true;
    setShowJump(false);
    el.scrollTop = follow ? el.scrollHeight : 0;
    // Only when the document changes: a meeting that stops (follow → false) stays where it is.
  }, [docId]);

  const jumpToLive = () => {
    const el = scrollRef.current;
    if (!el) return;
    stuck.current = true;
    setShowJump(false);
    setEditingState(null);
    el.scrollTop = el.scrollHeight;
  };

  return (
    <div className={styles.transcriptWrap}>
      <div
        ref={scrollRef}
        className={cx(styles.transcript, !follow && styles.transcriptStatic)}
        onScroll={onScroll}
        tabIndex={0}
        aria-label="Transcript"
      >
        {rows.length === 0 ? (
          <p className={styles.empty}>{emptyText}</p>
        ) : (
          <ol className={styles.rows}>
            {rows.map((row) => {
              if (row.kind === 'open') return <OpenLine key={`open:${row.open.segmentId}`} open={row.open} />;
              const s = row.segment;
              const mode = editing?.id === s.id ? editing.mode : null;
              return (
                <SegmentLine
                  key={s.id}
                  docId={docId}
                  segment={s}
                  speaker={s.speakerId !== null ? (known[s.speakerId] ?? null) : null}
                  pending={pendingSpeakers.has(s.id)}
                  editing={mode}
                  choices={mode === 'speaker' ? speakers.filter((sp) => sp.source === s.source) : NO_CHOICES}
                  actions={lineActions}
                />
              );
            })}
          </ol>
        )}
      </div>
      {follow && showJump && (
        <button type="button" className={styles.jump} onClick={jumpToLive}>
          ↓ Jump to live
        </button>
      )}
    </div>
  );
}

'use client';

import { memo, useId, useState } from 'react';
import { formatOffset } from '@/lib/transcripts/export';
import type { SpeakerTarget } from '@/lib/transcripts/model';
import type { MeetingSegment, MeetingSpeaker } from '@/lib/transcripts/types';
import { cx } from '../ui';
import { SpeakerChip } from './SpeakerChip';
import type { OpenSegment } from './state';
import styles from './Meeting.module.css';
import panels from '../panels.module.css';

export type EditMode = 'speaker' | 'text';

/** Stable callbacks shared by every row (from the controller). */
export interface LineActions {
  setEditing(segmentId: string | null, mode?: EditMode): void;
  renameSpeaker(docId: string, speakerId: string, name: string): void;
  reassignSegment(docId: string, segmentId: string, target: SpeakerTarget): void;
  editSegmentText(docId: string, segmentId: string, text: string): void;
}

interface LineProps {
  docId: string;
  segment: MeetingSegment;
  speaker: MeetingSpeaker | null;
  pending: boolean;
  editing: EditMode | null;
  /** Same-source speakers to move the line to; only the row being edited gets them. */
  choices: readonly MeetingSpeaker[] | null;
  actions: LineActions;
}

const NEW_SPEAKER = '__new__';

/** One finalized line: [mm:ss] · speaker · text, with inline editors for its speaker and its text. */
export const SegmentLine = memo(function SegmentLine({ docId, segment, speaker, pending, editing, choices, actions }: LineProps) {
  const echo = segment.echoOf !== null;
  const toggle = (mode: EditMode) => actions.setEditing(editing === mode ? null : segment.id, mode);
  return (
    <li className={cx(styles.line, echo && styles.echo)}>
      <span className={styles.time}>{formatOffset(segment.startMs)}</span>
      <SpeakerChip
        speaker={speaker}
        source={segment.source}
        state={echo ? 'echo' : pending && !speaker ? 'pending' : undefined}
        onClick={() => toggle('speaker')}
        expanded={editing === 'speaker'}
      />
      {editing === 'text' ? (
        <TextEditor docId={docId} segment={segment} actions={actions} />
      ) : (
        <p className={styles.text}>
          {segment.text}
          {segment.originalText !== null && (
            <span className={styles.tag} title={`Recognized as: ${segment.originalText}`}>
              edited
            </span>
          )}
          {echo && (
            <span className={styles.tag} title="The microphone picked up the call audio from the speakers; the call audio line has the same words.">
              duplicate of call audio
            </span>
          )}
        </p>
      )}
      <span className={styles.lineActions}>
        {editing !== 'text' && (
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => toggle('text')}
            aria-label={`Correct the text of the line at ${formatOffset(segment.startMs)}`}
          >
            ✎ Edit
          </button>
        )}
      </span>
      {editing === 'speaker' && <SpeakerEditor docId={docId} segment={segment} speaker={speaker} choices={choices ?? []} actions={actions} />}
    </li>
  );
});

function SpeakerEditor({
  docId,
  segment,
  speaker,
  choices,
  actions,
}: {
  docId: string;
  segment: MeetingSegment;
  speaker: MeetingSpeaker | null;
  choices: readonly MeetingSpeaker[];
  actions: LineActions;
}) {
  const [name, setName] = useState(speaker?.name ?? '');
  const selectId = useId();
  const nameId = useId();
  const close = () => actions.setEditing(null);
  return (
    <div className={styles.editor} onKeyDown={(e) => e.key === 'Escape' && close()}>
      {speaker && (
        <form
          className={styles.editorRow}
          onSubmit={(e) => {
            e.preventDefault();
            actions.renameSpeaker(docId, speaker.id, name);
            close();
          }}
        >
          <label htmlFor={nameId}>
            Rename <strong>{speaker.name}</strong> on every line:
          </label>
          <input id={nameId} type="text" value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} />
          <button type="submit" className={panels.primaryButton}>
            Rename
          </button>
        </form>
      )}
      <div className={styles.editorRow}>
        <label htmlFor={selectId}>{segment.echoOf !== null ? 'Show this line as said by:' : 'Only this line was said by:'}</label>
        <select
          id={selectId}
          value={segment.echoOf !== null ? '' : (segment.speakerId ?? '')}
          autoFocus={!speaker}
          onChange={(e) => {
            const value = e.target.value;
            actions.reassignSegment(docId, segment.id, value === NEW_SPEAKER ? { newSpeaker: true } : value === '' ? null : value);
            close();
          }}
        >
          {choices.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          <option value={NEW_SPEAKER}>New speaker</option>
          <option value="">Unknown</option>
        </select>
        {segment.echoOf !== null && (
          <button
            type="button"
            onClick={() => {
              actions.reassignSegment(docId, segment.id, null);
              close();
            }}
          >
            Not a duplicate
          </button>
        )}
        <button type="button" onClick={close}>
          Done
        </button>
      </div>
    </div>
  );
}

function TextEditor({ docId, segment, actions }: { docId: string; segment: MeetingSegment; actions: LineActions }) {
  const [text, setText] = useState(segment.text);
  const close = () => actions.setEditing(null);
  const save = () => {
    actions.editSegmentText(docId, segment.id, text);
    close();
  };
  return (
    <form
      className={styles.textEditor}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <textarea
        value={text}
        autoFocus
        aria-label="Corrected text"
        rows={Math.min(6, Math.max(2, Math.ceil(text.length / 70)))}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
      />
      <div className={styles.editorRow}>
        <button type="submit" className={panels.primaryButton}>
          Save
        </button>
        <button type="button" onClick={close}>
          Cancel
        </button>
        {segment.originalText !== null && (
          <button
            type="button"
            title={segment.originalText}
            onClick={() => {
              actions.editSegmentText(docId, segment.id, segment.originalText ?? segment.text);
              close();
            }}
          >
            Restore recognized text
          </button>
        )}
        <span className="muted">Enter saves · Esc cancels</span>
      </div>
    </form>
  );
}

/** A segment still being spoken: its live partial text, dimmed. */
export const OpenLine = memo(function OpenLine({ open }: { open: OpenSegment }) {
  return (
    <li className={cx(styles.line, styles.partial)}>
      <span className={styles.time}>{formatOffset(open.startMs)}</span>
      <SpeakerChip speaker={null} source={open.source} state="live" />
      <p className={styles.text}>{open.text}</p>
      <span />
    </li>
  );
});

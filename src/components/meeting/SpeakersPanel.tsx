'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { speakerUsage, type SpeakerUsage } from '@/lib/transcripts/model';
import type { MeetingSpeaker } from '@/lib/transcripts/types';
import type { AudioSourceKind } from '@/lib/types';
import { fmtClock } from '../format';
import { ConfirmButton, Notice, Panel, SelectField, cx } from '../ui';
import type { MeetingController } from './controller';
import { fmtDuration, plural } from './format';
import { SourceIcon } from './icons';
import { SpeakerDot } from './SpeakerChip';
import type { DocState } from './state';
import styles from './Meeting.module.css';
import panels from '../panels.module.css';

const COUNT_OPTIONS = [
  { value: 0, label: 'Auto' },
  ...Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: String(i + 1) })),
];

export function SpeakersPanel({ state, isMeeting, controller: c }: { state: DocState; isMeeting: boolean; controller: MeetingController }) {
  const t = state.doc.transcript;
  const docId = t.id;
  const pendingSpeakers = state.pendingSpeakers;
  const usage = useMemo(() => speakerUsage(t.segments), [t.segments]);
  // Lines still being identified are not "Unknown" (yet).
  const identifying = useMemo(
    () => t.segments.filter((s) => s.speakerId === null && s.echoOf === null && pendingSpeakers.has(s.id)).length,
    [t.segments, pendingSpeakers],
  );
  const unknownLines = (usage.get('')?.lines ?? 0) - identifying;
  const sourcesWithSpeakers = t.sources.length > 1;
  return (
    <Panel title="Speakers" subtitle={t.speakers.length > 0 ? plural(t.speakers.length, 'speaker') : undefined}>
      {identifying > 0 && (
        <p className={panels.hint} aria-live="polite">
          Identifying the speaker of {plural(identifying, 'line')}…
        </p>
      )}
      {t.speakers.length === 0 && unknownLines === 0 ? (
        <p className="muted">Speakers show up here as people talk.</p>
      ) : (
        <ul className={styles.speakerList}>
          {t.speakers.map((s) => (
            <SpeakerItem
              key={s.id}
              speaker={s}
              usage={usage.get(s.id)}
              showSource={sourcesWithSpeakers}
              others={t.speakers.filter((o) => o.source === s.source && o.id !== s.id)}
              onRename={(name) => c.renameSpeaker(docId, s.id, name)}
              onMerge={(intoId) => c.mergeSpeakers(docId, s.id, intoId)}
            />
          ))}
          {unknownLines > 0 && (
            <li className={styles.speakerItem} title="Too short to identify, or set by hand. Click a line's speaker to assign it.">
              <span className={cx(styles.speaker, styles.chipMuted)}>
                <SpeakerDot hollow />
                <span className={styles.speakerName}>Unknown</span>
              </span>
              <span className={styles.speakerUsage}>{plural(unknownLines, 'line')}</span>
              <span />
            </li>
          )}
        </ul>
      )}
      <p className={panels.hint}>
        Click a name to rename that speaker everywhere. To move a single line, click the speaker on that line in the transcript.
        {t.sources.length > 1 ? ' Microphone and call speakers are identified separately.' : ''}
      </p>
      {isMeeting && <Reidentify state={state} sources={t.sources} onRun={c.reidentify} />}
    </Panel>
  );
}

function SpeakerItem({
  speaker,
  usage,
  showSource,
  others,
  onRename,
  onMerge,
}: {
  speaker: MeetingSpeaker;
  usage: SpeakerUsage | undefined;
  showSource: boolean;
  others: readonly MeetingSpeaker[];
  onRename: (name: string) => void;
  onMerge: (intoId: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(speaker.name);
  const [merging, setMerging] = useState(false);
  const [into, setInto] = useState('');
  const cancelled = useRef(false);
  const selectId = useId();

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
    } else if (name.trim() !== speaker.name) {
      onRename(name);
    }
    setRenaming(false);
  };

  return (
    <li className={styles.speakerItem}>
      {renaming ? (
        <form
          className={styles.renameForm}
          onSubmit={(e) => {
            e.preventDefault();
            commit();
          }}
        >
          <input
            type="text"
            value={name}
            maxLength={60}
            autoFocus
            aria-label={`New name for ${speaker.name}`}
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                cancelled.current = true;
                e.currentTarget.blur();
              }
            }}
          />
        </form>
      ) : (
        <button
          type="button"
          className={styles.speaker}
          title="Rename everywhere"
          onClick={() => {
            setName(speaker.name);
            setRenaming(true);
          }}
        >
          <SpeakerDot number={speaker.number} />
          <span className={styles.speakerName}>{speaker.name}</span>
          {showSource && <SourceIcon source={speaker.source} className={styles.sourceIcon} />}
        </button>
      )}
      <span className={styles.speakerUsage}>
        {plural(usage?.lines ?? 0, 'line')} · {fmtDuration(usage?.talkMs ?? 0)}
      </span>
      {others.length > 0 && !merging ? (
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => setMerging(true)}
          title={`${speaker.name} is the same person as another speaker`}
        >
          Merge…
        </button>
      ) : (
        <span />
      )}
      {others.length > 0 && merging && (
        <div className={styles.speakerTools}>
          <label htmlFor={selectId}>Same person as</label>
          <select id={selectId} value={into} onChange={(e) => setInto(e.target.value)}>
            <option value="">Choose…</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <ConfirmButton
            label="Merge"
            confirmLabel="Confirm merge"
            disabled={!into}
            title={`Move every line of ${speaker.name} to the chosen speaker. Cannot be undone, but single lines can be moved back.`}
            onConfirm={() => {
              onMerge(into);
              setMerging(false);
              setInto('');
            }}
          />
          <button type="button" onClick={() => setMerging(false)}>
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

function Reidentify({
  state,
  sources,
  onRun,
}: {
  state: DocState;
  sources: readonly AudioSourceKind[];
  onRun: (counts?: Partial<Record<AudioSourceKind, number>>) => Promise<void>;
}) {
  const [counts, setCounts] = useState<Partial<Record<AudioSourceKind, number>>>({});
  const r = state.reidentify;
  if (!state.canReidentify) {
    return <p className={panels.hint}>Speaker identification was off for this meeting (the speaker model was not loaded).</p>;
  }
  const chosen = Object.fromEntries(Object.entries(counts).filter(([, n]) => (n ?? 0) > 0)) as Partial<Record<AudioSourceKind, number>>;
  return (
    <div className={styles.reidentify}>
      <div className={styles.sectionTitle}>Re-identify speakers</div>
      <p className={panels.hint}>
        Groups every line again using the whole meeting so far, which is more accurate than the live labels. Names you gave
        stay with the speakers that remain. Lines you moved by hand stay where you put them.
      </p>
      <div className={styles.counts}>
        {sources.map((source) => (
          <SelectField
            key={source}
            label={`People on ${source === 'mic' ? 'the microphone' : 'the call'}`}
            value={counts[source] ?? 0}
            options={COUNT_OPTIONS}
            onChange={(n) => setCounts((c) => ({ ...c, [source]: n }))}
            hint={source === 'mic' ? 'In the room, including you' : 'Remote participants'}
          />
        ))}
      </div>
      <div className={panels.buttonRow}>
        <button type="button" onClick={() => void onRun(chosen)} disabled={r.running}>
          {r.running ? 'Re-identifying…' : 'Re-identify speakers'}
        </button>
      </div>
      {r.error && (
        <Notice tone="err" title="Re-identification failed">
          {r.error}
        </Notice>
      )}
      {r.doneAt && !r.running && !r.error && (
        <p className={panels.hint} aria-live="polite">
          Re-identified at {fmtClock(r.doneAt)}.
        </p>
      )}
    </div>
  );
}

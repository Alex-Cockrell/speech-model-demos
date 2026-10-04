'use client';

import { useState } from 'react';
import type { TranscriptSummary } from '@/lib/transcripts/types';
import { Chip, ConfirmButton, Notice, Panel, cx } from '../ui';
import type { MeetingController } from './controller';
import { ExportControls } from './ExportControls';
import { fmtDateTime, fmtDuration, plural } from './format';
import { SourceIcon } from './icons';
import { isSessionActive, summaryState, type MeetingSnapshot, type SummaryState } from './state';
import { TitleInput } from './TitleInput';
import styles from './Meeting.module.css';

/** Every saved meeting in this browser profile: rename, open, export, delete. */
export function SavedPanel({ meeting: m, controller: c }: { meeting: MeetingSnapshot; controller: MeetingController }) {
  const { library } = m;
  const running = isSessionActive(m.phase);
  const runningId = running ? (m.meeting?.doc.transcript.id ?? null) : null;
  const shownId = (m.viewer ?? m.meeting)?.doc.transcript.id ?? null;
  const nowMs = Date.now();
  return (
    <Panel
      title="Saved transcripts"
      subtitle="In this browser only"
      actions={
        <button type="button" onClick={() => void c.refreshLibrary()} disabled={library.loading}>
          Refresh
        </button>
      }
    >
      {library.error && (
        <Notice tone="err" title="Saved transcripts">
          {library.error}
        </Notice>
      )}
      {!library.loaded ? (
        <p className="muted">Loading…</p>
      ) : library.items.length === 0 ? (
        <p className="muted">Meetings are saved here automatically while they run.</p>
      ) : (
        <ul className={styles.savedList}>
          {library.items.map((item) => (
            <SavedItem
              key={item.id}
              item={item}
              state={summaryState(item, runningId, library.recordingIds, nowMs, c.timing.staleRecordingMs)}
              shown={item.id === shownId}
              openBlocked={running ? 'Stop the meeting first.' : null}
              controller={c}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

const STATE_CHIP: Record<SummaryState, { tone: 'ok' | 'warn' | 'info' | 'neutral'; label: string; title: string } | null> = {
  complete: null,
  'recording-here': { tone: 'info', label: 'Recording now', title: 'This meeting is running on this page; it is saved every few seconds.' },
  'recording-elsewhere': { tone: 'info', label: 'Recording in another tab', title: 'Another tab of this app is still saving this meeting.' },
  interrupted: {
    tone: 'warn',
    label: 'Interrupted',
    title: 'The page was closed or crashed while this meeting ran; it ends at the last autosave.',
  },
};

function SavedItem({
  item,
  state,
  shown,
  openBlocked,
  controller: c,
}: {
  item: TranscriptSummary;
  state: SummaryState;
  shown: boolean;
  openBlocked: string | null;
  controller: MeetingController;
}) {
  const [exporting, setExporting] = useState(false);
  const chip = STATE_CHIP[state];
  const recording = state === 'recording-here' || state === 'recording-elsewhere';
  return (
    <li className={cx(styles.savedItem, shown && styles.savedItemShown)}>
      <TitleInput
        key={item.title}
        value={item.title}
        label="Transcript title"
        className={styles.savedTitle}
        onCommit={(title) => void c.setTitle(item.id, title)}
      />
      <div className={styles.savedMeta}>
        <span>{fmtDateTime(item.createdAt)}</span>
        <span>{fmtDuration(item.durationMs)}</span>
        <span>{plural(item.speakerCount, 'speaker')}</span>
        <span>{plural(item.segmentCount, 'line')}</span>
        {item.sources.map((s) => (
          <SourceIcon key={s} source={s} className={styles.metaIcon} />
        ))}
        {chip && (
          <Chip tone={chip.tone} title={chip.title}>
            {chip.label}
          </Chip>
        )}
      </div>
      <div className={styles.savedActions}>
        <button
          type="button"
          onClick={() => void c.openSaved(item.id)}
          disabled={shown || openBlocked !== null || state === 'recording-elsewhere'}
          title={shown ? 'On screen' : (openBlocked ?? (state === 'recording-elsewhere' ? 'Another tab is recording this meeting.' : undefined))}
        >
          {shown ? 'Open ✓' : 'Open'}
        </button>
        <button type="button" onClick={() => setExporting((v) => !v)} aria-expanded={exporting}>
          Export…
        </button>
        <ConfirmButton
          label="Delete"
          confirmLabel="Confirm: delete for good"
          disabled={recording}
          title={recording ? 'A meeting that is still recording cannot be deleted.' : 'Deletes this transcript from this browser'}
          onConfirm={() => void c.deleteSaved(item.id)}
        />
      </div>
      {exporting && <ExportControls load={() => c.loadTranscript(item.id)} echoLines={item.echoLines} />}
    </li>
  );
}

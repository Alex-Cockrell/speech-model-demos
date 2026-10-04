'use client';

import { useCallback, useMemo } from 'react';
import { echoCount } from '@/lib/transcripts/model';
import type { MeetingTranscript } from '@/lib/transcripts/types';
import type { AudioSourceKind, ModelSummary, ResolvedBackend } from '@/lib/types';
import { BACKEND_LABEL, DASH, fmtClock, fmtInt, fmtMs, fmtRtf } from '../format';
import { Kv, KvList, Notice, Panel } from '../ui';
import type { MeetingController } from './controller';
import { ExportControls } from './ExportControls';
import { fmtDateTime, fmtDuration, plural } from './format';
import { SourceIcon } from './icons';
import { LiveBar } from './LiveBar';
import { SOURCE_LABEL, isSessionActive, type DocState, type MeetingNotice, type MeetingSnapshot, type OpenSegment, type SaveState } from './state';
import { TitleInput } from './TitleInput';
import { TranscriptList } from './TranscriptList';
import styles from './Meeting.module.css';
import panels from '../panels.module.css';
import ui from '../ui.module.css';

const NO_OPEN: readonly OpenSegment[] = [];

/** A transcript on screen: this page's meeting (running or ended) or a saved one opened from the list. */
export function DocPanel({
  kind,
  state,
  meeting: m,
  controller: c,
  backend,
}: {
  kind: 'meeting' | 'saved';
  state: DocState;
  meeting: MeetingSnapshot;
  controller: MeetingController;
  backend: ResolvedBackend | null;
}) {
  const t = state.doc.transcript;
  const isMeeting = kind === 'meeting';
  const running = isMeeting && isSessionActive(m.phase);
  const live = running ? m.live : null;
  const echoLines = useMemo(() => echoCount(t.segments), [t.segments]);
  const actions = useMemo(
    () => ({ renameSpeaker: c.renameSpeaker, reassignSegment: c.reassignSegment, editSegmentText: c.editSegmentText }),
    [c],
  );
  const id = t.id;
  const load = useCallback(() => c.loadTranscript(id), [c, id]);

  return (
    <Panel
      title={!isMeeting ? 'Saved transcript' : running ? 'Meeting' : 'Meeting ended'}
      subtitle={<SaveStatus save={state.save} />}
      actions={
        isMeeting ? (
          m.phase === 'stopped' ? (
            <button type="button" className={panels.primaryButton} onClick={c.newMeeting}>
              New meeting
            </button>
          ) : null
        ) : (
          <button type="button" onClick={c.closeViewer}>
            Close
          </button>
        )
      }
    >
      <TitleInput
        key={t.title}
        value={t.title}
        label="Meeting title"
        className={styles.titleInput}
        onCommit={(title) => void c.setTitle(id, title)}
      />
      <DocMeta transcript={t} running={running} />
      {!isMeeting && state.status === 'interrupted' && (
        <Notice tone="warn" title="This meeting was cut off">
          The page was closed or crashed while it ran, so the transcript ends at its last autosave (they happen about every 10 s).
        </Notice>
      )}
      {live && <LiveBar phase={m.phase} live={live} controller={c} backend={backend} />}
      {isMeeting && <MeetingNotices notices={m.notices} onDismiss={c.dismissNotice} />}
      {state.save.phase === 'error' && (
        <Notice tone="err" title={running ? 'Autosave failed' : 'Not saved'}>
          {state.save.error}{' '}
          {running
            ? 'The meeting keeps running and saving is retried every 10 s; export the transcript if this persists.'
            : 'Your changes are kept on this page and saved again with the next change; export to keep a copy.'}
        </Notice>
      )}
      <div className={styles.toolbar}>
        {echoLines > 0 ? (
          <label className={styles.check} title="Microphone lines that repeat the call audio because the microphone heard the laptop's speakers">
            <input type="checkbox" checked={m.showEcho} onChange={(e) => c.setShowEcho(e.target.checked)} />
            Show {plural(echoLines, 'hidden duplicate line')}
          </label>
        ) : (
          <span />
        )}
        <ExportControls load={load} echoLines={echoLines} />
      </div>
      <TranscriptList
        state={state}
        open={live ? live.open : NO_OPEN}
        follow={running}
        showEcho={m.showEcho}
        actions={actions}
        emptyText={running ? (m.phase === 'paused' ? 'Paused.' : 'Listening… lines appear here as people speak.') : 'No lines were transcribed.'}
      />
      {!running && t.stats && <SessionStatsView transcript={t} />}
    </Panel>
  );
}

function SaveStatus({ save }: { save: SaveState }) {
  switch (save.phase) {
    case 'saving':
      return <>Saving…</>;
    case 'pending':
      return <>Unsaved changes…</>;
    case 'saved':
      return <>Saved{save.savedAt ? ` ${fmtClock(save.savedAt)}` : ''}</>;
    case 'error':
      return <span className={ui.inlineError}>Not saved</span>;
    default:
      return null;
  }
}

function DocMeta({ transcript: t, running }: { transcript: MeetingTranscript; running: boolean }) {
  const lines = useMemo(() => t.segments.filter((s) => s.echoOf === null).length, [t.segments]);
  return (
    <div className={styles.meta}>
      <span className={styles.metaItem}>
        {running ? 'Started ' : ''}
        {fmtDateTime(t.createdAt)}
      </span>
      {!running && <span className={styles.metaItem}>{fmtDuration(t.durationMs)}</span>}
      {t.sources.map((s) => (
        <span key={s} className={styles.metaItem}>
          <SourceIcon source={s} className={styles.metaIcon} labelled={false} />
          {SOURCE_LABEL[s]}
        </span>
      ))}
      <span className={styles.metaItem}>{plural(lines, 'line')}</span>
      <span className={styles.metaItem}>{plural(t.speakers.length, 'speaker')}</span>
    </div>
  );
}

function MeetingNotices({ notices, onDismiss }: { notices: readonly MeetingNotice[]; onDismiss: (id: number) => void }) {
  if (notices.length === 0) return null;
  return (
    <div className={styles.notices}>
      {notices.map((n) => (
        <Notice key={n.id} tone={n.tone} title={n.count > 1 ? `${n.title} (×${n.count})` : n.title}>
          {n.message}
          <button type="button" className={styles.linkButton} onClick={() => onDismiss(n.id)}>
            Dismiss
          </button>
        </Notice>
      ))}
    </div>
  );
}

/** Backend and precision only: the stored model name is not shown. */
function modelLine(m: ModelSummary | null): string {
  if (!m) return DASH;
  const quant = Object.values(m.quantization).join(' / ');
  return `${BACKEND_LABEL[m.backend]}${quant ? ` · ${quant}` : ''}`;
}

function SessionStatsView({ transcript: t }: { transcript: MeetingTranscript }) {
  const s = t.stats;
  if (!s) return null;
  const audio = (Object.entries(s.audioMs) as [AudioSourceKind, number][])
    .map(([source, ms]) => `${SOURCE_LABEL[source].toLowerCase()} ${fmtDuration(ms)}`)
    .join(' · ');
  return (
    <details className={panels.details}>
      <summary>Session stats</summary>
      <KvList numeric>
        <Kv label="Audio captured">{audio || DASH}</Kv>
        <Kv label="ASR compute">{fmtMs(s.asrComputeMs)}</Kv>
        <Kv label="Real-time factor" hint="compute / audio; must stay well below 1">
          {fmtRtf(s.rtf)}
        </Kv>
        <Kv label="Final text latency" hint="end of speech → final text: median / max">
          {fmtMs(s.finalLatency.medianMs)} / {fmtMs(s.finalLatency.maxMs)}
        </Kv>
        <Kv label="Max backlog">{fmtMs(s.maxBacklogMs)}</Kv>
        <Kv label="Skipped live updates">{fmtInt(s.skippedPartials)}</Kv>
        <Kv label="Segments transcribed">{fmtInt(s.segments)}</Kv>
        <Kv label="Speaker compute">{fmtMs(s.speakerComputeMs)}</Kv>
        <Kv label="Transcription model">{modelLine(t.models.asr)}</Kv>
        <Kv label="Speaker model">{modelLine(t.models.speaker)}</Kv>
        <Kv label="App">
          v{t.app.version}
          {t.app.commit ? ` · ${t.app.commit.slice(0, 7)}` : ''}
        </Kv>
      </KvList>
    </details>
  );
}

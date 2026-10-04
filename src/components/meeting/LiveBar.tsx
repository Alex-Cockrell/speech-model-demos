'use client';

import { useSyncExternalStore } from 'react';
import type { AudioSourceKind, ResolvedBackend } from '@/lib/types';
import type { LevelStore } from '../pipeline/levelStore';
import { BACKEND_LABEL, DASH, fmtInt, fmtMs, fmtRtf } from '../format';
import { Notice, cx, useTicker } from '../ui';
import type { MeetingController } from './controller';
import { fmtDuration } from './format';
import { SourceIcon } from './icons';
import { SOURCE_LABEL, type LiveState, type MeetingPhase } from './state';
import styles from './Meeting.module.css';

/** Clock, Pause/Resume/Stop, a level meter per source, live throughput and the "can't keep up" warning. */
export function LiveBar({
  phase,
  live,
  controller: c,
  backend,
}: {
  phase: MeetingPhase;
  live: LiveState;
  controller: MeetingController;
  backend: ResolvedBackend | null;
}) {
  const running = phase === 'live' || phase === 'paused';
  return (
    <div className={styles.liveBar}>
      <div className={styles.liveTop}>
        <span className={styles.recording} aria-live="polite">
          <span className={cx(styles.recDot, phase !== 'live' && styles.recDotPaused)} aria-hidden="true" />
          {phase === 'live' ? 'Transcribing' : phase === 'paused' ? 'Paused: audio is ignored' : 'Finishing the last lines…'}
        </span>
        <Clock since={live.startedAt} active={running} />
        <div className={styles.liveButtons}>
          {phase === 'paused' ? (
            <button type="button" onClick={c.resume}>
              <span aria-hidden="true">▶</span> Resume
            </button>
          ) : (
            <button type="button" onClick={c.pause} disabled={phase !== 'live'}>
              <span aria-hidden="true">❚❚</span> Pause
            </button>
          )}
          <button type="button" className={styles.stopButton} onClick={c.stop} disabled={!running}>
            <span aria-hidden="true">■</span> {phase === 'stopping' ? 'Stopping…' : 'Stop'}
          </button>
        </div>
      </div>
      <div className={styles.levels}>
        {live.sources.map((source) => (
          <SourceLevel
            key={source}
            source={source}
            store={c.levels[source]}
            active={phase === 'live' && !live.ended[source]}
            ended={live.ended[source] ?? null}
          />
        ))}
      </div>
      <LiveStats live={live} />
      {live.behind && <BehindWarning live={live} backend={backend} />}
    </div>
  );
}

/** Wall-clock length of the meeting (pauses included, like Transcript.durationMs). */
function Clock({ since, active }: { since: number | null; active: boolean }) {
  const t = useTicker(active, 500);
  return (
    <span className={styles.clock} role="timer" aria-label="Elapsed time">
      {since == null ? '0:00' : fmtDuration(t - since)}
    </span>
  );
}

/** Subscribes to its level store directly, so ~20 updates/s re-render only this meter. */
function SourceLevel({ source, store, active, ended }: { source: AudioSourceKind; store: LevelStore; active: boolean; ended: string | null }) {
  const rms = useSyncExternalStore(store.subscribe, store.get, store.get);
  const db = active && rms > 0 ? 20 * Math.log10(rms) : null;
  const fraction = db == null ? 0 : Math.min(1, Math.max(0, (db + 60) / 60));
  return (
    <div className={styles.level}>
      <span className={styles.levelLabel}>
        <SourceIcon source={source} className={styles.metaIcon} labelled={false} />
        {SOURCE_LABEL[source]}
      </span>
      {ended ? (
        <span className={styles.levelEnded}>Ended: {ended}</span>
      ) : (
        <>
          <div
            className={styles.levelTrack}
            role="meter"
            aria-label={`${SOURCE_LABEL[source]} level`}
            aria-valuemin={-60}
            aria-valuemax={0}
            aria-valuenow={db == null ? -60 : Math.round(db)}
          >
            <div className={cx(styles.levelFill, db != null && db > -3 && styles.levelHot)} style={{ width: `${fraction * 100}%` }} />
          </div>
          <span className={cx('num', styles.levelValue)}>{db == null ? DASH : `${Math.round(db)} dB`}</span>
        </>
      )}
    </div>
  );
}

function LiveStats({ live }: { live: LiveState }) {
  const s = live.stats;
  return (
    <dl className={styles.stats}>
      <div title="ASR compute time / audio duration. Must stay well below 1 for the meeting to keep up.">
        <dt>RTF</dt>
        <dd>{fmtRtf(s?.rtf)}</dd>
      </div>
      <div title="Speech that has ended but is not transcribed yet. Growing means this machine can't keep up.">
        <dt>Backlog</dt>
        <dd>{s ? fmtMs(s.backlogMs) : DASH}</dd>
      </div>
      <div title="Worst backlog so far">
        <dt>Max backlog</dt>
        <dd>{s ? fmtMs(live.maxBacklogMs) : DASH}</dd>
      </div>
      <div title="Segments waiting for or in their final pass">
        <dt>Queue</dt>
        <dd>{fmtInt(s?.queueDepth)}</dd>
      </div>
      <div title="Live-text updates skipped because inference was busy">
        <dt>Skipped updates</dt>
        <dd>{fmtInt(s?.skippedPartials)}</dd>
      </div>
    </dl>
  );
}

function BehindWarning({ live, backend }: { live: LiveState; backend: ResolvedBackend | null }) {
  const backlog = live.stats?.backlogMs ?? live.maxBacklogMs;
  const two = live.sources.filter((s) => !live.ended[s]).length > 1;
  const advice =
    backend === 'wasm'
      ? 'Switch the backend to WebGPU (Benchmark tab → Settings → Backend, then Load models again before the next meeting)' +
        (two ? ', or transcribe one source only.' : '.')
      : two
        ? 'Transcribe one source only, or close other heavy apps.'
        : 'Close other heavy apps; lines will catch up when people pause.';
  return (
    <Notice tone="warn" title="This machine can't keep up">
      {fmtMs(backlog)} of speech is waiting to be transcribed{two ? ' from two sources' : ''}
      {backend ? ` on ${BACKEND_LABEL[backend]}` : ''}, so lines appear late. {advice}
    </Notice>
  );
}

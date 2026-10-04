'use client';

import { useMemo, useSyncExternalStore } from 'react';
import { alignWords, toWords, type AlignmentOp } from '@/lib/accuracy/wer';
import { BENCHMARK_PHRASES, findPhrase } from '@/lib/benchmark/phrases';
import type { AppSettings } from '@/lib/benchmark/settings';
import { describeTestCase } from '@/lib/benchmark/testMatrix';
import type { AccuracyResult } from '@/lib/types';
import { isRunActive, type RunState } from './pipeline/state';
import type { LevelStore } from './pipeline/levelStore';
import type { TestCaseStatus } from './pipeline/selectors';
import { DASH, fmtBool, fmtOffset, fmtPct } from './format';
import { RunErrors } from './RunErrors';
import { Chip, Elapsed, Notice, Panel, Segmented, SelectField, cx } from './ui';
import styles from './Recorder.module.css';

interface Props {
  run: RunState | null;
  settings: AppSettings;
  onChange: (update: (s: AppSettings) => AppSettings) => void;
  recordBlocker: string | null;
  level: LevelStore;
  testCase: TestCaseStatus | null;
  hasPendingChanges: boolean;
  onRecord: () => void;
  onStop: () => void;
  onCancel: () => void;
  onStopPlayback: () => void;
  className?: string;
}

export function RecorderPanel(props: Props) {
  const { run, settings, onChange, recordBlocker, level, testCase, hasPendingChanges, className } = props;
  const active = isRunActive(run);
  const phase = run?.phase;
  // During a run its own phrase stays on screen; between runs the current selection is shown.
  const phrase = active ? (run?.phrase ?? null) : settings.mode === 'benchmark' ? findPhrase(settings.phraseId) : null;

  return (
    <Panel
      title="Run"
      className={className}
      actions={
        <Segmented
          label="Mode"
          value={settings.mode}
          disabled={active}
          options={[
            { value: 'free', label: 'Free speech' },
            { value: 'benchmark', label: 'Benchmark phrase' },
          ]}
          onChange={(mode) => onChange((s) => ({ ...s, mode }))}
        />
      }
    >
      {settings.mode === 'benchmark' && !active && (
        <SelectField
          label="Phrase"
          value={settings.phraseId}
          options={BENCHMARK_PHRASES.map((p) => ({ value: p.id, label: p.title }))}
          onChange={(phraseId) => onChange((s) => ({ ...s, phraseId }))}
        />
      )}
      {phrase && (
        <figure className={styles.phrase}>
          <figcaption className={styles.phraseCaption}>Read aloud</figcaption>
          <blockquote className={styles.phraseText}>{phrase.text}</blockquote>
        </figure>
      )}

      <div className={styles.controls}>
        <PrimaryButton phase={phase} blocked={recordBlocker !== null} onRecord={props.onRecord} onStop={props.onStop} />
        {(phase === 'starting' || phase === 'recording') && (
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
        )}
        {phase === 'speaking' && (
          <button type="button" onClick={props.onStopPlayback}>
            Stop playback
          </button>
        )}
        <div className={styles.status} aria-live="polite">
          <RunStatus run={run} blocker={recordBlocker} />
        </div>
      </div>

      <div className={styles.live}>
        <LevelMeter store={level} active={phase === 'recording'} />
        <SpeechIndicator run={run} />
      </div>

      {!active && testCase && <TestCaseLine status={testCase} />}
      {!active && hasPendingChanges && (
        <Notice tone="info" title="Unapplied setting changes">
          They take effect after Load models; Record uses the configuration that is loaded now.
        </Notice>
      )}

      {run && <Transcripts run={run} />}
      {run?.accuracy && <AccuracyView accuracy={run.accuracy} />}
      {run && <RunErrors errors={run.errors.filter((e) => e.stage === 'microphone' || e.stage === 'asr')} />}
      {run && <PrivacyView run={run} />}
    </Panel>
  );
}

function PrimaryButton({
  phase,
  blocked,
  onRecord,
  onStop,
}: {
  phase: RunState['phase'] | undefined;
  blocked: boolean;
  onRecord: () => void;
  onStop: () => void;
}) {
  if (phase === 'recording') {
    return (
      <button type="button" className={cx(styles.recordButton, styles.stopButton)} onClick={onStop}>
        <span aria-hidden="true">■</span> Stop
      </button>
    );
  }
  const busy = phase === 'starting' ? 'Starting…' : phase === 'finalizing' ? 'Transcribing…' : phase === 'speaking' ? 'Speaking…' : null;
  return (
    <button type="button" className={styles.recordButton} onClick={onRecord} disabled={busy !== null || blocked}>
      <span aria-hidden="true">●</span> {busy ?? 'Record'}
    </button>
  );
}

function RunStatus({ run, blocker }: { run: RunState | null; blocker: string | null }) {
  switch (run?.phase) {
    case 'starting':
      return <>Opening the microphone…</>;
    case 'recording':
      return (
        <>
          Recording <Elapsed since={run.clickedAt} /> · press Stop when you finish speaking
        </>
      );
    case 'finalizing':
      return <>Finalizing the transcript…</>;
    case 'speaking':
      return <>Speaking the transcript{run.chunks.length > 0 ? ` · ${run.chunks.length} chunk${run.chunks.length === 1 ? '' : 's'} so far` : ''}…</>;
  }
  const last =
    run?.phase === 'done'
      ? run.errors.length > 0
        ? `Last run completed with ${run.errors.length} issue${run.errors.length === 1 ? '' : 's'}.`
        : 'Last run completed.'
      : run?.phase === 'failed'
        ? 'Last run did not complete; see the errors below.'
        : run?.phase === 'cancelled'
          ? 'Last run cancelled.'
          : null;
  return <>{[last, blocker ?? 'Ready: press Record and speak.'].filter(Boolean).join(' ')}</>;
}

/** Subscribes to the level store directly so ~20 updates/s re-render only this meter. */
function LevelMeter({ store, active }: { store: LevelStore; active: boolean }) {
  const rms = useSyncExternalStore(store.subscribe, store.get, store.get);
  const db = active && rms > 0 ? 20 * Math.log10(rms) : null;
  const fraction = db == null ? 0 : Math.min(1, Math.max(0, (db + 60) / 60));
  return (
    <div className={styles.level}>
      <span className={styles.levelLabel}>Mic level</span>
      <div
        className={styles.levelTrack}
        role="meter"
        aria-label="Microphone level"
        aria-valuemin={-60}
        aria-valuemax={0}
        aria-valuenow={db == null ? -60 : Math.round(db)}
      >
        <div className={cx(styles.levelFill, db != null && db > -3 && styles.levelHot)} style={{ width: `${fraction * 100}%` }} />
      </div>
      <span className={cx('num', styles.levelValue)}>{db == null ? DASH : `${Math.round(db)} dB`}</span>
    </div>
  );
}

function SpeechIndicator({ run }: { run: RunState | null }) {
  if (!run) return <Chip>Speech detection idle</Chip>;
  const speechStart = run.asr ? run.asr.speechStart : run.speechStartAt;
  const reference = run.asr?.micStart ?? run.clickedAt;
  if (speechStart != null) return <Chip tone="ok">Speech detected {fmtOffset(speechStart - reference)} after Record</Chip>;
  if (run.phase === 'starting' || run.phase === 'recording') return <Chip tone="info">Listening for speech…</Chip>;
  if (run.asr) return <Chip tone="warn">No speech detected</Chip>;
  return <Chip>Speech detection idle</Chip>;
}

function TestCaseLine({ status }: { status: TestCaseStatus }) {
  const failing = status.checks.filter((c) => !c.ok);
  return (
    <div className={styles.testCase}>
      <div className={styles.testCaseHead}>
        <span className={styles.testCaseTitle}>
          Test {status.testCase.id} · {describeTestCase(status.testCase)}
        </span>
        {status.checks.map((c) => (
          <Chip key={c.label} tone={c.ok ? 'ok' : 'warn'} title={c.detail}>
            {c.label}
          </Chip>
        ))}
      </div>
      {failing.length > 0 && (
        <ul className={styles.testCaseIssues}>
          {failing.map((c) => (
            <li key={c.label}>
              {c.label}: {c.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Transcripts({ run }: { run: RunState }) {
  const partial = run.partials.at(-1)?.text ?? '';
  const listening = run.phase === 'starting' || run.phase === 'recording';
  const final = run.asr?.finalText ?? null;
  const streaming = run.asr?.streamingText ?? null;
  return (
    <div className={styles.transcripts}>
      <div className={styles.transcriptBox}>
        <div className={styles.transcriptLabel}>
          Partial transcript{' '}
          <span className="muted">
            {run.partials.length} update{run.partials.length === 1 ? '' : 's'}
          </span>
        </div>
        <p className={cx(styles.transcript, listening && styles.transcriptLive)}>
          {partial || <span className="muted">{listening ? 'Waiting for the first words…' : DASH}</span>}
        </p>
      </div>
      <div className={styles.transcriptBox}>
        <div className={styles.transcriptLabel}>
          Final transcript <span className="muted">raw and untouched, exactly what TTS received</span>
        </div>
        <p className={styles.transcript}>
          {final == null ? (
            <span className="muted">{run.phase === 'finalizing' ? 'Finalizing…' : DASH}</span>
          ) : final === '' ? (
            <span className="muted">(empty)</span>
          ) : (
            final
          )}
        </p>
      </div>
      {final != null && streaming != null && streaming.trim() !== final.trim() && (
        <div className={styles.transcriptBox}>
          <div className={styles.transcriptLabel}>
            Streaming text <span className="muted">before the final pass</span>
          </div>
          <p className={styles.transcript}>{streaming || <span className="muted">(empty)</span>}</p>
        </div>
      )}
    </div>
  );
}

function AccuracyView({ accuracy: a }: { accuracy: AccuracyResult }) {
  const ops = useMemo(() => alignWords(toWords(a.normalizedExpected), toWords(a.normalizedHypothesis)), [a]);
  return (
    <section className={styles.accuracy} aria-label="Accuracy">
      <div className={styles.accuracyHead}>
        <span className={styles.accuracyTitle}>Accuracy</span>
        <span className={styles.wer}>
          WER <strong>{fmtPct(a.wer)}</strong>
        </span>
        {a.exactMatch ? <Chip tone="ok">Exact match</Chip> : <Chip tone="warn">Not an exact match</Chip>}
        <span className="num">
          S {a.substitutions} · D {a.deletions} · I {a.insertions} · N {a.referenceWordCount}
        </span>
      </div>
      <Alignment ops={ops} />
      <dl className={styles.normalized}>
        <dt>Expected, normalized</dt>
        <dd>{a.normalizedExpected || DASH}</dd>
        <dt>Heard, normalized</dt>
        <dd>{a.normalizedHypothesis || DASH}</dd>
      </dl>
      {a.streaming && (
        <p className="muted">
          Streaming text before the final pass: WER {fmtPct(a.streaming.wer)} (S {a.streaming.substitutions} · D{' '}
          {a.streaming.deletions} · I {a.streaming.insertions}), exact match {fmtBool(a.streaming.exactMatch, 'yes', 'no')}.
        </p>
      )}
    </section>
  );
}

function Alignment({ ops }: { ops: AlignmentOp[] }) {
  if (ops.length === 0) return null;
  return (
    <div>
      <p className={styles.alignment}>
        {ops.map((o, i) => {
          switch (o.op) {
            case 'match':
              return <span key={i}>{o.ref} </span>;
            case 'sub':
              return (
                <span key={i} className={styles.alignSub} title={`substitution: expected “${o.ref}”, heard “${o.hyp}”`}>
                  <del>{o.ref}</del>→<ins>{o.hyp}</ins>{' '}
                </span>
              );
            case 'del':
              return (
                <span key={i} className={styles.alignDel} title={`deletion: “${o.ref}” was not heard`}>
                  <del>{o.ref}</del>{' '}
                </span>
              );
            case 'ins':
              return (
                <span key={i} className={styles.alignIns} title={`insertion: “${o.hyp}” was not expected`}>
                  <ins>+{o.hyp}</ins>{' '}
                </span>
              );
          }
        })}
      </p>
      <p className={styles.alignmentLegend}>
        <del>word</del> deleted · <ins>+word</ins> inserted · <del>a</del>→<ins>b</ins> substituted
      </p>
    </div>
  );
}

function PrivacyView({ run }: { run: RunState }) {
  const issues = run.errors.filter((e) => e.stage === 'privacy');
  const record = run.record;
  if (!record) return <RunErrors errors={issues} />;
  const n = record.privacy.networkRequestsDuringRun;
  const c = run.network;
  const count = (v: number | null | undefined) => (v == null ? '?' : String(v));
  const breakdown = `page ${count(c?.page)} · ASR worker ${count(c?.asrWorker)} · TTS worker ${count(c?.ttsWorker)}`;
  const incomplete = !c || c.page == null || c.asrWorker == null || c.ttsWorker == null;
  const online = `online at start: ${fmtBool(record.privacy.onlineAtStart, 'yes', 'no')}, at end: ${fmtBool(record.privacy.onlineAtEnd, 'yes', 'no')}`;
  return (
    <>
      {n > 0 ? (
        <Notice tone="err" title={`Privacy boundary: ${n} network request${n === 1 ? '' : 's'} during the run`}>
          Once models are loaded the speech pipeline should make none (spec §5). {breakdown}; {online}. Check the browser&apos;s
          network log for what was fetched.
        </Notice>
      ) : (
        <div className={styles.privacy}>
          <Chip tone={incomplete ? 'warn' : 'ok'}>
            {incomplete ? '0 requests counted, but not every source could be checked' : 'No network requests during the run'}
          </Chip>
          <span className="muted">
            {breakdown} · {online}
          </span>
        </div>
      )}
      <RunErrors errors={issues} />
    </>
  );
}

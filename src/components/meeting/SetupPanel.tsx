'use client';

import type { LoadProgress, ModelLoadRecord } from '@/lib/types';
import { MODEL_NAMES, loadBlocker, type FileProgress, type PipelineSnapshot } from '../pipeline/state';
import { BACKEND_LABEL, LOAD_KIND_LABEL, fmtBytes, fmtMs } from '../format';
import { Chip, Elapsed, Meter, Notice, Panel } from '../ui';
import type { MeetingController } from './controller';
import { parakeetEstimate, speakerEstimate } from './format';
import { SourceIcon } from './icons';
import { isSessionActive, startBlocker, type MeetingSnapshot } from './state';
import styles from './Meeting.module.css';
import panels from '../panels.module.css';

interface Props {
  pipeline: PipelineSnapshot;
  meeting: MeetingSnapshot;
  controller: MeetingController;
}

/** Sources, capture hints, models and Start. */
export function SetupPanel({ pipeline: p, meeting: m, controller: c }: Props) {
  const canCapture = c.canCaptureSystemAudio;
  const starting = m.phase === 'starting';
  const blocker = starting ? null : startBlocker(p, m, canCapture);
  const speakerReady = m.speakerModel.phase === 'ready';
  return (
    <Panel title="New meeting" subtitle="Transcribe the people in the room, a call, or both">
      <fieldset className={styles.sources} disabled={starting}>
        <legend>Audio sources</legend>
        <SourceCard
          kind="mic"
          title="Microphone"
          text="People in the room, and you."
          checked={m.sources.mic}
          onChange={(on) => c.setSource('mic', on)}
        />
        <SourceCard
          kind="system"
          title="Call audio"
          text={
            canCapture
              ? 'Teams, Zoom or Meet. Edge asks what to share when the meeting starts.'
              : 'Not available in this browser: it cannot share a tab or screen.'
          }
          checked={m.sources.system && canCapture}
          disabled={!canCapture}
          onChange={(on) => c.setSource('system', on)}
        />
      </fieldset>
      <CaptureHints open={m.sources.system && canCapture} />
      <Models pipeline={p} meeting={m} controller={c} />
      <div className={styles.row}>
        <button type="button" className={styles.startButton} onClick={c.start} disabled={starting || blocker !== null}>
          <span aria-hidden="true">●</span> {starting ? 'Starting…' : 'Start meeting'}
        </button>
        {starting && (
          <button type="button" onClick={c.stop} disabled={m.live?.cancelling}>
            {m.live?.cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
        <span className={styles.status} aria-live="polite">
          {starting
            ? m.sources.system && canCapture
              ? 'In Edge’s dialog, choose the call’s tab (or Entire screen) and keep its audio switched on.'
              : 'Allow the microphone if Edge asks.'
            : (blocker ?? (speakerReady ? 'Ready.' : 'Ready, but without the speaker model lines will not get speaker labels.'))}
        </span>
      </div>
      {m.startProblem && (
        <Notice tone="err" title={m.startProblem.title}>
          {m.startProblem.message}
        </Notice>
      )}
    </Panel>
  );
}

function SourceCard({
  kind,
  title,
  text,
  checked,
  disabled,
  onChange,
}: {
  kind: 'mic' | 'system';
  title: string;
  text: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className={styles.sourceCard}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <SourceIcon source={kind} className={styles.sourceCardIcon} labelled={false} />
      <span className={styles.sourceTitle}>{title}</span>
      <span className={styles.sourceText}>{text}</span>
    </label>
  );
}

function CaptureHints({ open }: { open: boolean }) {
  return (
    <details className={panels.details} open={open}>
      <summary>How to capture call audio</summary>
      <ul className={styles.hints}>
        <li>
          <strong>Teams, Meet or Zoom in Edge:</strong> when Edge asks what to share, pick the call’s tab and keep “Also share tab
          audio” switched on.
        </li>
        <li>
          <strong>Teams or Zoom desktop app:</strong> pick <em>Entire screen</em> and switch on “Also share system audio”.
        </li>
        <li>
          <strong>Use headphones</strong> if you can. On laptop speakers the microphone hears the call too; those duplicate lines
          are detected and hidden.
        </li>
        <li>Only the sound is used, not the picture. Edge shows its sharing bar until the meeting stops.</li>
      </ul>
    </details>
  );
}

interface ModelView {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  progress: LoadProgress | null;
  fileProgress: Record<string, FileProgress>;
  loadStartedAt: number | null;
  record: ModelLoadRecord | null;
  error: string | null;
}

function Models({ pipeline: p, meeting: m, controller: c }: Props) {
  const parakeet = p.models.parakeet;
  const speaker = m.speakerModel;
  const bothReady = parakeet.phase === 'ready' && speaker.phase === 'ready';
  const loading = m.loading || p.loading;
  const blocker = !p.environment ? 'Detecting the environment…' : parakeet.phase !== 'ready' ? loadBlocker(p) : null;
  const status = loading ? 'Loading…' : bothReady ? 'Both models ready.' : (blocker ?? 'Load both before the meeting.');
  return (
    <section className={styles.models} aria-label="Models">
      <div className={styles.row}>
        <span className={styles.sectionTitle}>Models</span>
        <span className={styles.status} aria-live="polite">
          {status}
        </span>
        {!bothReady && (
          <button
            type="button"
            className={panels.primaryButton}
            onClick={() => void c.loadModels()}
            disabled={loading || blocker !== null || isSessionActive(m.phase)}
          >
            {loading ? 'Loading…' : 'Load models'}
          </button>
        )}
      </div>
      <ModelStatus
        name={MODEL_NAMES.parakeet}
        role="Turns speech into text"
        model={parakeet}
        estimate={parakeetEstimate(p.settings, p.environment)}
      />
      <ModelStatus
        name="Speaker model"
        role="Tells voices apart"
        model={speaker}
        estimate={speakerEstimate()}
      />
      {m.loadError && (
        <Notice tone="warn" title="Models not loaded">
          {m.loadError}
        </Notice>
      )}
      <p className={panels.hint}>
        Downloaded once, then loaded from browser storage. Backend, model source and segmentation (pause length, live update
        interval) are set on the Benchmark tab.
      </p>
    </section>
  );
}

const PHASE_LABEL: Record<LoadProgress['phase'], string> = {
  download: 'Downloading',
  initialize: 'Initializing',
  warmup: 'Warming up',
  ready: 'Ready',
  error: 'Error',
};

function ModelStatus({ name, role, model, estimate }: { name: string; role: string; model: ModelView; estimate: string }) {
  const record = model.record;
  return (
    <div className={styles.modelRow}>
      <div className={styles.modelHead}>
        <span className={styles.modelName}>{name}</span>
        <span className={styles.modelDetail}>{role}</span>
        {model.phase === 'ready' ? (
          <Chip tone="ok">Ready</Chip>
        ) : model.phase === 'loading' ? (
          <Chip tone="info">{PHASE_LABEL[model.progress?.phase ?? 'download']}</Chip>
        ) : model.phase === 'error' ? (
          <Chip tone="err">Error</Chip>
        ) : (
          <Chip>Not loaded</Chip>
        )}
      </div>
      {model.phase === 'loading' && <LoadProgressLine name={name} model={model} />}
      {model.phase === 'ready' && record && (
        <div className={styles.modelLine}>
          {BACKEND_LABEL[record.resolvedBackend]} ·{' '}
          {Object.values(record.quantization).join(' / ') || 'default precision'} · {LOAD_KIND_LABEL[record.loadKind].toLowerCase()} load
          {record.loadKind !== 'session' ? ` in ${fmtMs(record.totalColdStartMs)}` : ''}
          {record.download.downloadedBytes > 0 ? ` · ${fmtBytes(record.download.downloadedBytes)} downloaded` : ''}
        </div>
      )}
      {(model.phase === 'idle' || model.phase === 'error') && <div className={styles.modelLine}>Download {estimate}, then from browser storage.</div>}
      {model.error && (
        <Notice tone={model.phase === 'ready' ? 'warn' : 'err'} title={model.phase === 'ready' ? 'Reload failed' : 'Load failed'}>
          {model.error}
        </Notice>
      )}
    </div>
  );
}

function LoadProgressLine({ name, model }: { name: string; model: ModelView }) {
  const phase = model.progress?.phase ?? 'download';
  const files = Object.values(model.fileProgress);
  const loaded = files.length > 0 ? files.reduce((n, f) => n + f.loadedBytes, 0) : (model.progress?.loadedBytes ?? null);
  const total =
    files.length > 0
      ? files.every((f) => f.totalBytes != null)
        ? files.reduce((n, f) => n + (f.totalBytes ?? 0), 0)
        : null
      : (model.progress?.totalBytes ?? null);
  const fraction = phase === 'download' && loaded != null && total ? loaded / total : null;
  return (
    <div className={styles.models}>
      <Meter fraction={fraction} label={`${name} ${PHASE_LABEL[phase].toLowerCase()}`} />
      <div className={styles.modelLine}>
        {PHASE_LABEL[phase]}
        {loaded != null ? ` · ${fmtBytes(loaded)}${total ? ` of ${fmtBytes(total)} (${Math.floor((loaded / total) * 100)}%)` : ''}` : ''}
        {model.loadStartedAt != null && (
          <>
            {' '}
            · <Elapsed since={model.loadStartedAt} />
          </>
        )}
      </div>
    </div>
  );
}

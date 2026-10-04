'use client';

import { memo } from 'react';
import { span } from '@/lib/clock';
import { KOKORO_MODEL, PARAKEET_MODEL } from '@/lib/config';
import type { DownloadMetrics, LoadProgress, ModelKey, ModelLoadRecord } from '@/lib/types';
import type { ModelState, ModelsState } from './pipeline/state';
import {
  BACKEND_LABEL,
  DASH,
  LOAD_KIND_DESCRIPTION,
  LOAD_KIND_LABEL,
  fmtBytes,
  fmtMs,
  fmtRate,
  shortSha,
  threadsLabel,
} from './format';
import { Chip, Elapsed, Kv, KvList, Meter, Notice, Panel, cx } from './ui';
import styles from './panels.module.css';
import ui from './ui.module.css';

interface Props {
  models: ModelsState;
  pending: Record<ModelKey, string[]>;
  loading: boolean;
  loadBlocker: string | null;
  onLoad: () => void;
  className?: string;
}

const PHASE_LABEL: Record<LoadProgress['phase'], string> = {
  download: 'Downloading',
  initialize: 'Initializing',
  warmup: 'Warming up',
  ready: 'Ready',
  error: 'Error',
};

type AnyModelState = ModelsState[ModelKey];

export const ModelsPanel = memo(function ModelsPanel({ models, pending, loading, loadBlocker, onLoad, className }: Props) {
  const anyPending = pending.parakeet.length + pending.kokoro.length > 0;
  const bothReady = models.parakeet.phase === 'ready' && models.kokoro.phase === 'ready';
  const status = loading
    ? `Loading ${models.parakeet.phase === 'loading' ? 'Parakeet' : 'Kokoro'}…`
    : (loadBlocker ?? (anyPending ? 'Settings changed: Load models to apply them.' : bothReady ? 'Both models ready.' : 'Not loaded.'));
  return (
    <Panel
      title="Models"
      subtitle="Loaded one after the other, so each model's download and initialization are measured on their own"
      className={className}
      actions={
        <>
          <span className={styles.panelStatus} aria-live="polite">
            {status}
          </span>
          <button type="button" className={styles.primaryButton} onClick={onLoad} disabled={loadBlocker !== null}>
            {loading ? 'Loading…' : 'Load models'}
          </button>
        </>
      }
    >
      <div className={styles.modelGrid}>
        <ModelCard name="Parakeet" displayName={PARAKEET_MODEL.displayName} model={models.parakeet} pending={pending.parakeet} />
        <ModelCard name="Kokoro" displayName={KOKORO_MODEL.displayName} model={models.kokoro} pending={pending.kokoro} />
      </div>
    </Panel>
  );
});

function ModelCard({ name, displayName, model, pending }: { name: string; displayName: string; model: AnyModelState; pending: string[] }) {
  const { phase, record } = model;
  return (
    <article className={styles.modelCard} aria-label={name}>
      <header className={styles.modelHeader}>
        <h3 className={styles.modelName}>{name}</h3>
        <span className={styles.modelDisplayName}>{displayName}</span>
        <PhaseChip model={model} pending={pending.length > 0} />
      </header>
      {phase === 'loading' && <LoadProgressView name={name} model={model} />}
      {model.error && (
        <Notice tone="err" title={phase === 'ready' ? 'Reload failed' : 'Load failed'}>
          {model.error}
        </Notice>
      )}
      {phase !== 'loading' && record && (
        <LoadRecordView record={record} instance={model.instanceRecord} runsSinceLoad={model.runsSinceLoad} />
      )}
      {phase === 'idle' && !record && <p className="muted">Not loaded.</p>}
      {phase !== 'loading' && pending.length > 0 && (
        <Notice tone="warn" title="Changed since load, not applied yet">
          <ul className={styles.compactList}>
            {pending.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Notice>
      )}
    </article>
  );
}

function PhaseChip({ model, pending }: { model: AnyModelState; pending: boolean }) {
  switch (model.phase) {
    case 'loading':
      return <Chip tone="info">{PHASE_LABEL[model.progress?.phase ?? 'download']}</Chip>;
    case 'ready':
      return pending ? <Chip tone="warn">Ready · reload to apply</Chip> : <Chip tone="ok">Ready</Chip>;
    case 'error':
      return <Chip tone="err">Error</Chip>;
    default:
      return <Chip>Not loaded</Chip>;
  }
}

function downloadTotals(model: AnyModelState): { loaded: number | null; total: number | null } {
  const files = Object.values(model.fileProgress);
  if (files.length > 0) {
    const loaded = files.reduce((n, f) => n + f.loadedBytes, 0);
    const total = files.every((f) => f.totalBytes != null) ? files.reduce((n, f) => n + (f.totalBytes ?? 0), 0) : null;
    return { loaded, total };
  }
  return { loaded: model.progress?.loadedBytes ?? null, total: model.progress?.totalBytes ?? null };
}

function LoadProgressView({ name, model }: { name: string; model: AnyModelState }) {
  const progress = model.progress;
  const phase = progress?.phase ?? 'download';
  const { loaded, total } = downloadTotals(model);
  const fraction = phase === 'download' && loaded != null && total ? loaded / total : null;
  return (
    <div className={styles.progress}>
      <div className={styles.progressHead}>
        <strong>{PHASE_LABEL[phase]}</strong>
        {model.loadStartedAt != null && (
          <span className="muted">
            elapsed <Elapsed since={model.loadStartedAt} />
          </span>
        )}
      </div>
      <Meter fraction={fraction} label={`${name} ${PHASE_LABEL[phase].toLowerCase()}`} />
      {loaded != null && (
        <div className="num">
          {fmtBytes(loaded)}
          {total ? ` of ${fmtBytes(total)} · ${Math.floor((loaded / total) * 100)}%` : ''}
        </div>
      )}
      {progress?.file && (
        <div className={styles.progressFile} title={progress.file}>
          {progress.file}
        </div>
      )}
      {progress?.message && <div className="muted">{progress.message}</div>}
    </div>
  );
}

function quantizationLabel(q: Record<string, string>): string {
  return (
    Object.entries(q)
      .map(([part, value]) => `${part} ${value}`)
      .join(' · ') || DASH
  );
}

function LoadRecordView({
  record,
  instance,
  runsSinceLoad,
}: {
  record: ModelLoadRecord;
  instance: ModelLoadRecord | null;
  runsSinceLoad: number;
}) {
  const d = record.download;
  const { wasm } = record;
  return (
    <>
      <div className={styles.loadKind}>
        <span className={cx(styles.loadKindBadge, styles[`loadKind-${record.loadKind}`])}>{LOAD_KIND_LABEL[record.loadKind]} load</span>
        <span className="muted">{LOAD_KIND_DESCRIPTION[record.loadKind]}</span>
      </div>
      {record.loadKind === 'session' && instance && instance !== record && (
        <p className={styles.hint}>
          This instance was originally a {LOAD_KIND_LABEL[instance.loadKind].toLowerCase()} load: total cold start{' '}
          {fmtMs(instance.totalColdStartMs)}, {fmtBytes(instance.download.downloadedBytes)} downloaded.
        </p>
      )}
      {wasm.multithreadingUnavailable && (
        <Notice tone="warn" title="Multithreaded WASM unavailable">
          Requested {threadsLabel(wasm.requestedThreads)} threads, ONNX Runtime is running {wasm.effectiveThreads}.
          {wasm.reason ? ` ${wasm.reason}` : ''}
        </Notice>
      )}
      {record.fallbackReason && (
        <Notice tone="warn" title={`Fell back to ${BACKEND_LABEL[record.resolvedBackend]}`}>
          {record.fallbackReason}
        </Notice>
      )}
      <KvList numeric>
        <Kv label="Backend">
          {BACKEND_LABEL[record.requestedBackend]} → {BACKEND_LABEL[record.resolvedBackend]}
        </Kv>
        <Kv label="Quantization">{quantizationLabel(record.quantization)}</Kv>
        <Kv label="Download">{fmtMs(d.totalDownloadMs)}</Kv>
        <Kv
          label="Downloaded"
          hint={`${d.networkFiles.length} of ${d.expectedFiles.length} files from the network, ${d.cachedFiles.length} from storage`}
        >
          {fmtBytes(d.downloadedBytes)}
        </Kv>
        <Kv label="Rate">{fmtRate(d.effectiveMBps)}</Kv>
        <Kv label="Time to first byte">{fmtMs(d.timeToFirstByteMs)}</Kv>
        <Kv label="Initialization">{fmtMs(record.initializationMs)}</Kv>
        <Kv label="Warm-up">{fmtMs(record.warmupMs)}</Kv>
        <Kv label="Total cold start" strong>
          {fmtMs(record.totalColdStartMs)}
        </Kv>
        <Kv label="Runtime assets" hint={`${d.runtimeFiles.length} ORT file${d.runtimeFiles.length === 1 ? '' : 's'} fetched`}>
          {fmtBytes(d.runtimeBytes)}
        </Kv>
        <Kv label="WASM threads" hint={`requested → effective · SIMD ${wasm.simd ? 'on' : 'off'}`}>
          {threadsLabel(wasm.requestedThreads)} → {wasm.effectiveThreads}
        </Kv>
        <Kv label="Runs since load">{runsSinceLoad}</Kv>
      </KvList>
      <details className={styles.details}>
        <summary>Files, source and versions</summary>
        <FilesTable download={d} />
        <KvList>
          <Kv label="Source">
            {record.source.kind === 'huggingface' ? 'Hugging Face' : 'Mirror'} · {record.source.baseUrl}
          </Kv>
          <Kv label="Repository">
            {record.repo}@{shortSha(record.revision)}
          </Kv>
          <Kv label="Versions">
            {Object.entries(record.versions)
              .map(([lib, version]) => `${lib} ${version}`)
              .join(' · ')}
          </Kv>
          <Kv label="ORT assets">{wasm.wasmPaths}</Kv>
        </KvList>
      </details>
    </>
  );
}

function FilesTable({ download: d }: { download: DownloadMetrics }) {
  const rows = [
    ...d.networkFiles.map((rec) => ({ file: rec.file, from: 'network', rec })),
    ...d.cachedFiles.map((file) => ({ file, from: 'storage', rec: null })),
    ...d.runtimeFiles.map((rec) => ({ file: rec.file, from: 'runtime', rec })),
  ];
  if (rows.length === 0) return <p className="muted">No file records for this load.</p>;
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            <th>File</th>
            <th>From</th>
            <th className={ui.numCell}>Size</th>
            <th className={ui.numCell}>TTFB</th>
            <th className={ui.numCell}>Time</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ file, from, rec }, i) => (
            <tr key={`${from}:${file}:${i}`}>
              <td className={styles.fileName}>{file}</td>
              <td>{from}</td>
              <td className={ui.numCell}>{rec ? fmtBytes(rec.bytes) : DASH}</td>
              <td className={ui.numCell}>{rec ? fmtMs(span(rec.requestStart, rec.firstByteAt)) : DASH}</td>
              <td className={ui.numCell}>{rec ? fmtMs(span(rec.requestStart, rec.completeAt)) : DASH}</td>
              <td>{rec?.error ? <span className={styles.fileError}>{rec.error}</span> : (rec?.status ?? DASH)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

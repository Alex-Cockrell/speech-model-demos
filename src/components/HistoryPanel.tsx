'use client';

import { memo } from 'react';
import { HISTORY_LIMIT } from '@/lib/benchmark/persist';
import { exportFileName } from '@/lib/benchmark/record';
import type { BenchmarkRecord, ModelSummary } from '@/lib/types';
import { downloadJson } from './clipboard';
import { BACKEND_LABEL, DASH, LOAD_KIND_LABEL, fmtClock, fmtMs, fmtPct } from './format';
import { Chip, ConfirmButton, CopyButton, Notice, Panel } from './ui';
import styles from './panels.module.css';
import ui from './ui.module.css';

interface Props {
  history: BenchmarkRecord[];
  error: string | null;
  onClear: () => void;
  className?: string;
}

/** "WebGPU · WASM" for Parakeet · Kokoro. */
function perModel(r: BenchmarkRecord, pick: (m: ModelSummary) => string): string {
  const { parakeet, kokoro } = r.models;
  return `${parakeet ? pick(parakeet) : DASH} · ${kokoro ? pick(kokoro) : DASH}`;
}

export const HistoryPanel = memo(function HistoryPanel({ history, error, onClear, className }: Props) {
  const empty = history.length === 0;
  return (
    <Panel
      title="Run history"
      subtitle={`${history.length} of max ${HISTORY_LIMIT} runs, stored only in this browser`}
      className={className}
      actions={
        <>
          <CopyButton label="Copy all runs JSON" disabled={empty} getText={() => JSON.stringify(history, null, 2)} />
          <button type="button" disabled={empty} onClick={() => downloadJson(exportFileName(), history)}>
            Download JSON
          </button>
          <ConfirmButton label="Clear history" confirmLabel="Confirm: clear history" disabled={empty} onConfirm={onClear} />
        </>
      }
    >
      {error && (
        <Notice tone="warn" title="Run history storage">
          {error}
        </Notice>
      )}
      {empty ? (
        <p className="muted">Every run is saved here automatically. Nothing is sent anywhere unless you copy or download it.</p>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Time</th>
                <th>Label</th>
                <th>Test</th>
                <th title="Parakeet · Kokoro">Backend P · K</th>
                <th title="Parakeet · Kokoro">Load P · K</th>
                <th className={ui.numCell}>Stop → final text</th>
                <th className={ui.numCell}>Stop → first speech</th>
                <th className={ui.numCell}>WER</th>
                <th>Issues</th>
                <th>
                  <span className={styles.visuallyHidden}>Copy</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.id}>
                  <td className={ui.numCell}>{fmtClock(r.createdAt)}</td>
                  <td>{r.label || DASH}</td>
                  <td>{r.testCase ?? DASH}</td>
                  <td>{perModel(r, (m) => BACKEND_LABEL[m.backend])}</td>
                  <td>{perModel(r, (m) => `${LOAD_KIND_LABEL[m.loadKind]}${m.runsSinceLoad > 0 ? ` +${m.runsSinceLoad}` : ''}`)}</td>
                  <td className={ui.numCell}>{fmtMs(r.endToEnd.stopToFinalTextMs)}</td>
                  <td className={ui.numCell}>{fmtMs(r.endToEnd.stopToFirstSpeechMs)}</td>
                  <td className={ui.numCell}>{r.accuracy ? fmtPct(r.accuracy.wer) : DASH}</td>
                  <td>
                    <Issues record={r} />
                  </td>
                  <td>
                    <CopyButton label="Copy" getText={() => JSON.stringify(r, null, 2)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!empty && <p className={styles.hint}>Load “Cold +2” = third run on a model instance that was loaded cold.</p>}
    </Panel>
  );
});

function Issues({ record: r }: { record: BenchmarkRecord }) {
  const requests = r.privacy.networkRequestsDuringRun;
  if (requests === 0 && r.errors.length === 0) return <span className="muted">none</span>;
  return (
    <span className={styles.issues}>
      {requests > 0 && (
        <Chip tone="err" title="Network requests between Record and playback complete">
          {requests} request{requests === 1 ? '' : 's'}
        </Chip>
      )}
      {r.errors.length > 0 && (
        <Chip tone="warn" title={r.errors.join('\n')}>
          {r.errors.length} error{r.errors.length === 1 ? '' : 's'}
        </Chip>
      )}
    </span>
  );
}

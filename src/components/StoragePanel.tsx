'use client';

import { memo } from 'react';
import { MODEL_CACHE_NAMES, MODEL_IDB_NAMES, modelStoreLabel } from '@/lib/net/cache';
import type { StorageInfo } from '@/lib/types';
import type { CacheClearResult, PersistRequestResult } from './pipeline/state';
import { DASH, fmtBytes, fmtClock } from './format';
import { Chip, ConfirmButton, Kv, KvList, Meter, Notice, Panel } from './ui';
import styles from './panels.module.css';

interface Props {
  storage: StorageInfo | null;
  storageError: string | null;
  online: boolean;
  clearing: boolean;
  clearBlocker: string | null;
  cacheClear: CacheClearResult | null;
  persistRequest: PersistRequestResult | null;
  onClearCaches: () => void;
  onRequestPersistence: () => void;
  onRefresh: () => void;
  className?: string;
}

export const StoragePanel = memo(function StoragePanel(p: Props) {
  const usage = p.storage?.usageBytes ?? null;
  const quota = p.storage?.quotaBytes ?? null;
  const persisted = p.storage?.persisted;
  return (
    <Panel
      title="Storage & network"
      className={p.className}
      actions={
        <button type="button" onClick={p.onRefresh}>
          Refresh
        </button>
      }
    >
      <KvList>
        <Kv label="Network">{p.online ? <Chip tone="ok">Online</Chip> : <Chip tone="info">Offline</Chip>}</Kv>
        <Kv label="Storage used">
          {fmtBytes(usage)} of {fmtBytes(quota)}
        </Kv>
        <Kv label="Persistent storage">
          {persisted == null ? DASH : persisted ? 'Granted' : 'Not granted (models may be evicted under storage pressure)'}
        </Kv>
      </KvList>
      {usage != null && quota ? <Meter fraction={usage / quota} label="Storage used" /> : null}
      {p.storageError && (
        <Notice tone="warn" title="Storage estimate failed">
          {p.storageError}
        </Notice>
      )}
      <p className={styles.hint}>
        Test 5: load both models, then disconnect the network (or switch the browser to offline) and record. The run should
        complete with no network requests.
      </p>
      <div className={styles.buttonRow}>
        <button type="button" onClick={p.onRequestPersistence}>
          Request persistent storage
        </button>
        <ConfirmButton
          label="Clear model caches"
          confirmLabel="Confirm: unload & delete cached models"
          disabled={p.clearBlocker !== null}
          title={p.clearBlocker ?? 'Unloads both models and deletes their cached files'}
          onConfirm={p.onClearCaches}
        />
      </div>
      {p.persistRequest &&
        (p.persistRequest.error ? (
          <Notice tone="err" title="Persistent storage request failed">
            {p.persistRequest.error}
          </Notice>
        ) : (
          <p className={styles.hint}>
            {p.persistRequest.persisted
              ? 'Persistent storage granted: cached models are protected from automatic eviction.'
              : 'Persistent storage not granted. The browser decides (engagement, bookmarks, installed state); models may be evicted under pressure.'}
          </p>
        ))}
      {p.clearing && <p className="muted">Unloading models and deleting caches…</p>}
      {p.cacheClear && <CacheClearView result={p.cacheClear} />}
      <details className={styles.details}>
        <summary>Where model files are stored</summary>
        <p className={styles.hint}>
          Cache Storage: {MODEL_CACHE_NAMES.map(modelStoreLabel).join(', ')}. IndexedDB:{' '}
          {MODEL_IDB_NAMES.map(modelStoreLabel).join(', ')}. Clearing does not touch the browser&apos;s HTTP cache.
        </p>
      </details>
    </Panel>
  );
});

function CacheClearView({ result }: { result: CacheClearResult }) {
  const deleted = result.cleared.length > 0 ? `Deleted: ${result.cleared.join(', ')}.` : 'No cached model files were found.';
  return result.errors.length > 0 ? (
    <Notice tone="err" title={`Clearing at ${fmtClock(result.at)} was incomplete`}>
      {result.errors.join(' · ')} {deleted} Both models were unloaded.
    </Notice>
  ) : (
    <Notice tone="ok" title={`Caches cleared at ${fmtClock(result.at)}: the next load will be cold`}>
      {deleted} Both models were unloaded.
    </Notice>
  );
}

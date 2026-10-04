'use client';

import { useMemo } from 'react';
import { APP_INFO } from '@/lib/config';
import { EnvironmentPanel } from './EnvironmentPanel';
import { HistoryPanel } from './HistoryPanel';
import { AsrMetricsPanel, EndToEndPanel, TtsMetricsPanel } from './MetricsPanel';
import { ModelsPanel } from './ModelsPanel';
import { clearBlocker, isRunActive, loadBlocker, recordBlocker } from './pipeline/state';
import { pendingChanges, testCaseStatus, wasmCrippled } from './pipeline/selectors';
import { useSpeechPipeline } from './pipeline/useSpeechPipeline';
import { RecorderPanel } from './RecorderPanel';
import { SettingsPanel } from './SettingsPanel';
import { StoragePanel } from './StoragePanel';
import { AsrTimelinePanel, TtsTimelinePanel } from './TimelinePanel';
import { Chip } from './ui';
import styles from './App.module.css';

/** Single-page benchmark dashboard (spec §13). All orchestration lives in the pipeline controller. */
export default function App() {
  const { snapshot: s, controller: c } = useSpeechPipeline();
  const pending = useMemo(() => pendingChanges(s.models, s.settings), [s.models, s.settings]);
  const testCase = useMemo(() => testCaseStatus(s.models, s.settings, s.online), [s.models, s.settings, s.online]);
  const env = s.environment;
  const active = isRunActive(s.run);

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Local Speech Test</h1>
          <p className={styles.tagline}>Microphone → Parakeet ASR → transcript → Kokoro TTS → speaker, with every inference step in this browser.</p>
        </div>
        <div className={styles.badges}>
          {env &&
            (env.crossOriginIsolated ? <Chip tone="ok">Cross-origin isolated</Chip> : <Chip tone="warn">Not cross-origin isolated</Chip>)}
          {env && (env.webgpu.adapterAvailable ? <Chip tone="ok">WebGPU available</Chip> : <Chip>No WebGPU</Chip>)}
          {env &&
            wasmCrippled(env) &&
            (env.wasm.available ? (
              <Chip tone="warn" title="See the Environment panel">WASM likely interpreted (JIT off)</Chip>
            ) : (
              <Chip tone="err" title="See the Environment panel">WebAssembly disabled</Chip>
            ))}
          {s.online ? <Chip tone="ok">Online</Chip> : <Chip tone="info">Offline</Chip>}
          <span className={styles.version}>
            v{APP_INFO.version}
            {APP_INFO.commit ? ` · ${APP_INFO.commit.slice(0, 7)}` : ''}
          </span>
        </div>
      </header>

      <main className={styles.grid}>
        <SettingsPanel
          className={styles.settings}
          settings={s.settings}
          onChange={c.updateSettings}
          environment={env}
          locked={s.loading || s.clearing || active}
          persistError={s.settingsError}
        />
        <ModelsPanel
          className={styles.models}
          models={s.models}
          pending={pending}
          loading={s.loading}
          loadBlocker={loadBlocker(s)}
          onLoad={c.loadModels}
        />
        <RecorderPanel
          className={styles.recorder}
          run={s.run}
          settings={s.settings}
          onChange={c.updateSettings}
          recordBlocker={recordBlocker(s)}
          level={c.level}
          testCase={testCase}
          hasPendingChanges={pending.parakeet.length + pending.kokoro.length > 0}
          onRecord={c.record}
          onStop={c.stop}
          onCancel={c.cancel}
          onStopPlayback={c.stopPlayback}
        />
        <EndToEndPanel className={styles.endToEnd} run={s.run} />
        <AsrMetricsPanel className={styles.asr} run={s.run} />
        <TtsMetricsPanel className={styles.tts} run={s.run} />
        <AsrTimelinePanel className={styles.asrTimeline} run={s.run} />
        <TtsTimelinePanel className={styles.ttsTimeline} run={s.run} />
        <HistoryPanel className={styles.history} history={s.history} error={s.historyError} onClear={c.clearHistory} />
        <EnvironmentPanel
          className={styles.environment}
          environment={env}
          error={s.environmentError}
          storage={s.storage}
          online={s.online}
          parakeet={s.models.parakeet.record}
          kokoro={s.models.kokoro.record}
        />
        <StoragePanel
          className={styles.storage}
          storage={s.storage}
          storageError={s.storageError}
          online={s.online}
          clearing={s.clearing}
          clearBlocker={clearBlocker(s)}
          cacheClear={s.cacheClear}
          persistRequest={s.persistRequest}
          onClearCaches={c.clearCaches}
          onRequestPersistence={c.requestPersistence}
          onRefresh={c.refreshStorage}
        />
      </main>
    </div>
  );
}

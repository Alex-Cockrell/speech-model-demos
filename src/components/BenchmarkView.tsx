'use client';

import { useMemo } from 'react';
import { EnvironmentPanel } from './EnvironmentPanel';
import { HistoryPanel } from './HistoryPanel';
import { AsrMetricsPanel, EndToEndPanel, TtsMetricsPanel } from './MetricsPanel';
import { ModelsPanel } from './ModelsPanel';
import type { PipelineController } from './pipeline/controller';
import { pendingChanges, testCaseStatus } from './pipeline/selectors';
import { clearBlocker, isRunActive, loadBlocker, recordBlocker, type PipelineSnapshot } from './pipeline/state';
import { RecorderPanel } from './RecorderPanel';
import { SettingsPanel } from './SettingsPanel';
import { StoragePanel } from './StoragePanel';
import { AsrTimelinePanel, TtsTimelinePanel } from './TimelinePanel';
import styles from './App.module.css';

/** The benchmark dashboard (spec §13): mic → Parakeet → transcript → Kokoro → speaker, every step timed. */
export function BenchmarkView({ snapshot: s, controller: c }: { snapshot: PipelineSnapshot; controller: PipelineController }) {
  const pending = useMemo(() => pendingChanges(s.models, s.settings), [s.models, s.settings]);
  const testCase = useMemo(() => testCaseStatus(s.models, s.settings, s.online), [s.models, s.settings, s.online]);
  const env = s.environment;
  const active = isRunActive(s.run);

  return (
    <main className={styles.grid}>
      <SettingsPanel
        className={styles.settings}
        settings={s.settings}
        onChange={c.updateSettings}
        environment={env}
        locked={s.loading || s.clearing || active || s.activity !== null}
        persistError={s.settingsError}
      />
      <ModelsPanel
        className={styles.models}
        models={s.models}
        pending={pending}
        loading={s.loading}
        loadBlocker={loadBlocker(s)}
        onLoad={() => void c.loadModels()}
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
  );
}

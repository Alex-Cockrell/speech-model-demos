'use client';

import { useEffect, useState } from 'react';
import { APP_INFO } from '@/lib/config';
import { BenchmarkView } from './BenchmarkView';
import { MeetingView } from './meeting/MeetingView';
import { wasmCrippled } from './pipeline/selectors';
import { ACTIVITY_NAMES } from './pipeline/state';
import { useSpeechPipeline } from './pipeline/useSpeechPipeline';
import { ReadAloudView } from './readaloud/ReadAloudView';
import { Chip } from './ui';
import styles from './App.module.css';

type Tab = 'meeting' | 'readaloud' | 'benchmark';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'meeting', label: 'Meeting transcription' },
  { id: 'readaloud', label: 'Read aloud' },
  { id: 'benchmark', label: 'Benchmark' },
];

const TAB_KEY = 'speech-poc:tab:v1';

function readTab(): Tab {
  try {
    const value = window.localStorage.getItem(TAB_KEY);
    return TABS.some((t) => t.id === value) ? (value as Tab) : 'meeting';
  } catch {
    return 'meeting';
  }
}

/**
 * App shell. One PipelineController owns the environment, settings and the loaded models for every mode,
 * so switching tabs never reloads a model. All three views stay mounted (only hidden), so a meeting keeps
 * transcribing while another tab is open.
 */
export default function App() {
  const { snapshot: s, controller: c } = useSpeechPipeline();
  const [tab, setTab] = useState<Tab>(readTab);
  const env = s.environment;

  useEffect(() => {
    try {
      window.localStorage.setItem(TAB_KEY, tab);
    } catch {
      // Per-viewer convenience only.
    }
  }, [tab]);

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Local Speech</h1>
          <p className={styles.tagline}>
            Speech recognition and speech synthesis that run entirely in this browser.
          </p>
        </div>
        <div className={styles.badges}>
          {s.activity && <Chip tone="info">Running: {ACTIVITY_NAMES[s.activity]}</Chip>}
          {env &&
            (env.crossOriginIsolated ? <Chip tone="ok">Cross-origin isolated</Chip> : <Chip tone="warn">Not cross-origin isolated</Chip>)}
          {env && (env.webgpu.adapterAvailable ? <Chip tone="ok">WebGPU available</Chip> : <Chip>No WebGPU</Chip>)}
          {env &&
            wasmCrippled(env) &&
            (env.wasm.available ? (
              <Chip tone="warn" title="See the Environment panel on the Benchmark tab">WASM likely interpreted (JIT off)</Chip>
            ) : (
              <Chip tone="err" title="See the Environment panel on the Benchmark tab">WebAssembly disabled</Chip>
            ))}
          {s.online ? <Chip tone="ok">Online</Chip> : <Chip tone="info">Offline</Chip>}
          <span className={styles.version}>
            v{APP_INFO.version}
            {APP_INFO.commit ? ` · ${APP_INFO.commit.slice(0, 7)}` : ''}
          </span>
        </div>
      </header>

      <nav className={styles.tabs} role="tablist" aria-label="Mode">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            className={styles.tab}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <section id="panel-meeting" role="tabpanel" aria-labelledby="tab-meeting" hidden={tab !== 'meeting'}>
        <MeetingView snapshot={s} controller={c} />
      </section>
      <section id="panel-readaloud" role="tabpanel" aria-labelledby="tab-readaloud" hidden={tab !== 'readaloud'}>
        <ReadAloudView snapshot={s} controller={c} />
      </section>
      <section id="panel-benchmark" role="tabpanel" aria-labelledby="tab-benchmark" hidden={tab !== 'benchmark'}>
        <BenchmarkView snapshot={s} controller={c} />
      </section>
    </div>
  );
}

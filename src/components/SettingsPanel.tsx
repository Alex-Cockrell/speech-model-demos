'use client';

import { memo, useId } from 'react';
import { NETWORK_LOCKED, modelFileUrl } from '@/lib/config';
import {
  BACKEND_CHOICES,
  ENCODER_QUANTS,
  FINAL_PASSES,
  KOKORO_DTYPES,
  SPEED_RANGE,
  TTS_SPLITS,
  VOICES,
  WASM_THREAD_CHOICES,
  MAX_SEGMENT_CHOICES,
  MIN_SILENCE_CHOICES,
  PARTIAL_INTERVAL_CHOICES,
  resolveModelSource,
  type AppSettings,
} from '@/lib/benchmark/settings';
import { TEST_MATRIX, describeTestCase } from '@/lib/benchmark/testMatrix';
import type { AsrSettings, BackendChoice, EnvironmentInfo, TtsSettings } from '@/lib/types';
import { BACKEND_LABEL } from './format';
import { Field, Notice, Panel, Segmented, SelectField } from './ui';
import styles from './panels.module.css';

type Update = (update: (s: AppSettings) => AppSettings) => void;

interface Props {
  settings: AppSettings;
  onChange: Update;
  environment: EnvironmentInfo | null;
  /** Load-time and model settings are locked while loading or recording. */
  locked: boolean;
  persistError: string | null;
  className?: string;
}

const BACKEND_OPTIONS = BACKEND_CHOICES.map((value) => ({
  value,
  label: value === 'auto' ? 'Auto' : `Force ${BACKEND_LABEL[value]}`,
}));

const QUANT_LABEL: Record<AsrSettings['encoderQuant'], string> = {
  auto: 'auto',
  int8: 'int8 (≈640 MB)',
  fp16: 'fp16 (≈1.2 GB)',
  fp32: 'fp32 (≈2.4 GB)',
};

const DTYPE_LABEL: Record<TtsSettings['dtype'], string> = {
  auto: 'auto',
  q8: 'q8 (≈92 MB)',
  fp32: 'fp32 (≈326 MB)',
  fp16: 'fp16 (≈163 MB)',
  q4: 'q4',
  q4f16: 'q4f16',
};

const threadOptions = WASM_THREAD_CHOICES.map((n) => ({ value: n, label: n === 0 ? 'auto' : String(n) }));

/** Mirrors the engines' documented 'auto' rules; the load record shows what was actually used. */
function usesWebGpu(backend: BackendChoice, env: EnvironmentInfo | null): boolean {
  return backend === 'webgpu' || (backend === 'auto' && env?.webgpu.adapterAvailable === true);
}

function expectedEncoderQuant(s: AppSettings, env: EnvironmentInfo | null): string {
  if (s.asr.encoderQuant !== 'auto') return s.asr.encoderQuant;
  if (!usesWebGpu(s.backend, env)) return 'int8';
  return env?.webgpu.shaderF16 ? 'fp16' : 'fp32';
}

function expectedDtype(s: AppSettings, env: EnvironmentInfo | null): string {
  if (s.tts.dtype !== 'auto') return s.tts.dtype;
  return usesWebGpu(s.backend, env) ? 'fp32' : 'fp16';
}

export const SettingsPanel = memo(function SettingsPanel({ settings: s, onChange, environment: env, locked, persistError, className }: Props) {
  const mirrorId = useId();
  const labelId = useId();
  const { source, error: sourceError } = resolveModelSource(s);
  const isolated = env?.crossOriginIsolated ?? false;
  const threadsHint = isolated
    ? `> 1 needs cross-origin isolation (available here). This CPU reports ${env?.hardwareConcurrency ?? '?'} threads.`
    : 'Not cross-origin isolated: the models will run single-threaded whatever is chosen (spec §16).';
  const setAsr = (patch: Partial<AsrSettings>) => onChange((x) => ({ ...x, asr: { ...x.asr, ...patch } }));
  const setTts = (patch: Partial<TtsSettings>) => onChange((x) => ({ ...x, tts: { ...x.tts, ...patch } }));
  const testCase = TEST_MATRIX.find((t) => t.id === s.testCase);

  return (
    <Panel title="Settings" subtitle="Backend, source and load-time settings apply on Load models" className={className}>
      {persistError && <Notice tone="warn" title="Settings are not persisted">{persistError}</Notice>}
      <div className={styles.settingsGrid}>
        <div className={styles.fieldsetStack}>
          <fieldset className={styles.fieldset} disabled={locked}>
            <legend>Backend</legend>
            <Segmented
              label="Backend"
              value={s.backend}
              options={BACKEND_OPTIONS}
              onChange={(backend) => onChange((x) => ({ ...x, backend }))}
            />
            <p className={styles.hint}>
              {s.backend === 'auto'
                ? 'Tries WebGPU, falls back to WASM and records why.'
                : s.backend === 'webgpu'
                  ? 'Best case. Fails instead of falling back.'
                  : 'CPU baseline: what machines without usable WebGPU get.'}{' '}
              On WebGPU the transcription model downloads the fp16 encoder (≈1.2 GB) instead of int8 (≈640 MB).
            </p>
          </fieldset>

          <fieldset className={styles.fieldset} disabled={locked}>
            <legend>Model source</legend>
            {NETWORK_LOCKED ? (
              <p className={styles.hint}>
                Fixed by this build: {source?.kind === 'mirror' ? <code className={styles.breakAll}>{source.baseUrl}</code> : 'the public model host'}.
                The browser blocks connections to any other host, so audio and text cannot leave this device.
              </p>
            ) : (
              <>
            <Segmented
              label="Model source"
              value={s.sourceKind}
              options={[
                { value: 'huggingface', label: 'Public model host' },
                { value: 'mirror', label: 'Mirror (custom URL)' },
              ]}
              onChange={(sourceKind) => onChange((x) => ({ ...x, sourceKind }))}
            />
            {s.sourceKind === 'mirror' && (
              <Field label="Mirror base URL" htmlFor={mirrorId}>
                <input
                  id={mirrorId}
                  type="url"
                  inputMode="url"
                  spellCheck={false}
                  placeholder="https://models.example.com"
                  value={s.mirrorBaseUrl}
                  onChange={(e) => {
                    const mirrorBaseUrl = e.target.value;
                    onChange((x) => ({ ...x, mirrorBaseUrl }));
                  }}
                />
              </Field>
            )}
              </>
            )}
            {sourceError ? (
              <p className={styles.fieldError}>{sourceError}</p>
            ) : (
              source && (
                <p className={styles.hint}>
                  {source.kind === 'mirror' ? (
                    <>
                      Files are read from{' '}
                      <code className={styles.breakAll}>{modelFileUrl(source, '{repo}', '{revision}', '{file}')}</code> — the mirror
                      must send CORS headers (the page requires COEP).
                    </>
                  ) : (
                    'Pinned model files are downloaded from the public model host, then cached in this browser.'
                  )}
                </p>
              )
            )}
          </fieldset>
        </div>

        <fieldset className={styles.fieldset} disabled={locked}>
          <legend>Transcription model</legend>
          <SelectField
            label="Encoder quantization"
            value={s.asr.encoderQuant}
            options={ENCODER_QUANTS.map((q) => ({ value: q, label: QUANT_LABEL[q] }))}
            onChange={(encoderQuant) => setAsr({ encoderQuant })}
            hint={`auto: int8 on WASM; fp16 on WebGPU with shader-f16, else fp32. Expected here: ${expectedEncoderQuant(s, env)}.`}
          />
          <SelectField
            label="Partial update interval"
            value={s.asr.partialIntervalMs}
            options={PARTIAL_INTERVAL_CHOICES.map((ms) => ({ value: ms, label: `${ms} ms` }))}
            onChange={(partialIntervalMs) => setAsr({ partialIntervalMs })}
            hint="Per run, no reload. How often the current segment is re-transcribed for live text; skipped while a pass is still running."
          />
          <SelectField
            label="Pause that ends a segment"
            value={s.asr.minSilenceMs}
            options={MIN_SILENCE_CHOICES.map((ms) => ({ value: ms, label: `${ms} ms` }))}
            onChange={(minSilenceMs) => setAsr({ minSilenceMs })}
            hint="Per run, no reload. Shorter pauses finalize text sooner but can split sentences."
          />
          <SelectField
            label="Max segment length"
            value={s.asr.maxSegmentMs}
            options={MAX_SEGMENT_CHOICES.map((ms) => ({ value: ms, label: `${ms / 1000} s` }))}
            onChange={(maxSegmentMs) => setAsr({ maxSegmentMs })}
            hint="Per run, no reload. Long monologues are cut at the quietest recent point so each pass stays bounded."
          />
          <SelectField
            label="Final pass"
            value={s.asr.finalPass}
            options={FINAL_PASSES.map((p) => ({
              value: p,
              label: p === 'full' ? 'full — re-transcribe the whole recording after Stop' : 'segments — finalize each segment as it ends',
            }))}
            onChange={(finalPass) => setAsr({ finalPass })}
            hint="Per run, no reload. segments keeps Stop → final text short; full adds a whole-recording pass to compare accuracy."
          />
          <SelectField
            label="WASM threads"
            value={s.asr.wasmThreads}
            options={threadOptions}
            onChange={(wasmThreads) => setAsr({ wasmThreads })}
            hint={threadsHint}
          />
        </fieldset>

        <fieldset className={styles.fieldset} disabled={locked}>
          <legend>Voice model</legend>
          <SelectField
            label="dtype"
            value={s.tts.dtype}
            options={KOKORO_DTYPES.map((d) => ({ value: d, label: DTYPE_LABEL[d] }))}
            onChange={(dtype) => setTts({ dtype })}
            hint={`auto: fp16 on WASM (≈2× faster than q8 there), fp32 on WebGPU. Expected here: ${expectedDtype(s, env)}.`}
          />
          <SelectField
            label="Voice"
            value={s.tts.voice}
            options={VOICES.map((v) => ({ value: v.id, label: v.label }))}
            onChange={(voice) => setTts({ voice })}
            hint="Fetched at load time so runs work offline; changing it needs Load models."
          />
          <Field label={`Speed ${s.tts.speed.toFixed(2)}×`} hint="Per run; no reload needed.">
            <input
              type="range"
              aria-label="Speech speed"
              min={SPEED_RANGE.min}
              max={SPEED_RANGE.max}
              step={SPEED_RANGE.step}
              value={s.tts.speed}
              onChange={(e) => setTts({ speed: Number(e.target.value) })}
            />
          </Field>
          <SelectField
            label="Split"
            value={s.tts.split}
            options={TTS_SPLITS.map((v) => ({
              value: v,
              label: v === 'sentence' ? 'sentence (default)' : 'clause — also on , ; :',
            }))}
            onChange={(split) => setTts({ split })}
            hint="clause: smaller chunks, earlier first audio, more chunk boundaries. Per run."
          />
          <SelectField
            label="WASM threads"
            value={s.tts.wasmThreads}
            options={threadOptions}
            onChange={(wasmThreads) => setTts({ wasmThreads })}
            hint={threadsHint}
          />
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend>Run tags</legend>
          <Field label="Device label" htmlFor={labelId} hint="Stored in every benchmark record, e.g. “Managed Dell 5440”.">
            <input
              id={labelId}
              type="text"
              maxLength={120}
              placeholder="Device / browser description"
              value={s.label}
              onChange={(e) => {
                const label = e.target.value;
                onChange((x) => ({ ...x, label }));
              }}
            />
          </Field>
          <SelectField
            label="Test case (spec §17)"
            value={s.testCase ?? ''}
            options={[
              { value: '', label: 'None' },
              ...TEST_MATRIX.map((t) => ({ value: t.id, label: `${t.id} · ${describeTestCase(t)}` })),
            ]}
            onChange={(id) => onChange((x) => ({ ...x, testCase: id === '' ? null : id }))}
            hint={
              testCase
                ? testCase.network === 'offline-after-load'
                  ? 'Load models online, then disconnect the network before Record.'
                  : testCase.cache === 'cold'
                    ? 'Use Clear model caches before Load models.'
                    : 'Load once to populate the cache, reload the page, then Load models.'
                : 'Tags runs with a row of the required test matrix.'
            }
          />
        </fieldset>
      </div>
    </Panel>
  );
});

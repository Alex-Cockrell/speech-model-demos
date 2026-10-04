'use client';

import { memo, useId } from 'react';
import { PARAKEET_MODEL, modelFileUrl } from '@/lib/config';
import {
  BACKEND_CHOICES,
  ENCODER_QUANTS,
  FINAL_PASSES,
  KOKORO_DTYPES,
  SPEED_RANGE,
  TTS_SPLITS,
  VOICES,
  WASM_THREAD_CHOICES,
  chunkMsOptions,
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
    : 'Not cross-origin isolated: ONNX Runtime will run single-threaded whatever is chosen (spec §16).';
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
              WebGPU Parakeet downloads the fp16 encoder (≈1.2 GB) instead of int8 (≈640 MB).
            </p>
          </fieldset>

          <fieldset className={styles.fieldset} disabled={locked}>
            <legend>Model source</legend>
            <Segmented
              label="Model source"
              value={s.sourceKind}
              options={[
                { value: 'huggingface', label: 'Hugging Face' },
                { value: 'mirror', label: 'Mirror' },
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
            {sourceError ? (
              <p className={styles.fieldError}>{sourceError}</p>
            ) : (
              source && (
                <p className={styles.hint}>
                  e.g.{' '}
                  <code className={styles.breakAll}>
                    {modelFileUrl(source, PARAKEET_MODEL.repo, `${PARAKEET_MODEL.revision.slice(0, 7)}…`, 'vocab.txt')}
                  </code>
                  {source.kind === 'mirror' && ' — the mirror must send CORS headers (the page requires COEP).'}
                </p>
              )
            )}
          </fieldset>
        </div>

        <fieldset className={styles.fieldset} disabled={locked}>
          <legend>Parakeet ASR</legend>
          <SelectField
            label="Encoder quantization"
            value={s.asr.encoderQuant}
            options={ENCODER_QUANTS.map((q) => ({ value: q, label: QUANT_LABEL[q] }))}
            onChange={(encoderQuant) => setAsr({ encoderQuant })}
            hint={`auto: int8 on WASM; fp16 on WebGPU with shader-f16, else fp32. Expected here: ${expectedEncoderQuant(s, env)}.`}
          />
          <SelectField
            label="Chunk size"
            value={s.asr.chunkMs}
            options={chunkMsOptions().map((ms) => ({ value: ms, label: `${ms} ms` }))}
            onChange={(chunkMs) => setAsr({ chunkMs })}
            hint="Per run, no reload. Smaller chunks: more frequent partial updates but more per-chunk overhead (higher streaming RTF)."
          />
          <SelectField
            label="Final pass"
            value={s.asr.finalPass}
            options={FINAL_PASSES.map((p) => ({
              value: p,
              label: p === 'full' ? 'full — re-transcribe after Stop' : 'streaming — use streamed text',
            }))}
            onChange={(finalPass) => setAsr({ finalPass })}
            hint="Per run, no reload. full is most accurate but adds its compute to Stop → final text."
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
          <legend>Kokoro TTS</legend>
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
              label: v === 'sentence' ? 'sentence (kokoro-js default)' : 'clause — also on , ; :',
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

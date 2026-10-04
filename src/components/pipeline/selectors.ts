/** Derived, display-only views of the pipeline state. */
import { resolveModelSource, type AppSettings } from '@/lib/benchmark/settings';
import { checkTestCase, findTestCase, type TestCase, type TestCaseCheck } from '@/lib/benchmark/testMatrix';
import type { EnvironmentInfo, ModelKey, ModelSource } from '@/lib/types';
import { BACKEND_LABEL, threadsLabel } from '../format';
import type { LoadConfig, ModelsState } from './state';

function change(label: string, from: string, to: string): string | null {
  return from === to ? null : `${label}: ${from} → ${to}`;
}

function sourceLabel(source: ModelSource): string {
  return source.kind === 'huggingface' ? 'Hugging Face' : source.baseUrl;
}

function present(items: (string | null)[]): string[] {
  return items.filter((i): i is string => i !== null);
}

/**
 * Load-time settings that differ from what each loaded instance was created with; Load models applies them.
 * ASR chunk size / final pass and TTS speed / split are per-run settings and never pending.
 */
export function pendingChanges(models: ModelsState, settings: AppSettings): Record<ModelKey, string[]> {
  const source = resolveModelSource(settings).source;
  const common = (applied: LoadConfig<unknown>) => [
    change('Backend', BACKEND_LABEL[applied.backend], BACKEND_LABEL[settings.backend]),
    source ? change('Model source', sourceLabel(applied.source), sourceLabel(source)) : null,
  ];
  const asr = models.parakeet.applied;
  const tts = models.kokoro.applied;
  const a = settings.asr;
  const t = settings.tts;
  return {
    parakeet: asr
      ? present([
          ...common(asr),
          change('Encoder quantization', asr.settings.encoderQuant, a.encoderQuant),
          change('WASM threads', threadsLabel(asr.settings.wasmThreads), threadsLabel(a.wasmThreads)),
        ])
      : [],
    kokoro: tts
      ? present([
          ...common(tts),
          change('dtype', tts.settings.dtype, t.dtype),
          change('Voice', tts.settings.voice, t.voice),
          change('WASM threads', threadsLabel(tts.settings.wasmThreads), threadsLabel(t.wasmThreads)),
        ])
      : [],
  };
}

/** WebAssembly missing, or so slow it is almost certainly interpreted (JIT disabled by policy). */
export function wasmCrippled(env: EnvironmentInfo): boolean {
  return !env.wasm.available || env.wasm.likelyInterpreted === true;
}

export interface TestCaseStatus {
  testCase: TestCase;
  checks: TestCaseCheck[];
}

/** How the current setup compares with the selected spec §17 row. */
export function testCaseStatus(models: ModelsState, settings: AppSettings, online: boolean): TestCaseStatus | null {
  const testCase = findTestCase(settings.testCase);
  if (!testCase) return null;
  const { parakeet, kokoro } = models;
  return {
    testCase,
    checks: checkTestCase(testCase, {
      backend: parakeet.applied?.backend ?? kokoro.applied?.backend ?? null,
      loadKinds: {
        parakeet: parakeet.phase === 'ready' ? (parakeet.record?.loadKind ?? null) : null,
        kokoro: kokoro.phase === 'ready' ? (kokoro.record?.loadKind ?? null) : null,
      },
      online,
    }),
  };
}

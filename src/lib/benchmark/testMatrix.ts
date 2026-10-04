import type { BackendChoice, LoadKind, ModelKey } from '../types';

/** One row of the required test matrix (spec §17). */
export interface TestCase {
  id: string;
  cache: 'cold' | 'warm';
  backend: BackendChoice;
  network: 'online' | 'offline-after-load';
}

export const TEST_MATRIX: readonly TestCase[] = [
  { id: '1', cache: 'cold', backend: 'auto', network: 'online' },
  { id: '2', cache: 'warm', backend: 'auto', network: 'online' },
  { id: '3', cache: 'warm', backend: 'webgpu', network: 'online' },
  { id: '4', cache: 'warm', backend: 'wasm', network: 'online' },
  { id: '5', cache: 'warm', backend: 'auto', network: 'offline-after-load' },
  { id: '6', cache: 'cold', backend: 'wasm', network: 'online' },
];

const CACHE_LABEL = { cold: 'Cold cache', warm: 'Warm cache' } as const;
const BACKEND_LABEL: Record<BackendChoice, string> = { auto: 'Auto', webgpu: 'WebGPU', wasm: 'WASM' };
const NETWORK_LABEL = { online: 'Online', 'offline-after-load': 'Offline after load' } as const;
const MODEL_LABEL: Record<ModelKey, string> = { parakeet: 'Transcription model', kokoro: 'Voice model' };
const KIND_LABEL: Record<LoadKind, string> = { cold: 'Cold', warm: 'Warm', partial: 'Partial', session: 'Session' };

export function findTestCase(id: string | null): TestCase | null {
  return TEST_MATRIX.find((t) => t.id === id) ?? null;
}

/** e.g. "Cold cache · Auto · Online" */
export function describeTestCase(tc: TestCase): string {
  return `${CACHE_LABEL[tc.cache]} · ${BACKEND_LABEL[tc.backend]} · ${NETWORK_LABEL[tc.network]}`;
}

export interface TestCaseCheck {
  label: string;
  ok: boolean;
  /** What was observed, plus how to fix it when it doesn't match. */
  detail: string;
}

export interface TestCaseState {
  /** Backend choice the loaded models were loaded with (null when nothing is loaded). */
  backend: BackendChoice | null;
  loadKinds: Record<ModelKey, LoadKind | null>;
  online: boolean;
}

/** Does the current setup match the selected test-matrix row? */
export function checkTestCase(tc: TestCase, state: TestCaseState): TestCaseCheck[] {
  const checks: TestCaseCheck[] = [];
  for (const model of ['parakeet', 'kokoro'] as const) {
    const kind = state.loadKinds[model];
    const ok = kind === tc.cache;
    const fix = tc.cache === 'cold' ? 'Clear model caches, then Load models' : 'reload the page, then Load models';
    checks.push({
      label: `${MODEL_LABEL[model]} ${tc.cache}`,
      ok,
      detail: kind == null ? `not loaded — ${fix}` : ok ? `${KIND_LABEL[kind]} load` : `${KIND_LABEL[kind]} load — ${fix}`,
    });
  }
  checks.push({
    label: `Backend ${BACKEND_LABEL[tc.backend]}`,
    ok: state.backend === tc.backend,
    detail:
      state.backend == null
        ? 'models not loaded'
        : state.backend === tc.backend
          ? `loaded with ${BACKEND_LABEL[state.backend]}`
          : `loaded with ${BACKEND_LABEL[state.backend]} — select ${BACKEND_LABEL[tc.backend]} and Load models`,
  });
  const wantOnline = tc.network === 'online';
  checks.push({
    label: NETWORK_LABEL[tc.network],
    ok: state.online === wantOnline,
    detail: state.online
      ? wantOnline
        ? 'browser reports online'
        : 'browser reports online — disconnect the network before recording'
      : wantOnline
        ? 'browser reports offline — reconnect'
        : 'browser reports offline',
  });
  return checks;
}

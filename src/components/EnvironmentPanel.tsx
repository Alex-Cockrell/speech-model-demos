'use client';

import { memo } from 'react';
import type { EnvironmentInfo, ModelLoadRecord, StorageInfo } from '@/lib/types';
import { BACKEND_LABEL, DASH, fmtBool, fmtBytes, fmtInt, fmtMs } from './format';
import { wasmCrippled } from './pipeline/selectors';
import { Chip, Kv, KvList, Notice, Panel } from './ui';
import styles from './panels.module.css';

interface Props {
  environment: EnvironmentInfo | null;
  error: string | null;
  storage: StorageInfo | null;
  online: boolean;
  parakeet: ModelLoadRecord | null;
  kokoro: ModelLoadRecord | null;
  className?: string;
}

function osLabel({ os }: EnvironmentInfo): string {
  const arch = [os.architecture, os.bitness && `${os.bitness}-bit`].filter(Boolean).join(' ');
  return [os.name, os.version, arch && `· ${arch}`].filter(Boolean).join(' ');
}

function memoryLabel(gb: number | null): string {
  if (gb == null) return DASH;
  // navigator.deviceMemory is rounded and capped at 8 by the browser.
  return gb >= 8 ? '≥ 8 GB (browser caps the value)' : `${gb} GB`;
}

function wasmLabel({ wasm }: EnvironmentInfo): string {
  if (!wasm.available) return 'unavailable';
  return [
    'available',
    `SIMD ${fmtBool(wasm.simd, 'yes', 'no')}`,
    `threads ${fmtBool(wasm.threads, 'yes', 'no')}`,
    `speed probe ${fmtMs(wasm.speedProbeMs)}`,
  ].join(' · ');
}

function resolvedBackend(record: ModelLoadRecord | null): string {
  if (!record) return 'not loaded';
  return `${BACKEND_LABEL[record.resolvedBackend]}${record.fallbackReason ? ' (fell back)' : ''}`;
}

export const EnvironmentPanel = memo(function EnvironmentPanel({ environment: env, error, storage, online, parakeet, kokoro, className }: Props) {
  const webgpu = env?.webgpu;
  const adapter = webgpu?.adapter;
  const store = storage ?? env?.storage ?? null;
  return (
    <Panel title="Environment" subtitle={env ? undefined : 'Detecting…'} className={className}>
      {error && (
        <Notice tone="err" title="Environment detection failed">
          {error}. Showing only what the browser exposes directly; Auto will use WASM.
        </Notice>
      )}
      {env && wasmCrippled(env) && (
        <Notice
          tone={env.wasm.available ? 'warn' : 'err'}
          title={env.wasm.available ? 'WebAssembly appears to be interpreted' : 'WebAssembly is disabled'}
        >
          WebAssembly appears to be interpreted or disabled (JIT off — e.g. Microsoft Edge Enhanced Security Mode, check{' '}
          <code>edge://policy</code>). WASM inference will be far slower than this hardware allows.
          {env.wasm.speedProbeMs != null && ` Speed probe: ${fmtMs(env.wasm.speedProbeMs)} (about 5–40 ms when JIT-compiled).`}
        </Notice>
      )}
      {env && !env.crossOriginIsolated && (
        <Notice tone="warn" title="Not cross-origin isolated">
          SharedArrayBuffer is unavailable, so ONNX Runtime WASM can only run single-threaded (spec §16). Serve the page
          with <code>Cross-Origin-Opener-Policy: same-origin</code> and <code>Cross-Origin-Embedder-Policy: require-corp</code>.
        </Notice>
      )}
      {env && (
        <KvList>
          <Kv label="Browser" title={env.browser.fullVersion ?? undefined}>
            {env.browser.name} {env.browser.version}
          </Kv>
          <Kv label="OS">{osLabel(env) || DASH}</Kv>
          {env.mobile && <Kv label="Device">Mobile</Kv>}
          <Kv label="CPU threads">{fmtInt(env.hardwareConcurrency)}</Kv>
          <Kv label="Device memory">{memoryLabel(env.deviceMemoryGB)}</Kv>
          <Kv label="WebGPU" hint={webgpu?.error ?? undefined}>
            {webgpu?.adapterAvailable ? (
              <Chip tone="ok">Available{adapter?.isFallbackAdapter ? ' (software fallback adapter)' : ''}</Chip>
            ) : webgpu?.apiPresent ? (
              <Chip tone="warn">API present, no adapter</Chip>
            ) : (
              <Chip>Not supported</Chip>
            )}
          </Kv>
          {adapter && (
            <Kv label="GPU adapter">
              {[adapter.vendor, adapter.architecture, adapter.device, adapter.description].filter(Boolean).join(' · ') || DASH}
            </Kv>
          )}
          {webgpu?.adapterAvailable && <Kv label="shader-f16">{fmtBool(webgpu.shaderF16)}</Kv>}
          {webgpu?.limits && (
            <Kv label="Max storage binding" title="maxStorageBufferBindingSize: the largest single weight buffer WebGPU can bind">
              {fmtBytes(webgpu.limits.maxStorageBufferBindingSize)}
            </Kv>
          )}
          <Kv label="Backend · Parakeet" hint={parakeet?.fallbackReason ?? undefined}>
            {resolvedBackend(parakeet)}
          </Kv>
          <Kv label="Backend · Kokoro" hint={kokoro?.fallbackReason ?? undefined}>
            {resolvedBackend(kokoro)}
          </Kv>
          <Kv label="crossOriginIsolated">
            {env.crossOriginIsolated ? <Chip tone="ok">true</Chip> : <Chip tone="warn">false</Chip>}
          </Kv>
          <Kv label="SharedArrayBuffer">{fmtBool(env.sharedArrayBuffer, 'Available', 'Unavailable')}</Kv>
          <Kv label="WASM" hint="speed probe: 10M-iteration loop, about 5–40 ms when JIT-compiled">
            {wasmCrippled(env) && (
              <Chip tone={env.wasm.available ? 'warn' : 'err'}>{env.wasm.available ? 'likely interpreted' : 'disabled'}</Chip>
            )}{' '}
            {wasmLabel(env)}
          </Kv>
          <Kv label="Storage" hint={store?.persisted ? 'persistent' : store?.persisted === false ? 'best-effort (may be evicted)' : undefined}>
            {fmtBytes(store?.usageBytes)} of {fmtBytes(store?.quotaBytes)}
          </Kv>
          <Kv label="Network">{online ? <Chip tone="ok">Online</Chip> : <Chip tone="info">Offline</Chip>}</Kv>
        </KvList>
      )}
      {env && (
        <details className={styles.details}>
          <summary>User agent</summary>
          <code className={styles.userAgent}>{env.userAgent}</code>
        </details>
      )}
    </Panel>
  );
});

/**
 * Environment detection (main thread). OWNER: platform agent.
 */
import { getStorageInfo } from './cache.js';
import type { EnvironmentInfo, StorageInfo, WebGpuInfo } from './types.js';

/** navigator.userAgentData (User-Agent Client Hints, Chromium only) is not in lib.dom. */
interface UaBrand {
  brand: string;
  version: string;
}
interface UaHighEntropyValues {
  architecture?: string;
  bitness?: string;
  brands?: UaBrand[];
  fullVersionList?: UaBrand[];
  mobile?: boolean;
  model?: string;
  platform?: string;
  platformVersion?: string;
}
interface NavigatorUaData {
  readonly brands: UaBrand[];
  readonly mobile: boolean;
  readonly platform: string;
  getHighEntropyValues(hints: string[]): Promise<UaHighEntropyValues>;
}
type ExtendedNavigator = Navigator & { userAgentData?: NavigatorUaData; deviceMemory?: number };

type Platform = Pick<EnvironmentInfo, 'browser' | 'os' | 'mobile'>;

/** requestAdapter() normally settles quickly; a broken GPU process must not stall the whole page. */
const ADAPTER_TIMEOUT_MS = 5000;

/** (func (result v128) i32.const 0 i8x16.splat i8x16.popcnt) — the probe wasm-feature-detect uses. */
const WASM_SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

/**
 * Collect browser / OS / hardware / WebGPU / WASM / isolation / storage facts.
 * Must never throw: unavailable facts become null / false with an error string where relevant.
 */
export async function detectEnvironment(): Promise<EnvironmentInfo> {
  const nav: ExtendedNavigator | undefined = typeof navigator === 'undefined' ? undefined : navigator;
  const userAgent = nav?.userAgent ?? '';
  const [platform, webgpu, storage] = await Promise.all([
    detectPlatform(nav, userAgent).catch(() => parseUserAgent(userAgent, 0)),
    detectWebGpu(nav).catch((err: unknown) => ({ ...emptyWebGpu(true), error: describeError(err) })),
    getStorageInfo().catch((): StorageInfo => ({ usageBytes: null, quotaBytes: null, persisted: null })),
  ]);
  const crossOriginIsolated = globalThis.crossOriginIsolated === true;
  const sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
  const speed = await probeWasmSpeed();
  return {
    collectedAt: new Date().toISOString(),
    userAgent,
    ...platform,
    hardwareConcurrency: nav?.hardwareConcurrency || null,
    deviceMemoryGB: typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : null,
    crossOriginIsolated,
    sharedArrayBuffer,
    wasm: {
      available: typeof WebAssembly === 'object',
      simd: wasmSimdSupported(),
      threads: crossOriginIsolated && sharedArrayBuffer && sharedWasmMemorySupported(),
      ...speed,
    },
    webgpu,
    storage,
    online: nav?.onLine ?? false,
  };
}

// ---------------------------------------------------------------------------
// Browser / OS
// ---------------------------------------------------------------------------

async function detectPlatform(nav: ExtendedNavigator | undefined, userAgent: string): Promise<Platform> {
  const fromUa = parseUserAgent(userAgent, nav?.maxTouchPoints ?? 0);
  const uaData = nav?.userAgentData;
  if (!uaData) return fromUa;
  let hints: UaHighEntropyValues = {};
  try {
    hints = await uaData.getHighEntropyValues(['fullVersionList', 'platformVersion', 'architecture', 'bitness', 'model']);
  } catch {
    // Low-entropy brands/platform are still available.
  }
  return fromClientHints(uaData, hints, fromUa);
}

/** "Not A(Brand"-style entries Chromium adds so sites cannot rely on exact brand lists. */
const GREASE_BRAND = /not.?a.?brand/i;
const BRAND_NAMES: Record<string, string> = { 'Google Chrome': 'Chrome', 'Microsoft Edge': 'Edge' };
const CLIENT_HINT_OS: Record<string, string> = { 'Chrome OS': 'ChromeOS', 'Chromium OS': 'ChromeOS' };

function fromClientHints(data: NavigatorUaData, hints: UaHighEntropyValues, fallback: Platform): Platform {
  const brands = (hints.brands ?? data.brands ?? []).filter((b) => !GREASE_BRAND.test(b.brand));
  // The product brand ("Google Chrome", "Microsoft Edge", "Brave", "Opera", …) rather than "Chromium".
  const brand = brands.find((b) => b.brand !== 'Chromium') ?? brands[0];
  const platformName = hints.platform || data.platform;
  return {
    browser: brand
      ? {
          name: BRAND_NAMES[brand.brand] ?? brand.brand,
          version: brand.version,
          fullVersion: hints.fullVersionList?.find((b) => b.brand === brand.brand)?.version ?? null,
        }
      : fallback.browser,
    os: {
      name: platformName ? (CLIENT_HINT_OS[platformName] ?? platformName) : fallback.os.name,
      version: clientHintOsVersion(platformName, hints.platformVersion) ?? fallback.os.version,
      architecture: hints.architecture || fallback.os.architecture,
      bitness: hints.bitness || fallback.os.bitness,
    },
    mobile: hints.mobile ?? data.mobile ?? fallback.mobile,
  };
}

function clientHintOsVersion(platform: string, platformVersion: string | undefined): string | null {
  if (!platformVersion) return null;
  if (platform !== 'Windows') return platformVersion;
  // Sec-CH-UA-Platform-Version on Windows: 13+ = Windows 11, 1–10 = Windows 10, 0 = Windows 7/8/8.1.
  const major = Number.parseInt(platformVersion, 10);
  if (Number.isNaN(major)) return platformVersion;
  const name = major >= 13 ? '11' : major >= 1 ? '10' : '7/8/8.1';
  return `${name} (${platformVersion})`;
}

const BROWSER_PATTERNS: [name: string, pattern: RegExp][] = [
  // Order matters: Edge and Opera UAs also contain "Chrome/", and Chrome's contains "Safari/".
  ['Edge', /\b(?:Edg|EdgA|EdgiOS)\/([\d.]+)/],
  ['Opera', /\b(?:OPR|OPiOS)\/([\d.]+)/],
  ['Firefox', /\b(?:Firefox|FxiOS)\/([\d.]+)/],
  ['Chrome', /\b(?:Chrome|CriOS)\/([\d.]+)/],
  ['Safari', /\bVersion\/([\d.]+).*\bSafari\//],
];

const WINDOWS_NT: Record<string, string> = { '10.0': '10 or 11', '6.3': '8.1', '6.2': '8', '6.1': '7' };

function parseUserAgent(ua: string, maxTouchPoints: number): Platform {
  let browser: Platform['browser'] = { name: 'Unknown', version: 'unknown', fullVersion: null };
  for (const [name, pattern] of BROWSER_PATTERNS) {
    const m = pattern.exec(ua);
    if (!m) continue;
    // Chromium's reduced UA string zeroes everything after the major version.
    browser = { name, version: m[1].split('.')[0], fullVersion: /^\d+\.0\.0\.0$/.test(m[1]) ? null : m[1] };
    break;
  }
  return { browser, os: parseOs(ua, maxTouchPoints), mobile: ua ? /Mobi/i.test(ua) : null };
}

function parseOs(ua: string, maxTouchPoints: number): EnvironmentInfo['os'] {
  let m: RegExpExecArray | null;
  if ((m = /Windows NT (\d+\.\d+)/.exec(ua))) {
    const arch = /ARM64|aarch64/i.test(ua) ? ['arm', '64'] : /Win64|x64|WOW64|amd64/i.test(ua) ? ['x86', '64'] : [null, null];
    return { name: 'Windows', version: WINDOWS_NT[m[1]] ?? m[1], architecture: arch[0], bitness: arch[1] };
  }
  // iPadOS asks for desktop sites with a Macintosh UA; touch support gives it away.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) {
    m = /\bOS (\d+(?:_\d+)*) like Mac OS X/.exec(ua);
    return { name: 'iOS', version: m ? m[1].replace(/_/g, '.') : null, architecture: null, bitness: null };
  }
  if ((m = /Android (\d+(?:\.\d+)*)/.exec(ua)) || /Android/.test(ua)) {
    return { name: 'Android', version: m?.[1] ?? null, architecture: null, bitness: null };
  }
  if (/\bCrOS\b/.test(ua)) {
    m = /\bCrOS \S+ (\d+(?:\.\d+)*)/.exec(ua);
    return { name: 'ChromeOS', version: m?.[1] ?? null, ...linuxArch(ua) };
  }
  if (/Mac OS X/.test(ua)) {
    // Browsers freeze the macOS version in the UA at 10.15(.7) and report Intel even on Apple silicon.
    m = /Mac OS X (\d+[._]\d+(?:[._]\d+)?)/.exec(ua);
    const version = m?.[1].replace(/_/g, '.') ?? null;
    return { name: 'macOS', version: version?.startsWith('10.15') ? null : version, architecture: null, bitness: null };
  }
  if (/Linux/.test(ua)) return { name: 'Linux', version: null, ...linuxArch(ua) };
  return { name: 'Unknown', version: null, architecture: null, bitness: null };
}

function linuxArch(ua: string): Pick<EnvironmentInfo['os'], 'architecture' | 'bitness'> {
  if (/x86_64|amd64/i.test(ua)) return { architecture: 'x86', bitness: '64' };
  if (/aarch64|arm64/i.test(ua)) return { architecture: 'arm', bitness: '64' };
  if (/i[3-6]86/i.test(ua)) return { architecture: 'x86', bitness: '32' };
  if (/armv[67]/i.test(ua)) return { architecture: 'arm', bitness: '32' };
  return { architecture: null, bitness: null };
}

// ---------------------------------------------------------------------------
// WebGPU
// ---------------------------------------------------------------------------

function emptyWebGpu(apiPresent: boolean): WebGpuInfo {
  return { apiPresent, adapterAvailable: false, adapter: null, features: [], shaderF16: false, limits: null, error: null };
}

async function detectWebGpu(nav: ExtendedNavigator | undefined): Promise<WebGpuInfo> {
  const gpu = nav?.gpu;
  if (!gpu) return emptyWebGpu(false);
  const info = emptyWebGpu(true);
  try {
    const adapter = await withTimeout(gpu.requestAdapter(), ADAPTER_TIMEOUT_MS, 'navigator.gpu.requestAdapter() timed out');
    if (!adapter) {
      info.error = 'requestAdapter() returned null: no usable GPU adapter (GPU/driver blocklisted, hardware acceleration off, or WebGPU disabled by policy)';
      return info;
    }
    info.adapterAvailable = true;
    // adapter.info shipped in Chrome 127 and GPUAdapterInfo.isFallbackAdapter later; older builds had
    // GPUAdapter.isFallbackAdapter instead.
    const details = adapter.info as Partial<GPUAdapterInfo> | undefined;
    const legacyFallback = (adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter;
    const isFallbackAdapter = details?.isFallbackAdapter ?? legacyFallback;
    info.adapter = {
      vendor: details?.vendor ?? '',
      architecture: details?.architecture ?? '',
      device: details?.device ?? '',
      description: details?.description ?? '',
      isFallbackAdapter: typeof isFallbackAdapter === 'boolean' ? isFallbackAdapter : null,
    };
    info.features = [...adapter.features].sort();
    info.shaderF16 = adapter.features.has('shader-f16');
    info.limits = {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    };
  } catch (err) {
    info.error = describeError(err);
  }
  return info;
}

// ---------------------------------------------------------------------------
// WebAssembly
// ---------------------------------------------------------------------------

function wasmSimdSupported(): boolean {
  try {
    return typeof WebAssembly === 'object' && WebAssembly.validate(WASM_SIMD_PROBE);
  } catch {
    return false;
  }
}

/**
 * (func (export "spin") (param $n i32) (result i32)) — runs `acc = acc * 31 + i` $n times.
 * Hand-assembled so the probe needs no build step.
 */
const WASM_SPEED_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic, version
  0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f, // type 0: (i32) -> i32
  0x03, 0x02, 0x01, 0x00, // function 0 has type 0
  0x07, 0x08, 0x01, 0x04, 0x73, 0x70, 0x69, 0x6e, 0x00, 0x00, // export "spin"
  0x0a, 0x28, 0x01, 0x26, 0x01, 0x02, 0x7f, // code: one 38-byte body, locals $i $acc: i32
  0x02, 0x40, 0x03, 0x40, // block, loop
  0x20, 0x01, 0x20, 0x00, 0x4f, 0x0d, 0x01, // br_if out when $i >= $n
  0x20, 0x02, 0x41, 0x1f, 0x6c, 0x20, 0x01, 0x6a, 0x21, 0x02, // $acc = $acc * 31 + $i
  0x20, 0x01, 0x41, 0x01, 0x6a, 0x21, 0x01, // $i++
  0x0c, 0x00, 0x0b, 0x0b, // br loop; end loop; end block
  0x20, 0x02, 0x0b, // return $acc
]);
const SPEED_PROBE_ITERATIONS = 10_000_000;
/**
 * Compiled code runs the probe in roughly 5–40 ms on current laptops; interpreted WebAssembly is an
 * order of magnitude slower. Managed Edge with Enhanced Security Mode disables the JIT, which would
 * make WASM inference look hopeless for reasons that have nothing to do with the hardware.
 */
const INTERPRETED_THRESHOLD_MS = 120;

async function probeWasmSpeed(): Promise<{ speedProbeMs: number | null; likelyInterpreted: boolean | null }> {
  try {
    const { instance } = await WebAssembly.instantiate(WASM_SPEED_PROBE);
    const spin = instance.exports.spin as (n: number) => number;
    spin(1_000); // compile before timing
    const start = performance.now();
    spin(SPEED_PROBE_ITERATIONS);
    const speedProbeMs = performance.now() - start;
    return { speedProbeMs, likelyInterpreted: speedProbeMs > INTERPRETED_THRESHOLD_MS };
  } catch {
    return { speedProbeMs: null, likelyInterpreted: null };
  }
}

/** Threads need a shared WebAssembly.Memory, which only cross-origin isolated pages may create. */
function sharedWasmMemorySupported(): boolean {
  try {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    return memory.buffer instanceof SharedArrayBuffer;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** WebGPU availability and adapter features only (what the engines need to resolve 'auto'); never throws. */
export function detectWebGpuSupport(): Promise<WebGpuInfo> {
  return detectWebGpu(typeof navigator === 'undefined' ? undefined : (navigator as ExtendedNavigator));
}

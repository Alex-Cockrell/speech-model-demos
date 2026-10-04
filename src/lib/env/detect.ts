/**
 * Environment detection (main thread). OWNER: platform agent.
 *
 * This file currently holds the public interface only; the implementation replaces the bodies.
 */
import type { EnvironmentInfo } from '../types';

/**
 * Collect browser / OS / hardware / WebGPU / WASM / isolation / storage facts.
 * Must never throw: unavailable facts become null / false with an error string where relevant.
 */
export async function detectEnvironment(): Promise<EnvironmentInfo> {
  throw new Error('detectEnvironment not implemented');
}

/**
 * One monotonic clock for the whole app: the main thread's performance.now() timeline.
 *
 * Workers have a different performance.timeOrigin. A worker calls setMainTimeOrigin() once
 * with the value the main thread sends it (performance.timeOrigin on the main thread);
 * after that, now() in the worker returns values directly comparable to main-thread now().
 */

let mainTimeOrigin: number = typeof performance !== 'undefined' ? performance.timeOrigin : 0;

export function setMainTimeOrigin(origin: number): void {
  mainTimeOrigin = origin;
}

/** Main-thread performance.now() equivalent, valid in any context. */
export function now(): number {
  return performance.timeOrigin + performance.now() - mainTimeOrigin;
}

/** The value a worker needs for setMainTimeOrigin(). Call on the main thread. */
export function mainTimeOriginForWorkers(): number {
  return performance.timeOrigin;
}

/** b - a, or null when either side is missing. */
export function span(a: number | null | undefined, b: number | null | undefined): number | null {
  return a == null || b == null ? null : b - a;
}

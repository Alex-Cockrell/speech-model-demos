import type { IntervalStats } from './types';

/** Stats over the gaps between consecutive timestamps. */
export function intervalStats(timestamps: number[]): IntervalStats {
  const gaps: number[] = [];
  for (let i = 1; i < timestamps.length; i++) gaps.push(timestamps[i] - timestamps[i - 1]);
  return summarize(gaps);
}

export function summarize(values: number[]): IntervalStats {
  if (values.length === 0) {
    return { count: 0, meanMs: null, medianMs: null, minMs: null, maxMs: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    count: values.length,
    meanMs: values.reduce((s, v) => s + v, 0) / values.length,
    medianMs: median,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  };
}

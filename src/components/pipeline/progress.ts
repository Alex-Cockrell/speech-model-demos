import type { LoadProgress } from '@/lib/types';
import type { FileProgress } from './state';

const PROGRESS_INTERVAL_MS = 100;

/** Downloads can report hundreds of progress events per second; coalesce them to ~10 UI updates/s. */
export function createProgressSink(apply: (latest: LoadProgress, files: Record<string, FileProgress>) => void) {
  const files: Record<string, FileProgress> = {};
  let latest: LoadProgress | null = null;
  let appliedPhase: LoadProgress['phase'] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const flush = () => {
    timer = null;
    if (closed || !latest) return;
    appliedPhase = latest.phase;
    apply(latest, { ...files });
  };
  return {
    push(p: LoadProgress) {
      if (closed) return;
      latest = p;
      if (p.file != null && p.loadedBytes != null) {
        files[p.file] = { loadedBytes: p.loadedBytes, totalBytes: p.totalBytes ?? null };
      }
      if (p.phase !== appliedPhase) {
        if (timer) clearTimeout(timer);
        flush(); // phase changes show immediately so short phases (initialize, warm-up) are visible
      } else if (!timer) {
        timer = setTimeout(flush, PROGRESS_INTERVAL_MS);
      }
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
}

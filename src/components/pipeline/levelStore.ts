/**
 * Microphone level arrives ~20×/s. It lives in its own tiny store so only the meter re-renders,
 * not the whole dashboard.
 */
export interface LevelStore {
  get(): number;
  set(rms: number): void;
  subscribe(listener: () => void): () => void;
}

export function createLevelStore(): LevelStore {
  let level = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => level,
    set(rms) {
      if (rms === level) return;
      level = rms;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

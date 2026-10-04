'use client';
// TEMPORARY bundling smoke test — the UI agent replaces this file.
import { useEffect, useState } from 'react';

export default function App() {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    const workers = [
      new Worker(new URL('../lib/asr/asr.worker.ts', import.meta.url), { type: 'module' }),
      new Worker(new URL('../lib/tts/tts.worker.ts', import.meta.url), { type: 'module' }),
    ];
    for (const w of workers) {
      w.onmessage = (e) => setLines((l) => [...l, JSON.stringify(e.data)]);
      w.onerror = (e) => setLines((l) => [...l, 'error: ' + e.message]);
      w.postMessage('ping');
    }
    return () => workers.forEach((w) => w.terminate());
  }, []);
  return <pre id="smoke">{`crossOriginIsolated=${String(globalThis.crossOriginIsolated)}\n${lines.join('\n')}`}</pre>;
}

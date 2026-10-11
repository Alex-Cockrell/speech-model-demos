/** Main-thread side of asr.worker.ts: one Worker, request/response bookkeeping, failure handling. */
import type { LoadProgress } from '@local-speech/core';
import type { LoadRequest, LoadResult, MainToWorker, PassKind, PassResult, WorkerToMain } from './protocol.js';
import type { PassRunner } from './transcriber.js';

/** The worker is gone (crashed, terminated, unloaded): no further pass can succeed. */
export class AsrWorkerStoppedError extends Error {
  readonly fatal = true;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Rejections reach whoever awaits; this only keeps unobserved ones out of the console.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export class AsrWorkerClient implements PassRunner {
  private readonly worker: Worker;
  private load: Deferred<LoadResult> | null = null;
  private readonly counts = new Map<number, Deferred<number>>();
  private readonly passes = new Map<number, Deferred<PassResult>>();
  private nextId = 1;
  private stopped: AsrWorkerStoppedError | null = null;
  private terminated = false;

  constructor(
    private readonly onProgress: (progress: LoadProgress) => void,
    private readonly onFailure: (error: Error) => void,
  ) {
    this.worker = new Worker(new URL('./asr.worker.js', import.meta.url), { type: 'module', name: 'parakeet-asr' });
    this.worker.addEventListener('message', (event: MessageEvent<WorkerToMain>) => this.dispatch(event.data));
    this.worker.addEventListener('error', (event: ErrorEvent) => {
      const where = event.filename ? ` (${event.filename}:${event.lineno})` : '';
      this.fail(
        event.message
          ? `ASR worker error: ${event.message}${where}`
          : 'The ASR worker failed to start or crashed (no details; see the browser console).',
      );
    });
    this.worker.addEventListener('messageerror', () => this.fail('The ASR worker sent a message that could not be read.'));
  }

  loadModel(request: LoadRequest): Promise<LoadResult> {
    this.load?.reject(new Error('Superseded by a newer load request.'));
    const pending = deferred<LoadResult>();
    this.load = pending;
    this.post(request);
    return pending.promise;
  }

  /** One inference pass; `audio` is transferred to the worker. */
  run(kind: PassKind, audio: Float32Array<ArrayBuffer>, growKey: string | null): Promise<PassResult> {
    if (this.stopped) return Promise.reject(this.stopped);
    const passId = this.nextId++;
    const pending = deferred<PassResult>();
    this.passes.set(passId, pending);
    this.post({ type: 'pass', passId, kind, audio, growKey }, [audio.buffer]);
    return pending.promise;
  }

  requestCount(): Promise<number> {
    if (this.stopped) return Promise.reject(new Error('The ASR worker is not running.'));
    const requestId = this.nextId++;
    const pending = deferred<number>();
    this.counts.set(requestId, pending);
    this.post({ type: 'count', requestId });
    return pending.promise;
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    if (!this.stopped) this.stop(new AsrWorkerStoppedError('The ASR worker was stopped (the model was unloaded).'));
    this.worker.terminate();
  }

  private post(message: MainToWorker, transfer: Transferable[] = []): void {
    if (!this.stopped) this.worker.postMessage(message, transfer);
  }

  private dispatch(message: WorkerToMain): void {
    switch (message.type) {
      case 'progress':
        this.onProgress(message.progress);
        break;
      case 'loaded':
        this.load?.resolve(message.result);
        this.load = null;
        break;
      case 'loadError':
        this.load?.reject(new Error(message.message));
        this.load = null;
        break;
      case 'passResult': {
        const { passId, text, words, computeMs, melPrefixSamples } = message;
        this.passes.get(passId)?.resolve({ text, words, computeMs, melPrefixSamples });
        this.passes.delete(passId);
        break;
      }
      case 'passError':
        this.passes.get(message.passId)?.reject(new Error(message.message));
        this.passes.delete(message.passId);
        break;
      case 'count':
        this.counts.get(message.requestId)?.resolve(message.count);
        this.counts.delete(message.requestId);
        break;
      case 'unexpectedError':
        this.fail(message.message);
        break;
    }
  }

  private fail(message: string): void {
    if (this.stopped) return;
    const error = new AsrWorkerStoppedError(message);
    this.stop(error);
    this.onFailure(error);
  }

  private stop(error: AsrWorkerStoppedError): void {
    this.stopped = error;
    this.load?.reject(error);
    this.load = null;
    for (const pending of this.counts.values()) pending.reject(error);
    this.counts.clear();
    for (const pending of this.passes.values()) pending.reject(error);
    this.passes.clear();
  }
}

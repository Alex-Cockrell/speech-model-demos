import { describe, expect, it } from 'vitest';
import type { SynthesisJob, SynthesisOptions, SynthesisResult } from '../src/engine';
import { ReadAloudSession, type ReaderBackend, type Timers } from '../src/reader';

const RATE = 24_000;

/** Just enough of an AudioContext for the reader: a clock the test advances, and inert nodes. */
class FakeAudioContext {
  currentTime = 0;
  state: AudioContextState = 'running';
  readonly destination = {};
  readonly sampleRate = RATE;
  readonly baseLatency = 0;
  readonly outputLatency = 0;
  createGain() {
    return { connect() {}, disconnect() {} };
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return { duration: length / sampleRate, getChannelData: () => data };
  }
  createBufferSource() {
    return { buffer: null, onended: null, connect() {}, disconnect() {}, start() {}, stop() {} };
  }
  suspend() {
    this.state = 'suspended';
    return Promise.resolve();
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
}

/** Each request resolves when the test says so, with `seconds` of a quiet tone. */
class FakeBackend implements ReaderBackend {
  readonly requests: { text: string; resolve: (seconds: number) => void }[] = [];
  synthesize(text: string, _options: SynthesisOptions): SynthesisJob {
    let resolve!: (seconds: number) => void;
    const result = new Promise<SynthesisResult>((done) => {
      resolve = (seconds) => {
        const audio = new Float32Array(Math.round(seconds * RATE)).map((_, i) => 0.1 * Math.sin(i / 10));
        done({
          audio,
          sampleRate: RATE,
          requestedAt: 0,
          generationStart: 0,
          generatedAt: 1,
          inferences: 1,
          maxTokens: 10,
          overflowSplits: 0,
          truncated: false,
          firstProblem: null,
          retries: 0,
          failed: false,
          skipped: false,
        });
      };
    });
    this.requests.push({ text, resolve });
    return { id: this.requests.length, result, cancel() {} };
  }
}

/** Timers the test drives: tick() runs the reader's interval callback. */
class ManualTimers implements Timers {
  private interval: (() => void) | null = null;
  setInterval(callback: () => void) {
    this.interval = callback;
    return 1;
  }
  clearInterval() {
    this.interval = null;
  }
  setTimeout() {
    return 2;
  }
  clearTimeout() {}
  tick() {
    this.interval?.();
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(init: { pieces?: string[]; inputEnded?: boolean } = {}) {
  const ctx = new FakeAudioContext();
  const backend = new FakeBackend();
  const timers = new ManualTimers();
  const session = new ReadAloudSession({
    ctx: ctx as unknown as AudioContext,
    backend,
    pieces: (init.pieces ?? []).map((text) => ({ text, chars: text.length })),
    inputEnded: init.inputEnded,
    voice: 'af_heart',
    speed: 1,
    timers,
  });
  /** Advances the audio clock and lets the reader notice. */
  const advance = (seconds: number) => {
    ctx.currentTime += seconds;
    timers.tick();
  };
  return { ctx, backend, timers, session, advance };
}

describe('ReadAloudSession with streamed input', () => {
  it('waits for appended pieces instead of ending, and ends only after endInput()', async () => {
    const { backend, session, advance } = setup({ inputEnded: false });
    session.start();
    expect(session.getSnapshot().status).toBe('playing');

    session.append([{ text: 'First.', chars: 6 }]);
    expect(backend.requests.map((r) => r.text)).toEqual(['First.']);
    backend.requests[0].resolve(1);
    await flush();
    advance(1.5); // the first piece has played; no more text yet
    expect(session.getSnapshot().status).toBe('playing');
    expect(session.position().waitingForText).toBe(true);

    advance(4); // the LLM is slow: waiting for text is not a stall
    session.append([{ text: 'Second.', chars: 7 }]);
    backend.requests[1].resolve(1);
    await flush();
    expect(session.getSnapshot().metrics.stalls).toBe(0);
    expect(session.position().waitingForText).toBe(false);

    session.endInput();
    advance(1.5);
    expect(session.getSnapshot().status).toBe('ended');
    await expect(session.done).resolves.toBe('ended');
  });

  it('still counts a real stall: text was there but generation fell behind playback', async () => {
    const { backend, session, advance } = setup({ pieces: ['One.', 'Two.'] });
    session.start();
    backend.requests[0].resolve(0.5);
    await flush();
    advance(2); // played out while piece two is still generating
    backend.requests[1].resolve(0.5);
    await flush();
    expect(session.getSnapshot().metrics.stalls).toBe(1);
    advance(1);
    expect(session.getSnapshot().status).toBe('ended');
  });

  it('ends at once with no text and input ended (an empty speak())', async () => {
    const { session } = setup({ pieces: [], inputEnded: true });
    session.start();
    expect(session.getSnapshot().status).toBe('ended');
    await expect(session.done).resolves.toBe('ended');
  });

  it('endInput() before start() with nothing appended also ends', async () => {
    const { session } = setup({ inputEnded: false });
    session.endInput();
    session.start();
    await expect(session.done).resolves.toBe('ended');
  });

  it('stop() settles done as stopped and ignores later appends', async () => {
    const { backend, session } = setup({ inputEnded: false });
    session.start();
    session.stop();
    session.append([{ text: 'Too late.', chars: 9 }]);
    expect(backend.requests).toHaveLength(0);
    await expect(session.done).resolves.toBe('stopped');
  });
});

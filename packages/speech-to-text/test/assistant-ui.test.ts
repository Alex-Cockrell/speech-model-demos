import { describe, expect, it } from 'vitest';
import { createDictationAdapter, type DictationAdapterResult } from '../src/assistant-ui';
import { SegmentTexts } from '../src/segment-texts';
import type { Dictation, DictationOptions, DictationState } from '../src/speech-to-text';

/** A dictation the test drives: it reports what the real one would, in the same order. */
class FakeDictation implements Dictation {
  readonly done: Promise<string>;
  private state: DictationState = { status: 'loading', text: '', finalText: '', error: null };
  private readonly listeners = new Set<() => void>();
  private readonly texts = new SegmentTexts();
  private readonly started = new Set<string>();
  private resolve!: (text: string) => void;
  constructor(private readonly options: DictationOptions) {
    this.done = new Promise((resolve) => (this.resolve = resolve));
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(patch: Partial<DictationState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
  /** The engine announces every segment (onSegmentStart) before its partials and final. */
  private ensureStarted(id: string) {
    if (!this.started.has(id)) {
      this.started.add(id);
      this.texts.start(id);
    }
  }
  partial(id: string, text: string) {
    this.ensureStarted(id);
    this.texts.partial(id, text);
    this.options.onPartial?.(text, id);
    this.set({ text: this.texts.visible });
  }
  final(id: string, text: string) {
    this.ensureStarted(id);
    this.texts.final(id, text);
    this.options.onFinal?.(text, id);
    this.set({ text: this.texts.visible, finalText: this.texts.finals });
  }
  /** Like the real one: the open segment is finalized before stop() resolves. */
  async stop() {
    this.set({ status: 'stopping' });
    await Promise.resolve();
    this.final('s2', 'and goodbye');
    this.set({ status: 'ended' });
    this.resolve(this.state.finalText);
    return this.state.finalText;
  }
  cancel() {
    this.set({ status: 'cancelled' });
    this.resolve(this.state.finalText);
  }
}

function listen() {
  let fake!: FakeDictation;
  const adapter = createDictationAdapter({
    dictate: (options) => (fake = new FakeDictation(options ?? {})),
  });
  const session = adapter.listen();
  const log: string[] = [];
  const results: DictationAdapterResult[] = [];
  session.onSpeechStart(() => log.push('start'));
  session.onSpeech((r) => {
    results.push(r);
    log.push(`speech:${r.isFinal ? 'final' : 'partial'}:${r.transcript}`);
  });
  session.onSpeechEnd((r) => log.push(`end:${r.transcript}`));
  return { adapter, session, fake, log, results };
}

describe('createDictationAdapter (assistant-ui DictationAdapter contract)', () => {
  it('keeps the composer editable', () => {
    expect(listen().adapter.disableInputDuringDictation).toBe(false);
  });

  it('reports starting, then running with one onSpeechStart once listening', () => {
    const { session, fake, log } = listen();
    expect(session.status).toEqual({ type: 'starting' });
    fake.set({ status: 'starting' });
    fake.set({ status: 'listening' });
    fake.set({ status: 'listening' });
    expect(session.status).toEqual({ type: 'running' });
    expect(log).toEqual(['start']);
  });

  it('sends live text as isFinal:false and each finished segment as isFinal:true', () => {
    const { fake, results } = listen();
    fake.set({ status: 'listening' });
    fake.partial('s1', 'hello');
    fake.partial('s1', 'hello there');
    fake.final('s1', 'Hello there.');
    expect(results).toEqual([
      { transcript: 'hello', isFinal: false },
      { transcript: 'hello there', isFinal: false },
      { transcript: 'Hello there.', isFinal: true },
    ]);
  });

  it('clears the preview for a segment without words instead of appending nothing', () => {
    const { fake, results } = listen();
    fake.final('s1', '   ');
    expect(results).toEqual([{ transcript: '', isFinal: false }]);
  });

  it('delivers the last final before stop() resolves, then one onSpeechEnd', async () => {
    const { session, fake, log } = listen();
    fake.set({ status: 'listening' });
    fake.final('s1', 'Hello there.');
    const stopped = session.stop().then(() => log.push('stop resolved'));
    await stopped;
    expect(log).toEqual(['start', 'speech:final:Hello there.', 'speech:final:and goodbye', 'end:Hello there. and goodbye', 'stop resolved']);
    expect(session.status).toEqual({ type: 'ended', reason: 'stopped' });
  });

  it('cancel() ends as cancelled with a single onSpeechEnd', () => {
    const { session, fake, log } = listen();
    fake.set({ status: 'listening' });
    session.cancel();
    session.cancel();
    expect(session.status).toEqual({ type: 'ended', reason: 'cancelled' });
    expect(log.filter((l) => l.startsWith('end:'))).toHaveLength(1);
  });

  it('a failed dictation ends as error', () => {
    const { session, fake, log } = listen();
    fake.set({ status: 'error', error: 'Permission denied' });
    expect(session.status).toEqual({ type: 'ended', reason: 'error' });
    expect(log).toEqual(['end:']);
  });
});

describe('SegmentTexts', () => {
  it('shows finals plus the open segment, and keeps finals in segment order', () => {
    const t = new SegmentTexts();
    t.start('a');
    t.partial('a', 'one');
    t.start('b');
    t.partial('b', 'two');
    expect(t.visible).toBe('one two');
    t.final('b', 'Two.');
    expect(t.finals).toBe('Two.');
    t.final('a', 'One.');
    expect(t.finals).toBe('One. Two.');
    t.partial('a', 'ignored after final');
    expect(t.visible).toBe('One. Two.');
  });
});

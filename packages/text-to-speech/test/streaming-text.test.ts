import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/document';
import { planReading, type SplitMode } from '../src/pieces';
import { StreamingTextPlanner } from '../src/streaming-text';

/** Replies shaped like LLM output: every markdown construct the planner has to be careful with. */
const SAMPLES: Record<string, string> = {
  prose:
    'Sure! Here is a short answer. The capital of France is Paris, which has about 2.1 million people.\n\n' +
    'Dr. Smith said the U.S. economy grew 3.5% in 2024, i.e. faster than expected. Is that right? Yes... mostly.',
  headingsAndLists:
    '# Plan for the week\n\nHere are the steps:\n\n1. Draft the outline. Keep it short.\n2. Review it with the team\n' +
    '3. Ship it!\n\n## Notes\n\n- Use **bold** for emphasis and `code` for names.\n- Link to [the docs](https://example.com/docs) when useful.\n' +
    '  - Nested points count too.\n\nThat is all for now.',
  codeFence:
    'Run this command first:\n\n```bash\nnpm install\nnpm run build\n```\n\nThen open the page. It should load in a second.\n\n' +
    '~~~\nplain fenced text\n~~~\nDone.',
  table:
    'Compare the options:\n\n| Option | Cost | Speed |\n| --- | --- | --- |\n| A | $5 | fast |\n| B | $9 | slow |\n\n' +
    'Option A wins. Pick it unless you need B.',
  quoteAndBreaks:
    '> A quoted line. Another sentence in the quote.\n\nPlain text after the quote.\nA new line without a blank.\n\n' +
    '***\n\nFinal words: thanks, and goodbye!',
  longSentence: `${'This sentence keeps going with more and more words, clauses and commas, '.repeat(12)}until it finally ends. Short one.`,
};

function oneShot(text: string, split: SplitMode): string[] {
  return planReading(parseDocument(text, 'markdown').blocks, { split })
    .pieces.map((p) => p.text)
    .filter((t) => t.trim().length > 0);
}

function streamed(chunks: string[], split: SplitMode): { texts: string[]; batches: number } {
  const texts: string[] = [];
  let batches = 0;
  const planner = new StreamingTextPlanner({
    split,
    onPieces: (pieces) => {
      batches++;
      texts.push(...pieces.map((p) => p.text));
    },
  });
  for (const chunk of chunks) planner.push(chunk);
  planner.end();
  return { texts, batches };
}

function seededChunks(text: string, seed: number): string[] {
  const chunks: string[] = [];
  let state = seed;
  for (let i = 0; i < text.length; ) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const size = 1 + (state % 12);
    chunks.push(text.slice(i, i + size));
    i += size;
  }
  return chunks;
}

describe('StreamingTextPlanner', () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    for (const split of ['sentence', 'clause'] as const) {
      it(`${name} (${split}): streamed pieces equal the one-shot plan`, () => {
        const expected = oneShot(text, split);
        expect(expected.length).toBeGreaterThan(0);
        expect(streamed([...text], split).texts).toEqual(expected); // one character at a time
        expect(streamed(text.split(/(?<=\s)/), split).texts).toEqual(expected); // word by word
        for (const seed of [1, 7, 42]) expect(streamed(seededChunks(text, seed), split).texts).toEqual(expected);
        expect(streamed([text], split).texts).toEqual(expected); // all at once
      });
    }
  }

  it('speaks while the text is still arriving, not only at the end', () => {
    const { batches } = streamed([...SAMPLES.headingsAndLists], 'sentence');
    expect(batches).toBeGreaterThan(5);
  });

  it('commits a sentence only once the next one has started', () => {
    const got: string[] = [];
    const planner = new StreamingTextPlanner({ onPieces: (pieces) => got.push(...pieces.map((p) => p.text)) });
    planner.push('Hello wor');
    planner.push('ld. ');
    expect(got).toEqual([]);
    planner.push('Next');
    expect(got).toEqual(['Hello world.']);
    planner.push(' sentence here');
    expect(got).toEqual(['Hello world.']);
    planner.end();
    expect(got).toEqual(['Hello world.', 'Next sentence here.']);
  });

  it('closes a paragraph at a blank line', () => {
    const got: string[] = [];
    const planner = new StreamingTextPlanner({ onPieces: (pieces) => got.push(...pieces.map((p) => p.text)) });
    planner.push('A heading-free paragraph without a full stop\n\n');
    expect(got).toEqual(['A heading-free paragraph without a full stop.']);
  });

  it('holds everything inside an unclosed code fence', () => {
    const got: string[] = [];
    const planner = new StreamingTextPlanner({ onPieces: (pieces) => got.push(...pieces.map((p) => p.text)) });
    planner.push('Intro sentence. Second one.\n\n```js\nconst a = 1. And more.\n\n');
    const beforeClose = [...got];
    planner.push('```\n\nAfter the code.\n\n');
    planner.end();
    expect(beforeClose).toEqual(['Intro sentence.', 'Second one.']);
    expect(got).toEqual(oneShot('Intro sentence. Second one.\n\n```js\nconst a = 1. And more.\n\n```\n\nAfter the code.\n\n', 'sentence'));
  });

  it('holds possible front matter until it closes', () => {
    const got: string[] = [];
    const planner = new StreamingTextPlanner({ onPieces: (pieces) => got.push(...pieces.map((p) => p.text)) });
    planner.push('---\ntitle: x. y z\n');
    expect(got).toEqual([]);
    planner.push('---\nBody text. More.');
    planner.end();
    expect(got).toEqual(oneShot('---\ntitle: x. y z\n---\nBody text. More.', 'sentence'));
  });

  it('rejects pushes after end() (the playback layer drops them first)', () => {
    const planner = new StreamingTextPlanner({ onPieces: () => undefined });
    planner.end();
    expect(() => planner.push('more')).toThrow();
  });
});

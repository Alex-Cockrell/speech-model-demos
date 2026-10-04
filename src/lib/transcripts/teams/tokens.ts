/**
 * Words as the alignment compares them. OWNER: meeting agent.
 *
 * The same normalization as the word error rate (lowercase, apostrophes dropped, other punctuation a word
 * break), so "Okay," and "okay" are one word and "it's" is "its". A written word can yield several tokens
 * ("2,000" → "2" "000") or none ("—"). Tokens are interned to integers so the alignment compares numbers.
 */
import { normalizeText, toWords } from '../../accuracy/wer';

export function tokenize(raw: string): string[] {
  return toWords(normalizeText(raw));
}

export class Vocab {
  private readonly ids = new Map<string, number>();
  readonly words: string[] = [];

  id(token: string): number {
    let id = this.ids.get(token);
    if (id === undefined) {
      id = this.words.length;
      this.ids.set(token, id);
      this.words.push(token);
    }
    return id;
  }

  get size(): number {
    return this.words.length;
  }
}

/** Non-decreasing copy (times that step back slightly, e.g. overlapping words of two sources, are lifted). */
export function runningMax(values: ArrayLike<number>): Float64Array {
  const out = new Float64Array(values.length);
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    max = Math.max(max, values[i]);
    out[i] = max;
  }
  return out;
}

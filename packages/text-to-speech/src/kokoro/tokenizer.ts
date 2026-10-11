/**
 * Kokoro's phoneme tokenizer, built from the model's tokenizer.json. It reproduces what transformers.js's
 * AutoTokenizer does with that file (as kokoro-js used it): drop every character outside the vocabulary (the
 * Replace normalizer), map each code point to its id, wrap the sequence in the pad token `$` (the template
 * post-processor) and truncate to the model's maximum length (KOKORO_MAX_TOKENS, tokenizer_config.json's
 * model_max_length).
 */
import { KOKORO_MAX_TOKENS } from '../pieces.js';

interface TokenizerJson {
  normalizer?: { type?: string; pattern?: { Regex?: string }; content?: string } | null;
  model?: { vocab?: Record<string, number> };
}

export class KokoroTokenizer {
  readonly modelMaxLength = KOKORO_MAX_TOKENS;
  private readonly vocab: Map<string, number>;
  private readonly strip: RegExp | null;
  private readonly padId: number;

  constructor(json: TokenizerJson) {
    const vocab = json.model?.vocab;
    if (!vocab || typeof vocab !== 'object') throw new Error('The voice model tokenizer has no vocabulary.');
    this.vocab = new Map(Object.entries(vocab));
    const pad = this.vocab.get('$');
    if (pad === undefined) throw new Error('The voice model tokenizer has no pad token.');
    this.padId = pad;
    const normalizer = json.normalizer;
    this.strip =
      normalizer?.type === 'Replace' && normalizer.pattern?.Regex !== undefined && normalizer.content === ''
        ? new RegExp(normalizer.pattern.Regex, 'gu')
        : null;
  }

  /** Token ids for a phoneme string; with `truncation` the result is cut to modelMaxLength (dropping the end). */
  encode(phonemes: string, truncation = true): number[] {
    const text = this.strip ? phonemes.replace(this.strip, '') : phonemes;
    const ids = [this.padId];
    for (const ch of text) ids.push(this.vocab.get(ch) ?? this.padId);
    ids.push(this.padId);
    if (truncation && ids.length > this.modelMaxLength) ids.length = this.modelMaxLength;
    return ids;
  }
}

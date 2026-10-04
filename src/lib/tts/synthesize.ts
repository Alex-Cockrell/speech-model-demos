/**
 * Worker-side (imports kokoro-js): synthesise one read-aloud piece as one utterance, without ever letting Kokoro
 * truncate it. Kept out of tts.worker.ts so it can be tested against the real model outside a worker.
 */
import type { GenerateOptions, KokoroTTS } from 'kokoro-js';
import { KOKORO_MAX_TOKENS, splitInHalf } from './pieces';
import { singlePieceSplitter } from './split';

type KokoroVoice = NonNullable<GenerateOptions['voice']>;

/** Kokoro's output rate; only used for empty results. */
export const KOKORO_SAMPLE_RATE = 24_000;
/** Overflow splits per piece before a part is synthesized truncated (2^4 parts is far beyond any real piece). */
const MAX_SPLIT_DEPTH = 4;

export interface PieceSynthesis {
  /** Mono PCM of the whole piece. */
  audio: Float32Array;
  sampleRate: number;
  inferences: number;
  /** Largest token count passed to the model (including the two `$`). */
  maxTokens: number;
  /** Splits made because the text exceeded the token window. */
  overflowSplits: number;
  /** A part could not be split and was synthesized truncated. */
  truncated: boolean;
}

/** Thrown before inference when a piece fills Kokoro's whole token window, i.e. the tokenizer truncated it. */
class TokenOverflow extends Error {
  constructor(readonly tokens: number) {
    super(`The piece needs at least ${tokens} phoneme tokens.`);
  }
}

export function tokenLimit(model: KokoroTTS): number {
  const max = Number(model.tokenizer.model_max_length);
  return Number.isFinite(max) && max > 2 ? max : KOKORO_MAX_TOKENS;
}

/**
 * The model with generate_from_ids wrapped: stream() calls it with the token ids after phonemizing and
 * tokenizing with truncation at model_max_length. A sequence that reaches the limit was cut off, so the wrapper
 * throws before running the model instead of producing audio that silently drops the end of the piece.
 * Object.create keeps the shared instance untouched (the benchmark's speak() uses it unwrapped).
 */
function guardedModel(model: KokoroTTS, stats: PieceSynthesis, allowTruncation: boolean): KokoroTTS {
  const limit = tokenLimit(model);
  const guarded = Object.create(model) as KokoroTTS;
  guarded.generate_from_ids = (ids, options) => {
    const tokens = ids.dims.at(-1) ?? 0;
    if (tokens >= limit) {
      if (!allowTruncation) throw new TokenOverflow(tokens);
      stats.truncated = true;
    }
    stats.maxTokens = Math.max(stats.maxTokens, tokens);
    return model.generate_from_ids(ids, options);
  };
  return guarded;
}

async function synthesizeText(
  model: KokoroTTS,
  text: string,
  options: { voice: string; speed: number },
  parts: Float32Array[],
  stats: PieceSynthesis,
  depth: number,
): Promise<void> {
  const runner = guardedModel(model, stats, depth >= MAX_SPLIT_DEPTH);
  try {
    for await (const { audio } of runner.stream(singlePieceSplitter(text), { voice: options.voice as KokoroVoice, speed: options.speed })) {
      stats.inferences++;
      stats.sampleRate = audio.sampling_rate;
      parts.push(audio.audio);
    }
  } catch (e) {
    if (!(e instanceof TokenOverflow)) throw e;
    const halves = splitInHalf(text);
    if (!halves) {
      await synthesizeText(model, text, options, parts, stats, MAX_SPLIT_DEPTH);
      return;
    }
    stats.overflowSplits++;
    for (const half of halves) await synthesizeText(model, half, options, parts, stats, depth + 1);
  }
}

/**
 * One piece → one utterance (kokoro-js's sentence splitter is bypassed: the caller planned the pieces). A piece
 * that would exceed the token window is split in two at the best boundary near the middle, recursively, and the
 * audio of the parts is joined.
 */
export async function synthesizePiece(model: KokoroTTS, text: string, options: { voice: string; speed: number }): Promise<PieceSynthesis> {
  const stats: PieceSynthesis = {
    audio: new Float32Array(0),
    sampleRate: KOKORO_SAMPLE_RATE,
    inferences: 0,
    maxTokens: 0,
    overflowSplits: 0,
    truncated: false,
  };
  const parts: Float32Array[] = [];
  await synthesizeText(model, text, options, parts, stats, 0);
  stats.audio = joinSamples(parts);
  return stats;
}

function joinSamples(parts: Float32Array[]): Float32Array {
  if (parts.length === 1) return parts[0];
  const joined = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

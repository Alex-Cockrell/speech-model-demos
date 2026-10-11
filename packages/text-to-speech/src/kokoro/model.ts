/**
 * Kokoro 82M on ONNX Runtime Web: phonemize → tokenize → pick the voice's style vector → one session run.
 * Replaces kokoro-js (and the @huggingface/transformers runtime under it); the inputs it builds are the ones
 * kokoro-js built (phonemize.ts, tokenizer.ts and the style selection below are ports of it).
 */
import type * as Ort from 'onnxruntime-web';
import { phonemize, type KokoroLanguage } from './phonemize.js';
import type { TextSplitterStream } from './splitter.js';
import type { KokoroTokenizer } from './tokenizer.js';

export const KOKORO_SAMPLE_RATE = 24_000;
/** Each voice file holds one 256-value style vector per input length 1…510 (float32, [510, 1, 256]). */
const STYLE_SIZE = 256;
const STYLE_ROWS = 510;

/** Voice ids kokoro-js 1.2.1 accepted (its voice table); the first letter is the language, the second the gender. */
export const KOKORO_VOICE_IDS: readonly string[] = [
  'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah',
  'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
  'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis', 'bf_alice', 'bf_lily', 'bm_daniel', 'bm_fable',
];

export interface KokoroAudio {
  /** Mono PCM. */
  audio: Float32Array;
  sampling_rate: number;
}

export interface KokoroOptions {
  voice: string;
  speed: number;
}

/** Returns a voice's style table (STYLE_ROWS × STYLE_SIZE float32 values). */
export type VoiceLoader = (voice: string) => Promise<Float32Array>;

export class KokoroModel {
  private readonly voices = new Map<string, Promise<Float32Array>>();

  constructor(
    private readonly ort: typeof Ort,
    private readonly session: Ort.InferenceSession,
    readonly tokenizer: KokoroTokenizer,
    private readonly loadVoice: VoiceLoader,
  ) {}

  /** One utterance: the whole text in one inference (truncated at the token limit). */
  async generate(text: string, options: KokoroOptions): Promise<KokoroAudio> {
    const phonemes = await phonemize(text, languageOf(options.voice));
    return this.generateFromIds(this.tokenizer.encode(phonemes), options);
  }

  async generateFromIds(ids: readonly number[], { voice, speed }: KokoroOptions): Promise<KokoroAudio> {
    const table = await this.voiceTable(voice);
    const row = Math.min(Math.max(ids.length - 2, 0), STYLE_ROWS - 1);
    const { Tensor } = this.ort;
    const outputs = await this.session.run({
      input_ids: new Tensor('int64', BigInt64Array.from(ids, (id) => BigInt(id)), [1, ids.length]),
      style: new Tensor('float32', table.slice(row * STYLE_SIZE, (row + 1) * STYLE_SIZE), [1, STYLE_SIZE]),
      speed: new Tensor('float32', new Float32Array([speed]), [1]),
    });
    const waveform = outputs.waveform;
    if (!waveform) throw new Error('The voice model returned no waveform.');
    const audio = new Float32Array(waveform.data as Float32Array);
    waveform.dispose();
    return { audio, sampling_rate: KOKORO_SAMPLE_RATE };
  }

  /** One inference per sentence the splitter yields, in order. */
  async *stream(splitter: TextSplitterStream, options: KokoroOptions): AsyncGenerator<{ text: string; phonemes: string; audio: KokoroAudio }> {
    const language = languageOf(options.voice);
    for await (const text of splitter) {
      const phonemes = await phonemize(text, language);
      const audio = await this.generateFromIds(this.tokenizer.encode(phonemes), options);
      yield { text, phonemes, audio };
    }
  }

  private voiceTable(voice: string): Promise<Float32Array> {
    let table = this.voices.get(voice);
    if (!table) {
      table = this.loadVoice(voice).then((data) => {
        if (data.length < STYLE_ROWS * STYLE_SIZE) throw new Error(`The voice file for "${voice}" is incomplete.`);
        return data;
      });
      // A failed load (e.g. offline) may succeed later.
      table.catch(() => this.voices.delete(voice));
      this.voices.set(voice, table);
    }
    return table;
  }
}

export function languageOf(voice: string): KokoroLanguage {
  if (!KOKORO_VOICE_IDS.includes(voice)) {
    throw new Error(`Voice "${voice}" not found. Should be one of: ${KOKORO_VOICE_IDS.join(', ')}.`);
  }
  return voice[0] === 'b' ? 'b' : 'a';
}

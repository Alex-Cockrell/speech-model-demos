/**
 * English text → Kokoro phonemes. A faithful port of kokoro-js 1.2.1's phonemize() (Apache-2.0,
 * https://github.com/hexgrad/kokoro/tree/main/kokoro.js), kept rule for rule so the model receives exactly the
 * input it did through kokoro-js. That includes its quirks, e.g. the double-space rule only replaces the first
 * run of spaces. eSpeak NG (via the `phonemizer` package) does the actual grapheme-to-phoneme conversion.
 */
import { phonemize as espeak } from 'phonemizer';

/** 'a' = American English voices (af_*, am_*), 'b' = British English voices (bf_*, bm_*). */
export type KokoroLanguage = 'a' | 'b';

/** Spoken form of a year, a time of day or a decimal (the decimal is left for pointNumber). */
function splitNumber(match: string): string {
  if (match.includes('.')) return match;
  if (match.includes(':')) {
    const [hours, minutes] = match.split(':').map(Number);
    if (minutes === 0) return `${hours} o'clock`;
    if (minutes < 10) return `${hours} oh ${minutes}`;
    return `${hours} ${minutes}`;
  }
  const year = parseInt(match.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return match;
  const left = match.slice(0, 2);
  const right = parseInt(match.slice(2, 4), 10);
  const suffix = match.endsWith('s') ? 's' : '';
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${suffix}`;
    if (right < 10) return `${left} oh ${right}${suffix}`;
  }
  return `${left} ${right}${suffix}`;
}

function flipMoney(match: string): string {
  const bill = match[0] === '$' ? 'dollar' : 'pound';
  if (isNaN(Number(match.slice(1)))) return `${match.slice(1)} ${bill}s`;
  if (!match.includes('.')) {
    const suffix = match.slice(1) === '1' ? '' : 's';
    return `${match.slice(1)} ${bill}${suffix}`;
  }
  const [whole, fraction] = match.slice(1).split('.');
  const cents = parseInt(fraction.padEnd(2, '0'), 10);
  const coins = match[0] === '$' ? (cents === 1 ? 'cent' : 'cents') : cents === 1 ? 'penny' : 'pence';
  return `${whole} ${bill}${whole === '1' ? '' : 's'} and ${cents} ${coins}`;
}

function pointNumber(match: string): string {
  const [whole, fraction] = match.split('.');
  return `${whole} point ${fraction.split('').join(' ')}`;
}

function normalizeText(text: string): string {
  return (
    text
      // 1. Quotes and brackets
      .replace(/[‘’]/g, "'")
      .replace(/«/g, '“')
      .replace(/»/g, '”')
      .replace(/[“”]/g, '"')
      .replace(/\(/g, '«')
      .replace(/\)/g, '»')
      // 2. CJK punctuation
      .replace(/、/g, ', ')
      .replace(/。/g, '. ')
      .replace(/！/g, '! ')
      .replace(/，/g, ', ')
      .replace(/：/g, ': ')
      .replace(/；/g, '; ')
      .replace(/？/g, '? ')
      // 3. Whitespace (kokoro-js replaces only the first run of spaces; kept as is)
      .replace(/[^\S \n]/g, ' ')
      .replace(/  +/, ' ')
      .replace(/(?<=\n) +(?=\n)/g, '')
      // 4. Abbreviations
      .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
      .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
      .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
      .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
      .replace(/\betc\.(?! [A-Z])/gi, 'etc')
      // 5. Casual words
      .replace(/\b(y)eah?\b/gi, "$1e'a")
      // 6. Numbers and money
      .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNumber)
      .replace(/(?<=\d),(?=\d)/g, '')
      .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, flipMoney)
      .replace(/\d*\.\d+/g, pointNumber)
      .replace(/(?<=\d)-(?=\d)/g, ' to ')
      .replace(/(?<=\d)S/g, ' S')
      // 7. Possessives
      .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
      .replace(/(?<=X')S\b/g, 's')
      // 8. Dotted acronyms
      .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
      .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
      .trim()
  );
}

/** Runs of punctuation (with surrounding whitespace) that are passed through rather than phonemized. */
const PUNCTUATION_RUN = /(\s*[;:,.!?¡¿—…"«»“”(){}[\]]+\s*)+/g;

function splitKeepingPunctuation(text: string): Array<{ match: boolean; text: string }> {
  const parts: Array<{ match: boolean; text: string }> = [];
  let last = 0;
  for (const m of text.matchAll(PUNCTUATION_RUN)) {
    const run = m[0];
    const index = m.index ?? 0;
    if (last < index) parts.push({ match: false, text: text.slice(last, index) });
    if (run.length > 0) parts.push({ match: true, text: run });
    last = index + run.length;
  }
  if (last < text.length) parts.push({ match: false, text: text.slice(last) });
  return parts;
}

export async function phonemize(text: string, language: KokoroLanguage = 'a', norm = true): Promise<string> {
  if (norm) text = normalizeText(text);
  const espeakLanguage = language === 'a' ? 'en-us' : 'en';
  const parts = await Promise.all(
    splitKeepingPunctuation(text).map(async ({ match, text: part }) => (match ? part : (await espeak(part, espeakLanguage)).join(' '))),
  );
  let phonemes = parts
    .join('')
    // Post-processing: Kokoro's own pronunciation, then characters outside its vocabulary.
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  if (language === 'a') phonemes = phonemes.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return phonemes.trim();
}

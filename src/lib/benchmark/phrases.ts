import type { BenchmarkPhrase } from '../types';

/**
 * Reading material for benchmark mode. No digits anywhere: ASR number formatting ("seven" vs "7")
 * would show up as substitutions and distort WER.
 */
export const BENCHMARK_PHRASES: readonly BenchmarkPhrase[] = [
  {
    id: 'pangram',
    title: 'Pangram',
    text: 'The quick brown fox jumps over the lazy dog.',
  },
  {
    id: 'harvard-list-1',
    title: 'Harvard sentences, list 1 (first five)',
    // Several sentences so Kokoro's sentence-level streaming produces several chunks.
    text:
      'The birch canoe slid on the smooth planks. Glue the sheet to the dark blue background. ' +
      "It's easy to tell the depth of a well. These days a chicken leg is a rare dish. " +
      'Rice is often served in round bowls.',
  },
  {
    id: 'gettysburg-opening',
    title: 'Gettysburg Address, opening (long)',
    // Public domain (1863); "battlefield" uses the modern spelling the ASR model produces.
    text:
      'Four score and seven years ago our fathers brought forth on this continent a new nation, ' +
      'conceived in liberty, and dedicated to the proposition that all men are created equal. ' +
      'Now we are engaged in a great civil war, testing whether that nation, or any nation so conceived ' +
      'and so dedicated, can long endure. We are met on a great battlefield of that war. ' +
      'We have come to dedicate a portion of that field as a final resting place for those who here gave ' +
      'their lives that that nation might live. It is altogether fitting and proper that we should do this.',
  },
];

export const DEFAULT_PHRASE_ID = BENCHMARK_PHRASES[0].id;

export function findPhrase(id: string): BenchmarkPhrase {
  return BENCHMARK_PHRASES.find((p) => p.id === id) ?? BENCHMARK_PHRASES[0];
}

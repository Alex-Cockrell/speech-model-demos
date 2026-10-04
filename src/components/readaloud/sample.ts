/** Sample documents for trying read aloud: a short one with every construct, a long one for flow control. */

export const SHORT_SAMPLE = `# Read aloud: how it works

This page reads a document or a generated response aloud with a small **text-to-speech model** that runs entirely in this browser. Nothing is uploaded: the text, the audio and the timings stay on this machine.

## What happens when you press Play

1. The text is cleaned up for listening: Markdown symbols are removed, links are read as their text, and code blocks are announced instead of read.
2. It is split into sentences, and long sentences into clauses, so that every piece stays well inside the model's limit of 510 phoneme tokens.
3. Pieces are generated one at a time, about 30 seconds ahead of what you hear, so even a 30-minute document starts within seconds and never fills memory.

## Things worth listening for

- Numbers and units, e.g. 1,234 files, 12.5% faster, 350–470 ms, or 1.5 GB.
- Abbreviations such as Dr. Smith, Mr. Jones, i.e. and vs. — none of them should end a sentence early.
- A link like [the release notes](https://example.com/releases/2026-10) or a bare URL like https://docs.example.org/speech/read-aloud is read as its name or host.

| Backend | First audio | Generation speed |
| --- | --- | --- |
| WebGPU | 350–470 ms | 0.11× real time |
| WASM | 1.3 s | 0.45× real time |

\`\`\`ts
const reader = new ReadAloudSession({ ctx, backend, pieces, voice, speed });
reader.start();
\`\`\`

If generation is slower than playback on this machine, the reader says so and counts every pause, so the numbers next to this text tell you whether this laptop can read aloud comfortably.
`;

const PARAGRAPHS = [
  'Browser-local speech synthesis changes what a web application can promise about privacy. When the model runs on the user’s own machine, the text that is read aloud never travels to a server, and neither does the audio. The cost moves to the device instead: the model has to be downloaded once, initialized on every visit, and fast enough to keep ahead of the listener.',
  'Keeping ahead is the hard part. A listener hears about fourteen characters per second, so a model that generates audio at half of real time has plenty of headroom, while a model that needs one and a half seconds for every second of speech will fall behind, and every sentence will be followed by a pause while the next one is generated.',
  'That is why this reader generates only about thirty seconds ahead of the playhead. On a fast machine the buffer fills within a few seconds and generation idles until it is needed again. On a slow machine the buffer never fills, generation runs continuously, and the pauses are measured and shown rather than hidden.',
  'Pausing stops both the audio and the read-ahead. Seeking to another sentence drops the audio that was scheduled, keeps whatever was already generated in a compact archive, and starts the new position as soon as its first piece is ready. Going back to a sentence that was already read plays it again at once.',
  'Long sentences are split at commas, semicolons and dashes so that no piece exceeds the model’s window of five hundred and twelve tokens, and so that the first audio arrives quickly. Numbers expand a lot when they are spoken: a figure such as 1,234,567 becomes one million, two hundred thirty-four thousand, five hundred sixty-seven.',
  'Voice and speed can be changed while reading. The sentence being spoken finishes in the old voice, and everything after it is generated again with the new one. If the machine is quick enough, the change is seamless; if not, the pause that follows is counted like any other.',
];

/** About 25,000 characters: roughly 30 minutes at normal speed, for testing bounded read-ahead and seeking. */
export function longSample(): string {
  const parts: string[] = ['# A long document', '', 'This document repeats a few paragraphs to make about thirty minutes of speech.'];
  for (let part = 1; part <= 28; part++) {
    parts.push('', `## Part ${part}`, '', PARAGRAPHS[(part * 2) % PARAGRAPHS.length], '', PARAGRAPHS[(part * 2 + 1) % PARAGRAPHS.length]);
  }
  return parts.join('\n');
}

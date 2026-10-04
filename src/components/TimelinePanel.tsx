'use client';

import type { TtsChunkRecord } from '@/lib/types';
import type { RunState } from './pipeline/state';
import { fmtMs } from './format';
import { Chip, Panel, cx } from './ui';
import styles from './Timeline.module.css';
import ui from './ui.module.css';

// ---------------------------------------------------------------------------
// ASR: one row per visible partial-transcript change (spec §9)
// ---------------------------------------------------------------------------

interface AsrRow {
  at: number;
  kind: 'event' | 'partial' | 'final';
  text: string;
  /** Time since the previous partial update. */
  delta: number | null;
}

function asrTimeline(run: RunState): { rows: AsrRow[]; origin: number; originLabel: string } {
  const m = run.asr;
  const partials = m?.partials ?? run.partials;
  const speechStart = m ? m.speechStart : run.speechStartAt;
  const micStart = m?.micStart ?? run.clickedAt;
  const rows: AsrRow[] = [{ at: micStart, kind: 'event', text: 'Record pressed', delta: null }];
  if (m?.firstAudioSubmitted != null) rows.push({ at: m.firstAudioSubmitted, kind: 'event', text: 'first audio chunk to the transcription model', delta: null });
  if (speechStart != null) rows.push({ at: speechStart, kind: 'event', text: 'speech detected', delta: null });
  partials.forEach((p, i) => rows.push({ at: p.at, kind: 'partial', text: p.text, delta: i > 0 ? p.at - partials[i - 1].at : null }));
  if (m) {
    rows.push({ at: m.recordingStop, kind: 'event', text: 'Stop pressed', delta: null });
    rows.push({ at: m.finalTranscriptAt, kind: 'final', text: m.finalText, delta: null });
  }
  rows.sort((a, b) => a.at - b.at); // stable: ties keep the order above
  return { rows, origin: speechStart ?? micStart, originLabel: speechStart != null ? 'speech start' : 'Record' };
}

export function AsrTimelinePanel({ run, className }: { run: RunState | null; className?: string }) {
  const timeline = run ? asrTimeline(run) : null;
  return (
    <Panel title="ASR partial timeline" subtitle={timeline ? `time since ${timeline.originLabel}` : undefined} className={className}>
      {!timeline ? (
        <p className="muted">Every change of the visible partial transcript, timed from speech start.</p>
      ) : (
        <div className={styles.scroll}>
          <table className={cx(ui.table, styles.asrTable)}>
            <thead>
              <tr>
                <th className={ui.numCell}>Time</th>
                <th className={ui.numCell}>Δ</th>
                <th>Transcript</th>
              </tr>
            </thead>
            <tbody>
              {timeline.rows.map((r, i) => (
                <tr key={i} className={r.kind === 'event' ? styles.eventRow : r.kind === 'final' ? styles.finalRow : undefined}>
                  <td className={ui.numCell}>{fmtMs(r.at - timeline.origin)}</td>
                  <td className={ui.numCell}>{r.delta == null ? '' : `+${fmtMs(r.delta)}`}</td>
                  <td>
                    {r.kind === 'partial' ? (
                      `“${r.text}”`
                    ) : r.kind === 'final' ? (
                      <>
                        final transcript: “{r.text}”
                      </>
                    ) : (
                      r.text
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// TTS: chunk generation vs scheduled playback (spec §10)
// ---------------------------------------------------------------------------

const TICK_STEPS_MS = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10_000, 15_000, 20_000, 30_000, 60_000];
/** Few enough that the labels never collide on a phone-width chart. */
const MAX_TICKS = 6;

function ticks(endMs: number): number[] {
  const step = TICK_STEPS_MS.find((s) => endMs / s <= MAX_TICKS) ?? 60_000 * Math.ceil(endMs / (60_000 * MAX_TICKS));
  const out: number[] = [];
  for (let t = 0; t <= endMs; t += step) out.push(t);
  return out;
}

function tickLabel(ms: number): string {
  return ms === 0 ? '0' : `${Number((ms / 1000).toFixed(2))} s`;
}

export function TtsTimelinePanel({ run, className }: { run: RunState | null; className?: string }) {
  const tts = run?.tts ?? null;
  const t0 = tts?.ttsStart ?? run?.speakCalledAt ?? null;
  const chunks = tts?.chunks ?? run?.chunks ?? [];
  const playbackStart = tts?.firstPlaybackStartAt ?? run?.playbackStartAt ?? null;
  return (
    <Panel title="TTS chunk timeline" subtitle={t0 != null ? 'time since TTS start' : undefined} className={className}>
      {t0 == null || chunks.length === 0 ? (
        <p className="muted">Each speech chunk: when it was generated, when it was scheduled to play, and how much audio was buffered ahead.</p>
      ) : (
        <>
          <div className={styles.summary}>
            <span>
              TTS requested <strong>0 ms</strong>
            </span>
            <span>
              first audio <strong>{fmtMs(chunks[0].generatedAt - t0)}</strong>
            </span>
            {playbackStart != null && (
              <span>
                playback begins <strong>{fmtMs(playbackStart - t0)}</strong>
              </span>
            )}
            {tts?.generationCompleteAt != null && (
              <span>
                generation complete <strong>{fmtMs(tts.generationCompleteAt - t0)}</strong>
              </span>
            )}
            {tts?.playbackCompleteAt != null && (
              <span>
                playback complete <strong>{fmtMs(tts.playbackCompleteAt - t0)}</strong>
              </span>
            )}
          </div>
          <ChunkChart t0={t0} chunks={chunks} endAt={tts?.playbackCompleteAt ?? null} />
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.numCell}>#</th>
                  <th className={ui.numCell}>Generated</th>
                  <th className={ui.numCell}>Gen time</th>
                  <th className={ui.numCell}>Audio</th>
                  <th className={ui.numCell}>Plays at</th>
                  <th className={ui.numCell}>Buffered ahead</th>
                  <th>Underrun</th>
                  <th>Text</th>
                </tr>
              </thead>
              <tbody>
                {chunks.map((c) => (
                  <tr key={c.index} className={c.underrun ? styles.underrunRow : undefined}>
                    <td className={ui.numCell}>{c.index + 1}</td>
                    <td className={ui.numCell}>{fmtMs(c.generatedAt - t0)}</td>
                    <td className={ui.numCell}>{fmtMs(c.generationMs)}</td>
                    <td className={ui.numCell}>{fmtMs(c.audioDurationMs)}</td>
                    <td className={ui.numCell}>{fmtMs(c.scheduledPlaybackAt - t0)}</td>
                    <td className={ui.numCell}>{fmtMs(c.bufferedAheadMs)}</td>
                    <td>{c.underrun ? <Chip tone="warn">gap {fmtMs(c.gapMs)}</Chip> : <span className="muted">no</span>}</td>
                    <td className={styles.chunkText}>{c.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}

/** Gantt of generation (series 1) against scheduled playback (series 2); the table above is its accessible twin. */
function ChunkChart({ t0, chunks, endAt }: { t0: number; chunks: TtsChunkRecord[]; endAt: number | null }) {
  const end = Math.max(
    1,
    endAt != null ? endAt - t0 : 0,
    ...chunks.map((c) => c.scheduledPlaybackAt + c.audioDurationMs - t0),
    ...chunks.map((c) => c.generatedAt - t0),
  );
  const pct = (ms: number) => `${(Math.min(Math.max(ms, 0), end) / end) * 100}%`;
  const tickValues = ticks(end);
  const underruns = chunks.filter((c) => c.underrun).length;
  return (
    <figure className={styles.chart}>
      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <i className={cx(styles.swatch, styles.genBar)} aria-hidden="true" /> generation
        </span>
        <span className={styles.legendItem}>
          <i className={cx(styles.swatch, styles.playBar)} aria-hidden="true" /> scheduled playback
        </span>
        <span className={styles.legendItem}>
          <i className={cx(styles.swatch, styles.gapBar)} aria-hidden="true" /> underrun gap
        </span>
      </div>
      <div
        className={styles.plot}
        role="img"
        aria-label={`${chunks.length} chunks over ${fmtMs(end)}, ${underruns} underrun${underruns === 1 ? '' : 's'}. The table lists every value.`}
      >
        <div className={styles.gridLines} aria-hidden="true">
          {tickValues.map((t) => (
            <span key={t} className={styles.gridLine} style={{ left: pct(t) }} />
          ))}
        </div>
        {chunks.map((c) => (
          <div key={c.index} className={styles.row}>
            <span className={styles.rowLabel}>{c.index + 1}</span>
            <div className={styles.track}>
              <span
                className={cx(styles.bar, styles.genBar)}
                style={{ left: pct(c.generationStart - t0), width: pct(c.generatedAt - c.generationStart) }}
                title={`Chunk ${c.index + 1} generated in ${fmtMs(c.generationMs)}, ready at ${fmtMs(c.generatedAt - t0)}`}
              />
              {c.gapMs > 0 && (
                <span
                  className={cx(styles.bar, styles.gapBar)}
                  style={{ left: pct(c.scheduledPlaybackAt - c.gapMs - t0), width: pct(c.gapMs) }}
                  title={`Underrun: ${fmtMs(c.gapMs)} of silence before chunk ${c.index + 1}`}
                />
              )}
              <span
                className={cx(styles.bar, styles.playBar)}
                style={{ left: pct(c.scheduledPlaybackAt - t0), width: pct(c.audioDurationMs) }}
                title={`Chunk ${c.index + 1} plays ${fmtMs(c.scheduledPlaybackAt - t0)} → ${fmtMs(c.scheduledPlaybackAt + c.audioDurationMs - t0)}, ${fmtMs(c.bufferedAheadMs)} buffered ahead`}
              />
            </div>
          </div>
        ))}
        <div className={styles.axis} aria-hidden="true">
          <span />
          <div className={styles.axisTrack}>
            {tickValues.map((t) => (
              <span key={t} className={styles.tick} style={{ left: pct(t) }}>
                {tickLabel(t)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </figure>
  );
}

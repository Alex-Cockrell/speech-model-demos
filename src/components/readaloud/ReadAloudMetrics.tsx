'use client';

import type { ReaderPosition, ReaderSnapshot } from '@localspeech/text-to-speech';
import type { ModelLoadRecord } from '@/lib/types';
import { BACKEND_LABEL, DASH, fmtBytes, fmtMs, fmtRtf } from '../format';
import { APP_INFO } from '@/lib/config';
import { CopyButton, Kv, KvList, Meter, Notice, Panel } from '../ui';
import styles from './ReadAloud.module.css';

interface Props {
  snapshot: ReaderSnapshot | null;
  position: ReaderPosition | null;
  totalPieces: number;
  /** How the loaded voice model instance runs (backend, dtype, threads). */
  record: ModelLoadRecord | null;
  /** The Play click that started this session, and the model load it waited for (null when already loaded). */
  play: { clickedAt: number; loadMs: number | null } | null;
  readAheadSec: number;
  onDownload: () => void;
  className?: string;
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return DASH;
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function advice(record: ModelLoadRecord | null): string {
  if (!record) return 'WebGPU or a faster dtype would help.';
  if (record.resolvedBackend === 'webgpu') {
    return 'This GPU is slow for the voice model; a different dtype (Benchmark tab, then reload the voice model) may help.';
  }
  const tips = ['WebGPU would help if this machine has it (Backend: Auto or WebGPU on the Benchmark tab, then reload the voice model).'];
  if (record.quantization.model !== 'fp16') tips.push('On WASM, fp16 generated fastest in our measurements; q8 was about 2× slower.');
  if (record.wasm.multithreadingUnavailable) tips.push('Inference is single-threaded here because the page is not cross-origin isolated.');
  return tips.join(' ');
}

/** Says plainly whether generation keeps up with playback (shown next to the player). */
export function KeepUpNotice({ snapshot, record }: { snapshot: ReaderSnapshot | null; record: ModelLoadRecord | null }) {
  if (!snapshot) return null;
  const m = snapshot.metrics;
  const rtf = m.recentRtf ?? m.rtf;
  if (rtf !== null && rtf >= 1) {
    return (
      <Notice tone="warn" title="Generation is slower than playback on this machine">
        The voice model needs {rtf.toFixed(2)} s to generate each second of speech, so playback pauses between pieces
        {m.stalls > 0 ? ` (${m.stalls} so far, ${m.stallSilenceSec.toFixed(1)} s of silence)` : ''}. {advice(record)}
      </Notice>
    );
  }
  if (rtf !== null && rtf >= 0.8) {
    return (
      <Notice tone="warn" title="Generation only just keeps up">
        {rtf.toFixed(2)} s of compute per second of speech leaves little headroom: other work on this machine can cause pauses.{' '}
        {advice(record)}
      </Notice>
    );
  }
  if (m.stalls > 0) {
    return (
      <Notice tone="info" title={`Playback waited for generation ${m.stalls === 1 ? 'once' : `${m.stalls} times`}`}>
        Generation is faster than real time overall, but fell behind briefly — usually right after a seek or a voice or speed
        change, or while the machine was busy.
      </Notice>
    );
  }
  return null;
}

export function ReadAloudMetrics({ snapshot, position, totalPieces, record, play, readAheadSec, onDownload, className }: Props) {
  const m = snapshot?.metrics ?? null;
  const fromClick = m?.firstSoundAt != null && play ? m.firstSoundAt - play.clickedAt : null;
  const generator = position?.generating
    ? `generating piece ${position.generating.piece + 1} (${fmtMs(position.generating.elapsedMs)})`
    : snapshot?.status === 'playing' && position && position.bufferedSec >= readAheadSec
      ? 'idle: read-ahead limit reached'
      : snapshot?.status === 'paused'
        ? 'paused'
        : 'idle';
  const archive = m?.archive ?? null;
  const recent = snapshot?.recent ?? [];

  return (
    <Panel title="Read-aloud metrics" subtitle="Measured in this browser" className={className}>
      {m && m.failedPieces > 0 && (
        <Notice tone="warn" title="Some sentences were skipped">
          The voice model returned empty audio for {m.failedPieces} piece{m.failedPieces === 1 ? '' : 's'}, even after rewording;
          {m.failedPieces === 1 ? ' it was' : ' they were'} skipped instead of played as silence. Copy the diagnostics below to report it.
        </Notice>
      )}
      {m && m.retriedPieces > m.failedPieces && (
        <Notice tone="info" title="Empty audio was regenerated">
          {m.retriedPieces - m.failedPieces} piece{m.retriedPieces - m.failedPieces === 1 ? '' : 's'} came back from the voice model as empty audio
          and {m.retriedPieces - m.failedPieces === 1 ? 'was' : 'were'} regenerated with slightly different wording.
        </Notice>
      )}
      {m && m.truncatedPieces > 0 && (
        <Notice tone="warn" title="Some text was cut off">
          {m.truncatedPieces} piece{m.truncatedPieces === 1 ? '' : 's'} could not be split to fit the voice model’s 512-token window; the end of
          {m.truncatedPieces === 1 ? ' it was' : ' each was'} not spoken.
        </Notice>
      )}
      <KvList numeric>
        <Kv label="Voice model" hint={record?.resolvedBackend === 'wasm' ? `${record.wasm.effectiveThreads} WASM thread${record.wasm.effectiveThreads === 1 ? '' : 's'}` : undefined}>
          {record ? `${BACKEND_LABEL[record.resolvedBackend]} · ${record.quantization.model ?? DASH}` : 'not loaded'}
        </Kv>
        <Kv
          label="Time to first audio"
          strong
          hint={m ? `start → first sound; first piece generated after ${fmtMs(m.timeToFirstAudioMs)}` : 'start → first sound'}
        >
          {fmtMs(m?.timeToFirstSoundMs)}
        </Kv>
        {play?.loadMs != null && (
          <Kv label="Play → first audio" hint={`includes loading the voice model (${fmtMs(play.loadMs)})`}>
            {fmtMs(fromClick)}
          </Kv>
        )}
        <Kv label="Generation speed" hint="seconds of compute per second of speech (RTF), last 5 pieces · overall; below 1 keeps up">
          {m ? `${fmtRtf(m.recentRtf)} · ${fmtRtf(m.rtf)}` : DASH}
        </Kv>
        <Kv label="Buffered ahead" hint={`generation waits above ${readAheadSec} s · ${generator}`}>
          {position ? `${position.bufferedSec.toFixed(1)} s` : DASH}
          {position && (
            <span className={styles.meterRow}>
              <Meter
                fraction={Math.min(1, position.bufferedSec / readAheadSec)}
                label="Audio buffered ahead of playback"
                tone={snapshot?.status === 'playing' && position.bufferedSec < 2 && !position.starting ? 'warn' : undefined}
              />
            </span>
          )}
        </Kv>
        <Kv
          label="Stalls"
          hint={
            m
              ? `${m.stallSilenceSec.toFixed(1)} s of silence, longest ${m.longestStallSec.toFixed(1)} s${position?.stalledSec != null ? ` · waiting now ${position.stalledSec.toFixed(1)} s` : ''}`
              : 'playback had to wait for generation'
          }
        >
          {m ? m.stalls : DASH}
        </Kv>
        <Kv
          label="Pieces generated"
          hint={
            m
              ? [
                  m.supersededGenerations > 0 ? `${m.supersededGenerations} superseded by seeks or changes` : null,
                  m.overflowSplits > 0 ? `${m.overflowSplits} split to fit the token window` : null,
                  m.minBufferedSec !== null ? `buffer low point ${m.minBufferedSec.toFixed(1)} s` : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || undefined
              : undefined
          }
        >
          {m ? `${m.piecesGenerated} of ${totalPieces}` : DASH}
        </Kv>
        <Kv label="Last seek → audio" hint={m?.lastSeek ? `to piece ${m.lastSeek.piece + 1}` : 'click a sentence or use ◀ ▶'}>
          {fmtMs(m?.lastSeek?.latencyMs)}
        </Kv>
        <Kv label="Played" hint={position ? `about ${fmtDuration(position.remainingSec)} left at this speed` : undefined}>
          {fmtDuration(position?.playedSec)}
        </Kv>
        <Kv
          label="Audio kept"
          hint={`16-bit PCM for going back and the download; the oldest is dropped beyond 30 min${archive && archive.evicted > 0 ? ` (${archive.evicted} dropped)` : ''}`}
        >
          {archive ? `${fmtDuration(archive.seconds)} · ${fmtBytes(archive.bytes)}` : DASH}
        </Kv>
      </KvList>
      <div className={styles.buttonRow}>
        <button type="button" onClick={onDownload} disabled={!archive || archive.pieces === 0}>
          Download audio (WAV)
        </button>
        <CopyButton label="Copy diagnostics JSON" disabled={!snapshot} getText={() => diagnosticsJson(snapshot, record)} />
        <span className={styles.hint}>Everything generated so far, built in this browser.</span>
      </div>
      {recent.length > 0 && (
        <details>
          <summary>Recent pieces</summary>
          <div className={styles.tableWrap}>
            <table className={styles.recentTable}>
              <thead>
                <tr>
                  <th>Piece</th>
                  <th>Audio</th>
                  <th>Compute</th>
                  <th>RTF</th>
                  <th title="Waiting in the worker behind an earlier request">Queue</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((g) => (
                  <tr key={`${g.piece}:${g.requestedAt}`}>
                    <td>
                      {g.piece + 1}
                      {g.superseded ? ' (superseded)' : ''}
                      {g.overflowSplits > 0 ? ` (split ×${g.overflowSplits})` : ''}
                    </td>
                    <td>{g.audioSec.toFixed(1)} s</td>
                    <td>{fmtMs(g.computeMs)}</td>
                    <td>{fmtRtf(g.rtf)}</td>
                    <td>{fmtMs(g.queueMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </Panel>
  );
}

/** What to send when speech goes missing: settings, counters, every problem piece and the most recent pieces. */
function diagnosticsJson(snapshot: ReaderSnapshot | null, record: ModelLoadRecord | null): string {
  return JSON.stringify(
    {
      kind: 'read-aloud-diagnostics',
      createdAt: new Date().toISOString(),
      app: { ...APP_INFO, origin: location.origin },
      userAgent: navigator.userAgent,
      voiceModel: record
        ? {
            backend: record.resolvedBackend,
            precision: record.quantization.model ?? null,
            wasmThreads: record.wasm.effectiveThreads,
            revision: record.revision,
          }
        : null,
      voice: snapshot?.voice ?? null,
      speed: snapshot?.speed ?? null,
      status: snapshot?.status ?? null,
      error: snapshot?.error ?? null,
      metrics: snapshot?.metrics ?? null,
      problems: snapshot?.problems ?? [],
      recent: snapshot?.recent ?? [],
    },
    null,
    2,
  );
}

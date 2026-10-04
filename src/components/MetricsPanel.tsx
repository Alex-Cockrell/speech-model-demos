'use client';

import { span } from '@/lib/clock';
import { intervalStats } from '@/lib/stats';
import type { EndToEndMetrics, IntervalStats, PartialUpdate } from '@/lib/types';
import type { RunState } from './pipeline/state';
import { fmtInt, fmtMs, fmtOffset, fmtRtf, msParts } from './format';
import { RunErrors } from './RunErrors';
import { Chip, CopyButton, Kv, KvList, Panel } from './ui';
import styles from './panels.module.css';

function firstNonEmptyAt(partials: PartialUpdate[]): number | null {
  return partials.find((p) => p.text.trim() !== '')?.at ?? null;
}

/** Final numbers once the run is recorded; live values from engine callbacks before that. */
function endToEnd(run: RunState): EndToEndMetrics {
  if (run.record) return run.record.endToEnd;
  const asr = run.asr;
  const playbackStart = run.tts?.firstPlaybackStartAt ?? run.playbackStartAt;
  return {
    voiceToFirstTextMs: asr ? span(asr.speechStart, asr.firstPartialAt) : span(run.speechStartAt, firstNonEmptyAt(run.partials)),
    stopToFinalTextMs: span(asr?.recordingStop, asr?.finalTranscriptAt),
    textToFirstSpeechMs: span(asr?.finalTranscriptAt, playbackStart),
    stopToFirstSpeechMs: span(asr?.recordingStop, playbackStart),
    fullRoundTripMs: span(asr?.speechStart, run.tts?.playbackCompleteAt),
  };
}

function IntervalRows({ noun, stats }: { noun: string; stats: IntervalStats }) {
  return (
    <>
      <Kv label={`Avg ${noun} interval`}>{fmtMs(stats.meanMs)}</Kv>
      <Kv label={`Median ${noun} interval`}>{fmtMs(stats.medianMs)}</Kv>
      <Kv label={`Max ${noun} interval`}>{fmtMs(stats.maxMs)}</Kv>
    </>
  );
}

export function EndToEndPanel({ run, className }: { run: RunState | null; className?: string }) {
  const e2e = run ? endToEnd(run) : null;
  const [value, unit] = msParts(e2e?.stopToFirstSpeechMs);
  const record = run?.record ?? null;
  return (
    <Panel
      title="End-to-end"
      className={className}
      actions={<CopyButton label="Copy benchmark JSON" disabled={!record} getText={() => JSON.stringify(record, null, 2)} />}
    >
      <div className={styles.hero}>
        <div className={styles.heroLabel}>Stop → first speech</div>
        <div className={styles.heroValue}>
          {value}
          {unit && <span className={styles.heroUnit}> {unit}</span>}
        </div>
        <div className={styles.heroCaption}>After I finish speaking, how long until it starts saying my words back?</div>
      </div>
      <KvList numeric>
        <Kv label="Voice → first text">{fmtMs(e2e?.voiceToFirstTextMs)}</Kv>
        <Kv label="Stop → final text">{fmtMs(e2e?.stopToFinalTextMs)}</Kv>
        <Kv label="Text → first speech">{fmtMs(e2e?.textToFirstSpeechMs)}</Kv>
        <Kv label="Stop → first speech" strong>
          {fmtMs(e2e?.stopToFirstSpeechMs)}
        </Kv>
        <Kv label="Full round trip" hint="speech start → playback complete">
          {fmtMs(e2e?.fullRoundTripMs)}
        </Kv>
      </KvList>
      {!run && <p className="muted">Load both models, then record a run.</p>}
    </Panel>
  );
}

export function AsrMetricsPanel({ run, className }: { run: RunState | null; className?: string }) {
  const m = run?.asr ?? null;
  return (
    <Panel
      title="ASR · Parakeet"
      className={className}
      subtitle={m ? `${m.settings.chunkMs} ms chunks · ${m.settings.finalPass} final pass` : run ? 'live' : undefined}
    >
      {!run && <p className="muted">Streaming transcription metrics appear here.</p>}
      {run && !m && (
        <KvList numeric>
          <Kv label="First text" hint="speech start → first partial">
            {fmtMs(span(run.speechStartAt, firstNonEmptyAt(run.partials)))}
          </Kv>
          <Kv label="Partial updates">{run.partials.length}</Kv>
          <IntervalRows noun="update" stats={intervalStats(run.partials.map((p) => p.at))} />
        </KvList>
      )}
      {m && (
        <KvList numeric>
          <Kv label="First text" hint="speech start → first partial">
            {fmtMs(m.voiceToFirstTextMs)}
          </Kv>
          <Kv label="Submit → first text" hint="first audio chunk → first partial">
            {fmtMs(m.submitToFirstTextMs)}
          </Kv>
          <IntervalRows noun="update" stats={m.updateIntervals} />
          <Kv label="Partial updates">{m.partialUpdateCount}</Kv>
          <Kv label="Finalization" hint="Stop → final transcript">
            {fmtMs(m.finalizationMs)}
          </Kv>
          <Kv label="Audio duration">{fmtMs(m.audioDurationSec * 1000)}</Kv>
          <Kv label="RTF" strong hint={`${fmtMs(m.computeMs)} compute in total`}>
            {m.rtf != null && m.rtf >= 1 && <Chip tone="warn">slower than real time</Chip>} {fmtRtf(m.rtf)}
          </Kv>
          <Kv label="· streaming RTF" hint={`${fmtMs(m.streamingComputeMs)} over ${m.chunksSubmitted} chunks`}>
            {fmtRtf(m.streamingRtf)}
          </Kv>
          <Kv
            label="· final-pass RTF"
            hint={m.finalPassComputeMs == null ? 'no final pass (streaming)' : `${fmtMs(m.finalPassComputeMs)} for the whole utterance`}
          >
            {fmtRtf(m.finalPassRtf)}
          </Kv>
          <Kv label="Microphone">
            {m.mic.deviceLabel || 'default device'} · {fmtInt(m.mic.contextSampleRate)} Hz
          </Kv>
        </KvList>
      )}
    </Panel>
  );
}

export function TtsMetricsPanel({ run, className }: { run: RunState | null; className?: string }) {
  const m = run?.tts ?? null;
  const errors = run?.errors.filter((e) => e.stage === 'tts') ?? [];
  const t0 = run?.speakCalledAt ?? null;
  return (
    <Panel title="TTS · Kokoro" className={className} subtitle={m ? `${m.settings.voice} · ${m.settings.split} split` : t0 != null ? 'live' : undefined}>
      <RunErrors errors={errors} />
      {!run && <p className="muted">Streaming synthesis and playback continuity appear here.</p>}
      {run && !m && t0 != null && (
        <KvList numeric>
          <Kv label="First audio generated">{fmtMs(span(t0, run.chunks[0]?.generatedAt))}</Kv>
          <Kv label="First audible speech">{fmtMs(span(t0, run.playbackStartAt))}</Kv>
          <Kv label="Chunks">{run.chunks.length}</Kv>
          <IntervalRows noun="chunk" stats={intervalStats(run.chunks.map((c) => c.generatedAt))} />
          <Kv label="Buffer underruns">{run.chunks.filter((c) => c.underrun).length}</Kv>
        </KvList>
      )}
      {m && (
        <KvList numeric>
          <Kv label="First audio generated" hint="TTS start → first chunk">
            {fmtMs(m.timeToFirstAudioMs)}
          </Kv>
          <Kv label="First audible speech" hint="TTS start → playback start">
            {fmtMs(m.timeToFirstSpeechMs)}
          </Kv>
          <IntervalRows noun="chunk" stats={m.chunkIntervals} />
          <Kv label="Chunks">{m.chunks.length}</Kv>
          <Kv label="Buffer underruns" strong>
            {m.bufferUnderruns > 0 ? <Chip tone="warn">{m.bufferUnderruns}</Chip> : m.bufferUnderruns}
          </Kv>
          <Kv label="Audible pause" hint="silence spent waiting for generation">
            {fmtMs(m.audiblePauseMs)}
          </Kv>
          <Kv label="Buffered min / max">
            {fmtMs(m.minBufferedMs)} / {fmtMs(m.maxBufferedMs)}
          </Kv>
          <Kv label="Generation RTF" strong hint={`${fmtMs(m.generationComputeMs)} compute for ${fmtMs(m.generatedAudioMs)} of audio`}>
            {m.generationRtf != null && m.generationRtf >= 1 && <Chip tone="warn">slower than playback</Chip>} {fmtRtf(m.generationRtf)}
          </Kv>
          <Kv label="Generation complete">{fmtOffset(span(m.ttsStart, m.generationCompleteAt))}</Kv>
          <Kv label="Playback complete">{fmtOffset(span(m.ttsStart, m.playbackCompleteAt))}</Kv>
          <Kv label="Audio output" hint={`base latency ${fmtMs(m.audioOutput.baseLatencyMs)} · output latency ${fmtMs(m.audioOutput.outputLatencyMs)}`}>
            {fmtInt(m.audioOutput.contextSampleRate)} Hz
          </Kv>
          <Kv label="Speed">{m.settings.speed.toFixed(2)}×</Kv>
        </KvList>
      )}
    </Panel>
  );
}

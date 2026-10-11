/**
 * A benchmark recording (spec §9): the microphone through the same segmentation and scheduling as the meeting
 * mode (transcriber.ts), measured as AsrRunMetrics.
 *
 * Visible text = each segment's final text, or its latest partial until the final arrives, in order. Every change
 * while recording is a partial update. On Stop the open segment is finalized; with finalPass 'full' the whole
 * recording is then transcribed once more and that becomes the final text (the segments text stays in
 * streamingText for comparison). Only 'full' keeps the whole recording in memory.
 */
import { now, span } from '@local-speech/core';
import { intervalStats } from '@local-speech/core';
import type { AsrRunMetrics, AsrSettings, MicInfo, PartialUpdate } from './types.js';
import { AudioCapture, openMicrophone, stopStreams, type CaptureInput } from './capture.js';
import { meanSquare, PcmBuffer } from './pcm.js';
import { ASR_SAMPLE_RATE, describeError } from './protocol.js';
import { LiveTranscriber, type PassRunner, type TranscriberLog } from './transcriber.js';

const LEVEL_INTERVAL_SAMPLES = ASR_SAMPLE_RATE / 20;

export interface AsrRecordingCallbacks {
  onPartial?: (update: PartialUpdate) => void;
  /** Onset of the first speech segment (it is reported once the segment has 250 ms of speech). */
  onSpeechStart?: (at: number) => void;
  /** Microphone RMS level 0..1, roughly every 50 ms, for a level meter. */
  onLevel?: (rms: number) => void;
}

export class BenchmarkRecording {
  readonly started: Promise<void>;
  private readonly core: LiveTranscriber;
  /** The whole recording, for finalPass 'full' only. */
  private readonly all: PcmBuffer | null;
  private stream: MediaStream | null = null;
  private capture: AudioCapture | null = null;
  private input: CaptureInput | null = null;
  private readonly texts = new SegmentTexts();
  private visibleText = '';
  private readonly partials: PartialUpdate[] = [];
  private firstPartialAt: number | null = null;
  private speechStart: number | null = null;
  private capturedSamples = 0;
  private levelSum = 0;
  private levelCount = 0;
  private stopRequested = false;
  private cancelled = false;
  private error: string | null = null;

  constructor(
    private readonly runner: PassRunner,
    private readonly settings: AsrSettings,
    private readonly callbacks: AsrRecordingCallbacks,
    readonly micStart: number,
    runTag: string,
    log: TranscriberLog,
  ) {
    this.all = settings.finalPass === 'full' ? new PcmBuffer(ASR_SAMPLE_RATE * 20) : null;
    this.core = new LiveTranscriber(
      {
        sampleRate: ASR_SAMPLE_RATE,
        partialIntervalMs: settings.partialIntervalMs,
        minSilenceMs: settings.minSilenceMs,
        maxSegmentMs: settings.maxSegmentMs,
        origin: micStart,
        runTag,
        now,
        log,
      },
      runner,
      {
        onSegmentStart: (e) => {
          this.texts.start(e.segmentId);
          if (this.speechStart === null) {
            this.speechStart = e.onsetAt;
            notify(() => this.callbacks.onSpeechStart?.(e.onsetAt));
          }
        },
        onPartial: (e) => {
          this.texts.partial(e.segmentId, e.text);
          this.refresh(e.at);
        },
        onFinal: (e) => {
          this.texts.final(e.segmentId, e.text);
          this.refresh(e.at);
        },
        onError: (message) => {
          this.error ??= message;
        },
      },
    );
    this.core.addSource('mic', { timeAtSample: (index) => this.input?.timeAtSample(index) ?? now() });
    this.started = this.start();
    this.started.catch(() => undefined);
  }

  /** Stops the microphone, finalizes the transcript and returns the run's ASR metrics. */
  async stop(recordingStop: number): Promise<AsrRunMetrics> {
    if (this.stopRequested) throw new Error('The recording is already stopping.');
    this.stopRequested = true;
    await this.started;
    const capture = this.capture;
    if (!capture || this.cancelled) throw new Error('The recording was cancelled.');
    const mic: MicInfo = capture.inputs[0].info;
    try {
      await capture.flush();
    } finally {
      this.release();
    }
    this.core.flushAll();
    await this.core.drain();
    if (this.cancelled) throw new Error('The recording was cancelled.');
    if (this.error) throw new Error(this.error);

    const streamingText = this.texts.finals;
    let finalText = streamingText;
    let finalPassComputeMs: number | null = null;
    let finalPassSamples = 0;
    if (this.all) {
      const audio = this.all.copy();
      finalPassSamples = audio.length;
      finalText = '';
      if (audio.length > 0) {
        try {
          const result = await this.runner.run('full', audio, null);
          finalText = result.text;
          finalPassComputeMs = result.computeMs;
          console.info(`[asr] full pass: ${(finalPassSamples / ASR_SAMPLE_RATE).toFixed(2)} s in ${Math.round(result.computeMs)} ms`);
        } catch (err) {
          throw new Error(`The whole-recording pass failed: ${describeError(err)}`);
        }
      }
    }
    const finalTranscriptAt = now();
    const metrics = this.metrics(mic, recordingStop, finalTranscriptAt, streamingText, finalText, finalPassComputeMs, finalPassSamples);
    console.info(
      `[asr] recording stopped: ${metrics.audioDurationSec.toFixed(2)} s of audio, ${this.core.stats.segments} segments, ` +
        `${metrics.chunksSubmitted} passes (${this.core.stats.partialPasses} partial), ASR ${Math.round(metrics.computeMs)} ms ` +
        `(rtf ${metrics.rtf?.toFixed(3) ?? '–'}), Stop → final text ${Math.round(metrics.finalizationMs)} ms`,
    );
    return metrics;
  }

  /** Abort without producing metrics; releases the microphone at once. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.core.abandon();
    this.release();
  }

  private async start(): Promise<void> {
    try {
      this.stream = await openMicrophone();
      if (this.cancelled) throw new Error('Recording was cancelled while the microphone was opening.');
      this.capture = await AudioCapture.start([this.stream], [(samples, input) => this.onAudio(samples, input)]);
      if (this.cancelled) throw new Error('Recording was cancelled while the microphone was opening.');
    } catch (err) {
      this.release();
      throw err;
    }
  }

  private release(): void {
    this.capture?.close();
    if (this.stream) stopStreams([this.stream]);
  }

  private onAudio(samples: Float32Array, input: CaptureInput): void {
    if (this.cancelled) return;
    this.input ??= input;
    this.capturedSamples += samples.length;
    this.all?.append(samples);
    this.core.push('mic', samples);

    this.levelSum += meanSquare(samples) * samples.length;
    this.levelCount += samples.length;
    if (this.levelCount >= LEVEL_INTERVAL_SAMPLES) {
      const rms = Math.min(1, Math.sqrt(this.levelSum / this.levelCount));
      this.levelSum = 0;
      this.levelCount = 0;
      if (!this.stopRequested) notify(() => this.callbacks.onLevel?.(rms));
    }
  }

  private refresh(at: number): void {
    const text = this.texts.visible;
    if (text === this.visibleText) return;
    this.visibleText = text;
    // After Stop, changes are the final text arriving, not live updates.
    if (this.stopRequested) return;
    const update: PartialUpdate = { at, text };
    this.partials.push(update);
    if (this.firstPartialAt === null && text !== '') this.firstPartialAt = at;
    notify(() => this.callbacks.onPartial?.(update));
  }

  private metrics(
    mic: MicInfo,
    recordingStop: number,
    finalTranscriptAt: number,
    streamingText: string,
    finalText: string,
    finalPassComputeMs: number | null,
    finalPassSamples: number,
  ): AsrRunMetrics {
    const stats = this.core.stats;
    const streamingComputeMs = stats.computeMs;
    const computeMs = streamingComputeMs + (finalPassComputeMs ?? 0);
    const firstAudioSubmitted = stats.firstPassAt;
    return {
      micStart: this.micStart,
      speechStart: this.speechStart,
      firstAudioSubmitted,
      firstPartialAt: this.firstPartialAt,
      recordingStop,
      finalTranscriptAt,
      partials: this.partials,
      voiceToFirstTextMs: span(this.speechStart, this.firstPartialAt),
      submitToFirstTextMs: span(firstAudioSubmitted, this.firstPartialAt),
      updateIntervals: intervalStats(this.partials.map((update) => update.at)),
      partialUpdateCount: this.partials.length,
      finalizationMs: finalTranscriptAt - recordingStop,
      audioDurationSec: this.capturedSamples / ASR_SAMPLE_RATE,
      computeMs,
      rtf: perAudio(computeMs, this.capturedSamples),
      streamingComputeMs,
      streamingRtf: perAudio(streamingComputeMs, this.capturedSamples),
      finalPassComputeMs,
      finalPassRtf: finalPassComputeMs === null ? null : perAudio(finalPassComputeMs, finalPassSamples),
      chunksSubmitted: stats.passes,
      streamingText,
      finalText,
      settings: this.settings,
      mic,
    };
  }
}

/** Text of the segments of one recording, in order: each one's final, or its latest partial until the final arrives. */
export class SegmentTexts {
  private readonly segments: { id: string; partial: string; final: string | null }[] = [];

  start(id: string): void {
    this.segments.push({ id, partial: '', final: null });
  }

  partial(id: string, text: string): void {
    const segment = this.find(id);
    if (segment && segment.final === null) segment.partial = text;
  }

  final(id: string, text: string): void {
    const segment = this.find(id);
    if (segment) segment.final = text;
  }

  /** What the benchmark shows while recording. */
  get visible(): string {
    return joinTexts(this.segments.map((segment) => segment.final ?? segment.partial));
  }

  /** The concatenated final texts (streamingText). */
  get finals(): string {
    return joinTexts(this.segments.map((segment) => segment.final ?? ''));
  }

  private find(id: string): { id: string; partial: string; final: string | null } | undefined {
    for (let i = this.segments.length - 1; i >= 0; i--) if (this.segments[i].id === id) return this.segments[i];
    return undefined;
  }
}

function joinTexts(texts: readonly string[]): string {
  return texts
    .map((text) => text.trim())
    .filter((text) => text !== '')
    .join(' ');
}

/** Compute milliseconds per millisecond of 16 kHz audio. */
function perAudio(computeMs: number, samples: number): number | null {
  return samples > 0 ? computeMs / ((samples / ASR_SAMPLE_RATE) * 1000) : null;
}

/** UI callbacks must not break capture. */
function notify(callback: () => void): void {
  try {
    callback();
  } catch (err) {
    console.error('[asr] recording callback threw', err);
  }
}

/**
 * Microphone → AudioWorklet → 16 kHz mono Float32 on the main thread.
 *
 * Chrome resamples the mic well when the AudioContext itself runs at 16 kHz. Firefox refuses to connect
 * a mic to a context whose rate differs from the device's, so there we run at the native rate and
 * resample with StreamingResampler.
 */
import { now } from '@/lib/clock';
import type { MicInfo } from '@/lib/types';
import { ASR_SAMPLE_RATE } from './protocol';
import { StreamingResampler } from './resampler';

const PROCESSOR = 'speech-poc-pcm-capture';
const FRAME_SECONDS = 0.02;
const FLUSH_TIMEOUT_MS = 200;
const RESUME_TIMEOUT_MS = 2000;

// Kept as a string and loaded from a blob: URL so it needs no separate static asset (blob: URLs are
// same-origin, which COEP require-corp allows). Posts fixed-size frames; 'flush' posts the remainder.
const WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options.processorOptions.frameSize;
    this.frame = new Float32Array(this.size);
    this.filled = 0;
    this.running = true;
    this.port.onmessage = (event) => {
      if (!event.data || event.data.type !== 'flush') return;
      if (this.filled > 0) this.emit(this.frame.slice(0, this.filled));
      this.filled = 0;
      this.running = false;
      this.port.postMessage({ type: 'flushed' });
    };
  }
  emit(samples) {
    this.port.postMessage({ type: 'audio', samples }, [samples.buffer]);
  }
  process(inputs) {
    if (!this.running) return false;
    const input = inputs[0] && inputs[0][0];
    if (input) {
      for (let offset = 0; offset < input.length; ) {
        const n = Math.min(input.length - offset, this.size - this.filled);
        this.frame.set(input.subarray(offset, offset + n), this.filled);
        this.filled += n;
        offset += n;
        if (this.filled === this.size) {
          this.emit(this.frame);
          this.frame = new Float32Array(this.size);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('${PROCESSOR}', PcmCapture);
`;

let workletUrl: string | null = null;

type WorkletMessage = { type: 'audio'; samples: Float32Array } | { type: 'flushed' };

export class MicCapture {
  mic: MicInfo | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private resampler: StreamingResampler | null = null;
  private inputSamples = 0;
  /** Main-clock time of input sample 0 (earliest consistent estimate across all frames). */
  private originAt = Infinity;
  private inputLatencyMs = 0;
  private onFlushed: (() => void) | null = null;
  private released = false;

  /** `onAudio` receives 16 kHz mono samples in order; the array may be reused, so copy what you keep. */
  constructor(private readonly onAudio: (samples: Float32Array) => void) {}

  async start(): Promise<void> {
    try {
      await this.open();
    } catch (err) {
      const cancelled = this.released;
      this.release();
      throw cancelled ? new Error('Recording was cancelled while the microphone was opening.') : err;
    }
  }

  private async open(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    if (this.released) throw new Error('cancelled');
    const track = this.stream.getAudioTracks()[0];
    if (!track) throw new Error('The microphone stream has no audio track.');

    const { context, source } = connectMicrophone(this.stream);
    this.context = context;
    this.source = source;
    workletUrl ??= URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    await context.audioWorklet.addModule(workletUrl);
    if (this.released) throw new Error('cancelled');

    this.node = new AudioWorkletNode(context, PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { frameSize: Math.round(context.sampleRate * FRAME_SECONDS) },
    });
    this.node.port.onmessage = (event: MessageEvent<WorkletMessage>) => this.handle(event.data);
    if (context.sampleRate !== ASR_SAMPLE_RATE) this.resampler = new StreamingResampler(context.sampleRate, ASR_SAMPLE_RATE);

    const settings = track.getSettings();
    this.mic = { contextSampleRate: context.sampleRate, deviceLabel: track.label || null, trackSettings: { ...settings } };
    // Chromium reports the capture latency (seconds); not in the TS DOM types.
    const latency = (settings as { latency?: unknown }).latency;
    this.inputLatencyMs = typeof latency === 'number' && Number.isFinite(latency) ? latency * 1000 : 0;

    source.connect(this.node);
    // Connected to the destination so every browser pulls the node; it never writes its output (silence).
    this.node.connect(context.destination);
    if (context.state !== 'running') {
      await Promise.race([context.resume(), new Promise((resolve) => setTimeout(resolve, RESUME_TIMEOUT_MS))]);
    }
    if (this.released) throw new Error('cancelled');
    const state: AudioContextState = context.state;
    if (state !== 'running') {
      throw new Error(`Audio capture could not start (AudioContext is ${state}); start recording from a click.`);
    }
  }

  /** Main-clock time at which 16 kHz sample `index` of this recording was captured (approximate). */
  timeAtSample(index: number): number {
    return this.originAt - this.inputLatencyMs + (index / ASR_SAMPLE_RATE) * 1000;
  }

  /** Delivers the audio still inside the worklet and resampler, then releases the microphone. */
  async stop(): Promise<void> {
    if (this.released) return;
    const node = this.node;
    if (node && this.context?.state === 'running') {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
        this.onFlushed = () => {
          clearTimeout(timer);
          resolve();
        };
        node.port.postMessage({ type: 'flush' });
      });
    }
    const tail = this.resampler?.flush();
    if (tail && tail.length > 0) this.onAudio(tail);
    this.release();
  }

  /** Releases the microphone immediately (browser recording indicator turns off). */
  release(): void {
    this.released = true;
    this.onFlushed = null;
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => undefined);
  }

  private handle(message: WorkletMessage): void {
    if (message.type === 'flushed') {
      this.onFlushed?.();
      return;
    }
    if (this.released || !this.context) return;
    // A frame cannot arrive before it was captured, so the smallest (arrival - captured duration)
    // seen so far is the tightest estimate of when sample 0 was captured; later delays only add.
    this.inputSamples += message.samples.length;
    this.originAt = Math.min(this.originAt, now() - (this.inputSamples / this.context.sampleRate) * 1000);
    const samples = this.resampler ? this.resampler.process(message.samples) : message.samples;
    if (samples.length > 0) this.onAudio(samples);
  }
}

function connectMicrophone(stream: MediaStream): { context: AudioContext; source: MediaStreamAudioSourceNode } {
  let context: AudioContext | null = null;
  try {
    context = new AudioContext({ sampleRate: ASR_SAMPLE_RATE, latencyHint: 'interactive' });
    return { context, source: context.createMediaStreamSource(stream) };
  } catch {
    // Firefox: NotSupportedError for a mic on a context with a different sample rate.
    if (context) void context.close().catch(() => undefined);
  }
  const native = new AudioContext({ latencyHint: 'interactive' });
  try {
    return { context: native, source: native.createMediaStreamSource(stream) };
  } catch (err) {
    void native.close().catch(() => undefined);
    throw err;
  }
}

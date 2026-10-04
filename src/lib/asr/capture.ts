/**
 * MediaStream(s) → one AudioContext → an AudioWorklet node per stream → 16 kHz mono Float32 on the main thread.
 *
 * The streams of a session (microphone, call audio) share one AudioContext: one audio rendering stream instead of
 * one per source, and every source on the same sample clock. Chrome resamples well when the context itself runs
 * at 16 kHz. Firefox refuses to connect a mic to a context whose rate differs from the device's, so there we run
 * at the native rate and resample with StreamingResampler.
 */
import { now } from '@/lib/clock';
import type { MicInfo } from '@/lib/types';
import { ASR_SAMPLE_RATE } from './protocol';
import { StreamingResampler } from './resampler';

const PROCESSOR = 'speech-poc-pcm-capture';
const FRAME_SECONDS = 0.02;
const FLUSH_TIMEOUT_MS = 200;
const RESUME_TIMEOUT_MS = 2000;
/** Arrival-time estimates use the last 10–20 s of frames, so they follow device/system clock drift in long sessions. */
const CLOCK_BUCKET_SECONDS = 10;

// Kept as a string and loaded from a blob: URL so it needs no separate static asset (blob: URLs are
// same-origin, which COEP require-corp allows). Posts fixed-size frames; 'flush' posts the remainder.
// Nothing is posted before the source first produces audio; after that a quantum without input (e.g. the track
// stopped producing) is written as silence, so the sample count keeps pace with the context clock.
const WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options.processorOptions.frameSize;
    this.frame = new Float32Array(this.size);
    this.filled = 0;
    this.running = true;
    this.started = false;
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
  process(inputs, outputs) {
    if (!this.running) return false;
    const input = inputs[0] && inputs[0][0];
    if (input) this.started = true;
    if (!this.started) return true;
    const output = outputs[0] && outputs[0][0];
    const length = input ? input.length : output ? output.length : 128;
    for (let offset = 0; offset < length; ) {
      const n = Math.min(length - offset, this.size - this.filled);
      if (input) this.frame.set(input.subarray(offset, offset + n), this.filled);
      else this.frame.fill(0, this.filled, this.filled + n);
      this.filled += n;
      offset += n;
      if (this.filled === this.size) {
        this.emit(this.frame);
        this.frame = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('${PROCESSOR}', PcmCapture);
`;

let workletUrl: string | null = null;

type WorkletMessage = { type: 'audio'; samples: Float32Array } | { type: 'flushed' };

export type AudioHandler = (samples: Float32Array, input: CaptureInput) => void;

/** The default microphone, with the browser's echo cancellation, noise suppression and gain control (its defaults). */
export function openMicrophone(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
}

/** Stops every track of the streams (releases the devices and the browser's capture indicators). */
export function stopStreams(streams: readonly MediaStream[]): void {
  for (const stream of streams) for (const track of stream.getTracks()) track.stop();
}

export class AudioCapture {
  private closed = false;

  private constructor(
    private readonly context: AudioContext,
    readonly inputs: readonly CaptureInput[],
  ) {
    context.addEventListener('statechange', () => {
      if (this.closed || context.state === 'running') return;
      // e.g. the OS audio device changed: try to keep capturing rather than going silent.
      console.warn(`[asr] capture AudioContext is ${context.state}; resuming`);
      void context.resume().catch((err: unknown) => console.warn('[asr] resuming the capture AudioContext failed', err));
    });
  }

  /**
   * Connects each stream's first audio track; `onAudio[i]` receives stream i's 16 kHz samples in order (the array
   * may be reused, so copy what you keep), possibly before start() resolves. Call from a user gesture, or after one
   * (AudioContext autoplay rules).
   */
  static async start(streams: readonly MediaStream[], onAudio: readonly AudioHandler[]): Promise<AudioCapture> {
    const tracks = streams.map((stream) => {
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('The stream has no audio track.');
      return track;
    });
    const { context, sources } = connectStreams(streams);
    try {
      workletUrl ??= URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
      await context.audioWorklet.addModule(workletUrl);
      const inputs = sources.map((source, i) => new CaptureInput(context, tracks[i], source, onAudio[i]));
      if (context.state !== 'running') {
        await Promise.race([context.resume(), new Promise((resolve) => setTimeout(resolve, RESUME_TIMEOUT_MS))]);
      }
      const state: AudioContextState = context.state;
      if (state !== 'running') {
        throw new Error(`Audio capture could not start (AudioContext is ${state}); start it from a click.`);
      }
      return new AudioCapture(context, inputs);
    } catch (err) {
      for (const source of sources) source.disconnect();
      void context.close().catch(() => undefined);
      throw err;
    }
  }

  get sampleRate(): number {
    return this.context.sampleRate;
  }

  /** Delivers the audio still inside the worklets and resamplers. */
  async flush(): Promise<void> {
    await Promise.all(this.inputs.map((input) => input.flush()));
  }

  /** Disconnects everything and closes the AudioContext. Does not stop the tracks (their owner does). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const input of this.inputs) input.disconnect();
    if (this.context.state !== 'closed') void this.context.close().catch(() => undefined);
  }
}

export class CaptureInput {
  readonly info: MicInfo;
  private readonly node: AudioWorkletNode;
  private readonly resampler: StreamingResampler | null;
  private readonly inputLatencyMs: number;
  private readonly clock = new ArrivalClock();
  private inputFrames = 0;
  private onFlushed: (() => void) | null = null;
  private disconnected = false;
  private flushed = false;

  constructor(
    private readonly context: AudioContext,
    readonly track: MediaStreamTrack,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly onAudio: AudioHandler,
  ) {
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
    this.resampler = context.sampleRate !== ASR_SAMPLE_RATE ? new StreamingResampler(context.sampleRate, ASR_SAMPLE_RATE) : null;

    const settings = track.getSettings();
    this.info = { contextSampleRate: context.sampleRate, deviceLabel: track.label || null, trackSettings: { ...settings } };
    // Chromium reports the capture latency (seconds); not in the TS DOM types.
    const latency = (settings as { latency?: unknown }).latency;
    this.inputLatencyMs = typeof latency === 'number' && Number.isFinite(latency) ? latency * 1000 : 0;

    source.connect(this.node);
    // Connected to the destination so every browser pulls the node; it never writes its output (silence).
    this.node.connect(context.destination);
  }

  /** Main-clock time at which 16 kHz sample `index` of this input was captured (approximate). */
  timeAtSample(index: number): number {
    return this.clock.origin - this.inputLatencyMs + (index / ASR_SAMPLE_RATE) * 1000;
  }

  /** Delivers the audio still inside the worklet and the resampler; the input produces nothing afterwards. */
  async flush(): Promise<void> {
    if (this.disconnected || this.flushed) return;
    this.flushed = true;
    if (this.context.state === 'running') {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
        this.onFlushed = () => {
          clearTimeout(timer);
          resolve();
        };
        this.node.port.postMessage({ type: 'flush' });
      });
    }
    this.onFlushed = null;
    const tail = this.resampler?.flush();
    if (tail && tail.length > 0 && !this.disconnected) this.onAudio(tail, this);
  }

  /** Stops delivering audio at once. */
  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.onFlushed?.();
    this.onFlushed = null;
    this.node.port.onmessage = null;
    this.node.disconnect();
    this.source.disconnect();
  }

  private handle(message: WorkletMessage): void {
    if (message.type === 'flushed') {
      this.onFlushed?.();
      return;
    }
    if (this.disconnected) return;
    this.inputFrames += message.samples.length;
    const capturedSeconds = this.inputFrames / this.context.sampleRate;
    this.clock.observe(now() - capturedSeconds * 1000, capturedSeconds);
    const samples = this.resampler ? this.resampler.process(message.samples) : message.samples;
    if (samples.length > 0) this.onAudio(samples, this);
  }
}

/**
 * Main-clock time of input sample 0. A frame cannot arrive before it was captured, so the smallest
 * (arrival − captured duration) is the tightest estimate; later delays only add. The minimum is taken over the
 * last 10–20 s of audio rather than the whole session, so it follows drift between the audio clock and
 * performance.now() in either direction during long meetings.
 */
class ArrivalClock {
  private current = Infinity;
  private previous = Infinity;
  private bucketStart = 0;

  get origin(): number {
    return Math.min(this.current, this.previous);
  }

  observe(offset: number, capturedSeconds: number): void {
    if (capturedSeconds - this.bucketStart >= CLOCK_BUCKET_SECONDS) {
      this.previous = this.current;
      this.current = Infinity;
      this.bucketStart = capturedSeconds;
    }
    this.current = Math.min(this.current, offset);
  }
}

function connectStreams(streams: readonly MediaStream[]): { context: AudioContext; sources: MediaStreamAudioSourceNode[] } {
  let context: AudioContext | null = null;
  try {
    context = new AudioContext({ sampleRate: ASR_SAMPLE_RATE, latencyHint: 'interactive' });
    const at16k = context;
    return { context: at16k, sources: streams.map((stream) => at16k.createMediaStreamSource(stream)) };
  } catch {
    // Firefox: NotSupportedError for a mic on a context with a different sample rate.
    if (context) void context.close().catch(() => undefined);
  }
  const native = new AudioContext({ latencyHint: 'interactive' });
  try {
    return { context: native, sources: streams.map((stream) => native.createMediaStreamSource(stream)) };
  } catch (err) {
    void native.close().catch(() => undefined);
    throw err;
  }
}

/**
 * Meeting orchestration: setup (sources, models), the live session (ASR segments → transcript, echo duplicates,
 * speaker assignment, live stats), speaker edits and re-identification, autosave, the saved transcripts, and
 * refined copies made with a Teams transcript.
 *
 * Like PipelineController: a plain class holding one immutable snapshot, so async flows always read current state.
 * useMeeting subscribes with useSyncExternalStore. Everything external comes in through MeetingDeps (the app
 * controller, the speaker engine, the share picker, storage), so the controller also runs against fakes in tests.
 *
 * Event flow while a meeting runs:
 *   onSegmentStart / onPartial → live.open (dimmed live text per source)
 *   onFinal → transcript line (empty text dropped) → microphone lines: echo check against the call lines around
 *     them; held back while a call segment overlapping them is still open → speaker session assign() → the
 *     assignment lands on the line (placeholder until then). Call lines re-check the microphone lines around them.
 *   onStats → live stats and the "can't keep up" flag; onLevel → per-source level stores (meters only).
 *   Every ~10 s the transcript is saved with status 'recording'; Stop saves it as 'complete'.
 */
import type {
  LiveSessionStats,
  SegmentFinalEvent,
  SessionCallbacks,
  SessionOptions,
  SessionSourceInput,
  TranscriptionSession,
} from '@local-speech/speech-to-text';
import { errorMessage } from '@/lib/benchmark/errors';
import { newRunId, summarizeModel } from '@/lib/benchmark/record';
import { resolveModelSource } from '@/lib/benchmark/settings';
import { now } from '@local-speech/core';
import { APP_INFO } from '@/lib/config';
import type { SpeakerLoadOptions, SpeakerSession } from '@/lib/speakers/engine';
import { summarize } from '@local-speech/core';
import { detectEcho, overlapsWithin } from '@/lib/transcripts/echo';
import {
  addSegment,
  applyAssignment,
  applyRecluster,
  cleanText,
  cleanTitle,
  createDoc,
  docFromTranscript,
  editSegmentText,
  findSegment,
  markEcho,
  mergeSpeakers,
  reassignSegment,
  renameSpeaker,
  setTitle,
  type SpeakerTarget,
  type TranscriptDoc,
} from '@/lib/transcripts/model';
import { sortSummaries, storageErrorMessage, type TranscriptStore } from '@/lib/transcripts/store';
import { refineWithTeams, yieldToPage, type RefineProgress } from '@/lib/transcripts/teams/refine';
import type { ParsedTeamsTranscript } from '@/lib/transcripts/teams/types';
import type { MeetingSegment, MeetingTranscript, TranscriptRefinement, TranscriptStatus, TranscriptSummary } from '@/lib/transcripts/types';
import type { AudioSourceKind, ModelKey, ModelLoadRecord, SessionStats } from '@/lib/types';
import { createLevelStore, type LevelStore } from '../pipeline/levelStore';
import { createProgressSink } from '../pipeline/progress';
import { loadBlocker, type AppActivity, type PipelineSnapshot } from '../pipeline/state';
import {
  SOURCE_LABEL,
  activityBlocker,
  isSessionActive,
  selectedSources,
  startBlocker,
  type DocState,
  type LiveState,
  type MeetingNotice,
  type MeetingSnapshot,
  type OpenSegment,
  type SaveState,
  type SourceSelection,
  type SpeakerModelState,
  type StartProblem,
} from './state';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** What the meeting needs from the app controller (PipelineController satisfies it). */
export interface MeetingPipeline {
  getSnapshot(): PipelineSnapshot;
  loadModels(keys: readonly ModelKey[]): Promise<void>;
  claimActivity(activity: AppActivity): boolean;
  releaseActivity(activity: AppActivity): void;
  getAsrEngine(): { startSession(options: SessionOptions, callbacks: SessionCallbacks): Promise<TranscriptionSession> };
}

/** What the meeting needs from the speaker engine (SpeakerEngine satisfies it). */
export interface SpeakerEngineLike {
  readonly isLoaded: boolean;
  readonly loadRecord: ModelLoadRecord | null;
  load(options: SpeakerLoadOptions): Promise<ModelLoadRecord>;
  createSession(options?: { threshold?: number }): SpeakerSession;
  dispose(): void;
}

export interface MeetingPrefs {
  sources: SourceSelection;
  showEcho: boolean;
}

export interface MeetingTiming {
  /** Autosave interval while a meeting runs (also the heartbeat that tells a running meeting from a cut-off one). */
  autosaveMs: number;
  /** Delay before an edit is saved. */
  editSaveDelayMs: number;
  /** How long Stop waits for speaker assignments still in flight before saving. */
  speakerSettleMs: number;
  /** A 'recording' transcript not saved for this long belongs to a meeting that was cut off. */
  staleRecordingMs: number;
  /**
   * Estimated time to catch up (queued speech × the session's real-time factor) that raises the "can't keep up"
   * warning, and the level that clears it. Queued audio alone misleads: two sources ending lines together can
   * queue 9 s of speech that a fast machine clears in half a second.
   */
  behindOnMs: number;
  behindOffMs: number;
  /** Slack when matching microphone lines against call lines (echo duplicates). */
  echoToleranceMs: number;
}

export const DEFAULT_TIMING: MeetingTiming = {
  autosaveMs: 10_000,
  editSaveDelayMs: 800,
  speakerSettleMs: 10_000,
  staleRecordingMs: 35_000,
  behindOnMs: 3_000,
  behindOffMs: 1_000,
  echoToleranceMs: 1_000,
};

/** Marks meetings as being recorded, across tabs (Web Locks: a closed or crashed tab releases its locks). */
export interface MeetingLocks {
  /** Held while this page records the meeting; returns the release function. */
  hold(meetingId: string): () => void;
  /** Ids of the meetings any tab is recording now, or null when that cannot be known. */
  held(): Promise<string[] | null>;
}

export interface MeetingDeps {
  pipeline: MeetingPipeline;
  createSpeakerEngine(): SpeakerEngineLike;
  /** Opens the browser's share picker. Called synchronously inside the Start click. */
  requestSystemAudio(): Promise<MediaStream>;
  store: TranscriptStore;
  /** getDisplayMedia exists (call audio can be captured at all). */
  canCaptureSystemAudio(): boolean;
  readPrefs?(): Partial<MeetingPrefs> | null;
  writePrefs?(prefs: MeetingPrefs): void;
  /** Ask the browser to protect site storage (transcripts) from eviction. Fire and forget. */
  requestPersistence?(): void;
  locks?: MeetingLocks;
  timing?: Partial<MeetingTiming>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DocSlot = 'meeting' | 'viewer';

/** A finalized segment with its audio, on its way to (or held back from) the speaker session. */
interface SpeakerJob {
  segmentId: string;
  source: AudioSourceKind;
  audio: Float32Array;
  startMs: number;
  endMs: number;
}

interface SessionContext {
  readonly docId: string;
  readonly sources: readonly AudioSourceKind[];
  session: TranscriptionSession | null;
  speaker: SpeakerSession | null;
  /** Stop was pressed (or the page is going away) before the session finished starting. */
  cancelled: boolean;
  activityClaimed: boolean;
  /** The shared tab/screen stream until the session owns it. */
  systemStream: MediaStream | null;
  /** Microphone lines held back from clustering until the call audio around them is final (echo check first). */
  deferred: Map<string, SpeakerJob>;
  /** Segment ids that got their final (late partials for them are ignored). */
  finalized: Set<string>;
  assignments: Set<Promise<void>>;
  latencies: number[];
  lastStats: LiveSessionStats | null;
  maxBacklogMs: number;
  autosaveTimer: ReturnType<typeof setInterval> | null;
  /** Releases the "being recorded" lock. */
  unlock: (() => void) | null;
  /** Speaker counts from the last Re-identify (the engine keeps capping live assignments to them); reused at Stop. */
  speakerCounts: Partial<Record<AudioSourceKind, number>> | null;
}

/** A save waiting in the queue; until it starts, newer saves of the same document replace its payload. */
interface WaitingSave {
  docId: string;
  state: DocState;
  done: Promise<void>;
}

class StartFailure extends Error {
  readonly problem: StartProblem;
  constructor(problem: StartProblem) {
    super(problem.message);
    this.problem = problem;
  }
}

const CANCELLED = new Error('cancelled');
const MAX_NOTICES = 6;
const PREFS_DEFAULT: MeetingPrefs = { sources: { mic: true, system: false }, showEcho: false };

/** Calls fn immediately, turning a synchronous throw into a rejected promise. */
function attempt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return fn();
  } catch (e) {
    return Promise.reject(e);
  }
}

function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  try {
    for (const track of stream.getTracks()) track.stop();
  } catch {
    // Already stopped.
  }
}

function errorName(e: unknown): string {
  return typeof e === 'object' && e !== null ? String((e as { name?: unknown }).name ?? '') : '';
}

function sessionStartProblem(e: unknown): StartProblem {
  const detail = errorMessage(e);
  switch (errorName(e)) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        title: 'Microphone access is blocked',
        message:
          'Allow the microphone for this site: click the lock icon at the left of Edge’s address bar → Permissions → ' +
          `Microphone → Allow, then press Start again. If the setting is greyed out, a policy blocks it. (${detail})`,
      };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return {
        title: 'No microphone found',
        message:
          'Connect or enable a microphone (Windows Settings → System → Sound → Input), or untick Microphone to transcribe ' +
          `call audio only. (${detail})`,
      };
    case 'NotReadableError':
    case 'AbortError':
      return {
        title: 'The microphone could not be opened',
        message: `Another app may be holding it, or Windows privacy settings block it (Settings → Privacy & security → Microphone). (${detail})`,
      };
    default:
      return { title: 'Could not start transcription', message: detail };
  }
}

function settle(tasks: Set<Promise<void>>, timeoutMs: number): Promise<void> {
  if (tasks.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void Promise.allSettled([...tasks]).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Rejects when `promise` takes longer than timeoutMs. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(timeoutMs / 1000)} s.`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function without(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
}

function idleSpeakerModel(): SpeakerModelState {
  return { phase: 'idle', progress: null, fileProgress: {}, loadStartedAt: null, record: null, error: null };
}

function newDocState(doc: TranscriptDoc, status: TranscriptStatus, save?: Partial<SaveState>): DocState {
  return {
    doc,
    status,
    save: { phase: 'idle', savedAt: null, error: null, ...save },
    pendingSpeakers: new Set(),
    canReidentify: false,
    reidentify: { running: false, error: null, doneAt: null },
  };
}

function withTranscript(doc: TranscriptDoc, patch: Partial<MeetingTranscript>): TranscriptDoc {
  return { ...doc, transcript: { ...doc.transcript, ...patch } };
}

export function defaultTitle(date: Date): string {
  return `Meeting ${date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class MeetingController {
  /** Per-source input level (RMS 0..1, ~20 updates/s) in its own stores, so only the meters re-render. */
  readonly levels: Record<AudioSourceKind, LevelStore> = { mic: createLevelStore(), system: createLevelStore() };
  readonly timing: MeetingTiming;
  private readonly deps: MeetingDeps;
  private snapshot: MeetingSnapshot;
  private readonly listeners = new Set<() => void>();
  private speakerEngine: SpeakerEngineLike | null = null;
  /** Meetings started on the loaded speaker model instance (ModelSummary.runsSinceLoad). */
  private speakerRuns = 0;
  private ctx: SessionContext | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly saveTimers: Partial<Record<DocSlot, ReturnType<typeof setTimeout>>> = {};
  private readonly waitingSaves: Partial<Record<DocSlot, WaitingSave>> = {};
  private nextNoticeId = 1;

  constructor(deps: MeetingDeps) {
    this.deps = deps;
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    let prefs: Partial<MeetingPrefs> | null = null;
    try {
      prefs = deps.readPrefs?.() ?? null;
    } catch {
      prefs = null;
    }
    this.snapshot = {
      sources: {
        mic: prefs?.sources?.mic ?? PREFS_DEFAULT.sources.mic,
        system: prefs?.sources?.system ?? PREFS_DEFAULT.sources.system,
      },
      showEcho: prefs?.showEcho ?? PREFS_DEFAULT.showEcho,
      speakerModel: idleSpeakerModel(),
      loading: false,
      loadError: null,
      phase: 'idle',
      startProblem: null,
      meeting: null,
      live: null,
      viewer: null,
      library: { items: [], recordingIds: null, loaded: false, loading: false, error: null },
      notices: [],
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): MeetingSnapshot => this.snapshot;

  private set(patch: Partial<MeetingSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private patchSlot(slot: DocSlot, fn: (d: DocState) => DocState): void {
    const current = this.snapshot[slot];
    if (!current) return;
    const next = fn(current);
    if (next !== current) this.set({ [slot]: next });
  }

  /** Patches the meeting document of `ctx` (ignored once another meeting replaced it). */
  private patchMeeting(ctx: SessionContext, fn: (d: DocState) => DocState): void {
    if (this.ctx !== ctx || this.snapshot.meeting?.doc.transcript.id !== ctx.docId) return;
    this.patchSlot('meeting', fn);
  }

  private patchLive(fn: (live: LiveState) => LiveState): void {
    const live = this.snapshot.live;
    if (!live) return;
    const next = fn(live);
    if (next !== live) this.set({ live: next });
  }

  private addNotice(tone: MeetingNotice['tone'], title: string, message: string, live = false): void {
    const notices = this.snapshot.notices;
    const existing = notices.find((n) => n.title === title && n.message === message);
    this.set({
      notices: existing
        ? notices.map((n) => (n === existing ? { ...n, count: n.count + 1 } : n))
        : [...notices, { id: this.nextNoticeId++, tone, title, message, count: 1, live }].slice(-MAX_NOTICES),
    });
  }

  readonly dismissNotice = (id: number): void => {
    this.set({ notices: this.snapshot.notices.filter((n) => n.id !== id) });
  };

  readonly clearStartProblem = (): void => {
    if (this.snapshot.startProblem) this.set({ startProblem: null });
  };

  // ----- lifecycle ---------------------------------------------------------

  /** Call from an effect; returns the cleanup. */
  readonly mount = (): (() => void) => {
    void this.refreshLibrary();
    const hasWindow = typeof window !== 'undefined';
    // Closing the tab mid-meeting loses at most the last few seconds (autosave), but ask first.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!this.ctx?.session) return;
      e.preventDefault();
      e.returnValue = '';
    };
    const onPageHide = () => {
      if (this.ctx?.session) this.autosave(this.ctx);
    };
    if (hasWindow) {
      window.addEventListener('beforeunload', onBeforeUnload);
      window.addEventListener('pagehide', onPageHide);
    }
    return () => {
      if (hasWindow) {
        window.removeEventListener('beforeunload', onBeforeUnload);
        window.removeEventListener('pagehide', onPageHide);
      }
      this.teardown();
    };
  };

  /** Releases devices, workers and timers. A running meeting stays saved as 'recording' (shown as interrupted later). */
  private teardown(): void {
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) {
      ctx.cancelled = true;
      this.stopAutosave(ctx);
      const session = ctx.session;
      ctx.session = null;
      if (session) attempt(() => session.stop()).catch((e) => console.error(e));
      stopStream(ctx.systemStream);
      try {
        ctx.speaker?.dispose();
      } catch (e) {
        console.error(e);
      }
      this.releaseActivity(ctx);
    }
    for (const slot of ['meeting', 'viewer'] as const) this.clearSaveTimer(slot);
    try {
      this.speakerEngine?.dispose();
    } catch (e) {
      console.error(e);
    }
    this.speakerEngine = null;
    for (const store of Object.values(this.levels)) store.set(0);
    this.set({ speakerModel: idleSpeakerModel(), loading: false });
  }

  /** "Clear model caches" (app controller): drop the speaker worker so the next load starts cold. */
  readonly resetSpeakerModel = (): void => {
    if (isSessionActive(this.snapshot.phase)) return;
    try {
      this.speakerEngine?.dispose();
    } catch (e) {
      console.error(e);
    }
    this.speakerEngine = null;
    this.set({ speakerModel: idleSpeakerModel() });
  };

  // ----- setup -------------------------------------------------------------

  private writePrefs(): void {
    try {
      this.deps.writePrefs?.({ sources: this.snapshot.sources, showEcho: this.snapshot.showEcho });
    } catch {
      // A per-browser convenience only.
    }
  }

  readonly setSource = (kind: AudioSourceKind, on: boolean): void => {
    if (isSessionActive(this.snapshot.phase) || this.snapshot.sources[kind] === on) return;
    this.set({ sources: { ...this.snapshot.sources, [kind]: on }, startProblem: null });
    this.writePrefs();
  };

  readonly setShowEcho = (showEcho: boolean): void => {
    if (this.snapshot.showEcho === showEcho) return;
    this.set({ showEcho });
    this.writePrefs();
  };

  get canCaptureSystemAudio(): boolean {
    try {
      return this.deps.canCaptureSystemAudio();
    } catch {
      return false;
    }
  }

  private speaker(): SpeakerEngineLike {
    return (this.speakerEngine ??= this.deps.createSpeakerEngine());
  }

  private patchSpeakerModel(patch: Partial<SpeakerModelState>): void {
    this.set({ speakerModel: { ...this.snapshot.speakerModel, ...patch } });
  }

  /**
   * One "Load models" action: Parakeet through the app controller (skipped when it is already loaded, e.g. by
   * the benchmark, so a settings change there does not trigger a reload), then the speaker model.
   */
  readonly loadModels = async (): Promise<void> => {
    if (this.snapshot.loading || isSessionActive(this.snapshot.phase)) return;
    const pipeline = this.deps.pipeline;
    this.set({ loading: true, loadError: null });
    try {
      let p = pipeline.getSnapshot();
      if (!p.environment) {
        this.set({ loadError: 'The environment is still being detected; try again in a moment.' });
        return;
      }
      if (p.models.parakeet.phase !== 'ready') {
        const blocker = loadBlocker(p);
        if (blocker) {
          this.set({ loadError: blocker });
          return;
        }
        await pipeline.loadModels(['parakeet']);
        p = pipeline.getSnapshot();
      }
      await this.loadSpeakerModel(p);
    } finally {
      this.set({ loading: false });
    }
  };

  private async loadSpeakerModel(p: PipelineSnapshot): Promise<void> {
    const engine = this.speaker();
    if (engine.isLoaded && this.snapshot.speakerModel.phase === 'ready') return;
    const { source, error } = resolveModelSource(p.settings);
    if (!source || !p.environment) {
      this.patchSpeakerModel({ phase: 'error', error: error ?? 'The environment is not detected yet.' });
      return;
    }
    const sink = createProgressSink((progress, fileProgress) => this.patchSpeakerModel({ progress, fileProgress }));
    this.patchSpeakerModel({ phase: 'loading', progress: null, fileProgress: {}, loadStartedAt: now(), error: null });
    try {
      const record = await engine.load({ backend: p.settings.backend, source, environment: p.environment, onProgress: sink.push });
      sink.close();
      if (record.loadKind !== 'session') this.speakerRuns = 0;
      this.patchSpeakerModel({ phase: 'ready', progress: null, fileProgress: {}, record, error: null });
    } catch (e) {
      sink.close();
      const message = errorMessage(e);
      this.patchSpeakerModel(
        engine.isLoaded
          ? { phase: 'ready', progress: null, fileProgress: {}, error: `Load failed; the previously loaded instance is still active. ${message}` }
          : { phase: 'error', progress: null, fileProgress: {}, record: null, error: message },
      );
    }
  }

  // ----- start -------------------------------------------------------------

  /**
   * Start button. Everything up to the share picker runs synchronously inside the click: browsers only open
   * getDisplayMedia's picker (and Chromium only allows audio capture) for a user gesture.
   */
  readonly start = (): void => {
    const pipeline = this.deps.pipeline;
    const p = pipeline.getSnapshot();
    const blocker = startBlocker(p, this.snapshot, this.canCaptureSystemAudio);
    if (blocker) {
      this.set({ startProblem: { title: 'Cannot start yet', message: blocker } });
      return;
    }
    const kinds = selectedSources(this.snapshot.sources, this.canCaptureSystemAudio);
    // 1. Call audio first, before anything that could await.
    const system = kinds.includes('system') ? attempt(() => this.deps.requestSystemAudio()) : null;
    // 2. Reserve the microphone and models (fails while a benchmark run or read-aloud playback is going).
    if (!pipeline.claimActivity('meeting')) {
      system?.then(stopStream, () => undefined);
      this.set({
        startProblem: {
          title: 'Cannot start',
          message: activityBlocker(pipeline.getSnapshot()) ?? 'Another mode is using the microphone and models.',
        },
      });
      return;
    }
    if (this.snapshot.phase === 'stopped') this.discardMeeting();
    const createdAt = new Date();
    const ctx: SessionContext = {
      docId: newRunId(),
      sources: kinds,
      session: null,
      speaker: null,
      cancelled: false,
      activityClaimed: true,
      systemStream: null,
      deferred: new Map(),
      finalized: new Set(),
      assignments: new Set(),
      latencies: [],
      lastStats: null,
      maxBacklogMs: 0,
      autosaveTimer: null,
      unlock: null,
      speakerCounts: null,
    };
    this.ctx = ctx;
    const doc = createDoc({
      id: ctx.docId,
      title: defaultTitle(createdAt),
      createdAt: createdAt.toISOString(),
      sources: kinds,
      models: {
        asr: summarizeModel(p.models.parakeet.record, p.models.parakeet.runsSinceLoad),
        speaker: this.speakerEngine?.isLoaded ? summarizeModel(this.speakerRecord(), this.speakerRuns) : null,
      },
      app: { version: APP_INFO.version, commit: APP_INFO.commit },
    });
    this.set({
      phase: 'starting',
      startProblem: null,
      notices: [],
      viewer: null,
      meeting: newDocState(doc, 'recording'),
      live: {
        startedAt: null,
        sources: kinds,
        ended: {},
        open: [],
        stats: null,
        maxBacklogMs: 0,
        behind: false,
        pausedAt: null,
        cancelling: false,
      },
    });
    void this.begin(ctx, system);
  };

  private speakerRecord(): ModelLoadRecord | null {
    return this.snapshot.speakerModel.record ?? this.speakerEngine?.loadRecord ?? null;
  }

  private async begin(ctx: SessionContext, system: Promise<MediaStream> | null): Promise<void> {
    try {
      if (system) {
        try {
          ctx.systemStream = await system;
        } catch (e) {
          // requestSystemAudio's messages already say what to do (share again with audio switched on).
          throw new StartFailure({ title: 'Call audio was not shared', message: errorMessage(e) });
        }
      }
      if (ctx.cancelled) throw CANCELLED;
      // The speaker session exists before the first final can arrive (abortStart disposes it on failure).
      const engine = this.speakerEngine;
      let speakerProblem: string | null = null;
      if (engine?.isLoaded) {
        try {
          ctx.speaker = engine.createSession();
        } catch (e) {
          speakerProblem = `The speaker session could not start: ${errorMessage(e)}`;
        }
      } else {
        speakerProblem = 'The speaker model is not loaded, so lines show “Unknown”. Load models before the next meeting to get speaker labels.';
      }
      const settings = this.deps.pipeline.getSnapshot().settings.asr;
      const sources: SessionSourceInput[] = ctx.sources.map((kind) =>
        kind === 'system' && ctx.systemStream ? { kind, stream: ctx.systemStream } : { kind },
      );
      let session: TranscriptionSession;
      try {
        session = await this.deps.pipeline.getAsrEngine().startSession(
          {
            sources,
            segmentation: {
              partialIntervalMs: settings.partialIntervalMs,
              minSilenceMs: settings.minSilenceMs,
              maxSegmentMs: settings.maxSegmentMs,
            },
          },
          this.callbacks(ctx),
        );
      } catch (e) {
        throw new StartFailure(sessionStartProblem(e));
      }
      ctx.session = session;
      ctx.systemStream = null; // the session owns the stream now (and stops it when it ends)
      if (ctx.cancelled) {
        ctx.session = null;
        await attempt(() => session.stop()).catch(() => undefined);
        throw CANCELLED;
      }

      if (ctx.speaker) this.speakerRuns++;
      if (speakerProblem) this.addNotice(ctx.speaker || engine?.isLoaded ? 'warn' : 'info', 'Speaker labels are off', speakerProblem);
      this.patchMeeting(ctx, (d) => ({ ...d, canReidentify: ctx.speaker !== null }));
      this.patchLive((live) => ({ ...live, startedAt: session.startedAt }));
      this.set({ phase: 'live' });
      ctx.autosaveTimer = setInterval(() => this.autosave(ctx), this.timing.autosaveMs);
      try {
        ctx.unlock = this.deps.locks?.hold(ctx.docId) ?? null;
        this.deps.requestPersistence?.();
      } catch {
        // Best effort: without the lock, other tabs fall back to the autosave heartbeat.
      }
      void this.persist('meeting'); // appears in the saved list right away
    } catch (e) {
      this.abortStart(ctx, e);
    }
  }

  private abortStart(ctx: SessionContext, e: unknown): void {
    stopStream(ctx.systemStream);
    ctx.systemStream = null;
    try {
      ctx.speaker?.dispose();
    } catch {
      // Nothing to keep.
    }
    ctx.speaker = null;
    this.releaseActivity(ctx);
    if (this.ctx !== ctx) return;
    this.ctx = null;
    for (const store of Object.values(this.levels)) store.set(0);
    const problem =
      e === CANCELLED ? null : e instanceof StartFailure ? e.problem : { title: 'Could not start the meeting', message: errorMessage(e) };
    this.set({ phase: 'idle', meeting: null, live: null, startProblem: problem });
  }

  /** The session is over: microphone and models go back to the app, and other tabs stop seeing it as recording. */
  private releaseActivity(ctx: SessionContext): void {
    const unlock = ctx.unlock;
    ctx.unlock = null;
    try {
      unlock?.();
    } catch {
      // Nothing to release.
    }
    if (!ctx.activityClaimed) return;
    ctx.activityClaimed = false;
    this.deps.pipeline.releaseActivity('meeting');
  }

  // ----- session events ----------------------------------------------------

  private callbacks(ctx: SessionContext): SessionCallbacks {
    const current = () => this.ctx === ctx;
    return {
      onSegmentStart: (e) => {
        if (!current() || ctx.finalized.has(e.segmentId)) return;
        this.upsertOpen({ segmentId: e.segmentId, source: e.source, startMs: e.startMs, text: '' });
      },
      onPartial: (e) => {
        if (!current() || ctx.finalized.has(e.segmentId)) return;
        this.upsertOpen({ segmentId: e.segmentId, source: e.source, startMs: e.startMs, text: e.text });
      },
      onFinal: (e) => {
        if (current()) this.onFinal(ctx, e);
      },
      onLevel: (source, rms) => {
        const phase = this.snapshot.phase;
        if (current() && (phase === 'live' || phase === 'starting')) this.levels[source]?.set(rms);
      },
      onStats: (s) => {
        if (current()) this.onStats(ctx, s);
      },
      onSourceEnded: (source, reason) => {
        if (current()) this.onSourceEnded(ctx, source, reason);
      },
      onError: (message) => {
        if (current()) this.addNotice('warn', 'Transcription problem', message);
      },
    };
  }

  private upsertOpen(open: OpenSegment): void {
    this.patchLive((live) => {
      const index = live.open.findIndex((o) => o.segmentId === open.segmentId);
      if (index >= 0) {
        const existing = live.open[index];
        if (existing.text === open.text && existing.startMs === open.startMs) return live;
        const list = live.open.slice();
        list[index] = open;
        return { ...live, open: list };
      }
      const list = [...live.open, open].sort((a, b) => a.startMs - b.startMs);
      return { ...live, open: list };
    });
  }

  private removeOpen(predicate: (o: OpenSegment) => boolean): void {
    this.patchLive((live) => (live.open.some(predicate) ? { ...live, open: live.open.filter((o) => !predicate(o)) } : live));
  }

  /** The call line(s) a microphone line repeats, or null. Only for meetings with call audio, never for lines the user touched. */
  private echoOf(ctx: SessionContext, doc: TranscriptDoc, mic: MeetingSegment): string | null {
    if (mic.source !== 'mic' || mic.echoOf !== null || mic.speakerManual || mic.originalText !== null) return null;
    if (!ctx.sources.includes('system')) return null;
    const tolerance = this.timing.echoToleranceMs;
    const calls = doc.transcript.segments.filter((s) => s.source === 'system' && overlapsWithin(s, mic, tolerance));
    return detectEcho(mic, calls, { toleranceMs: tolerance })?.echoOf ?? null;
  }

  /** A call segment that overlaps `mic` is still being spoken: its final text may still turn `mic` into an echo. */
  private callOpenAround(mic: { endMs: number }): boolean {
    const limit = mic.endMs + this.timing.echoToleranceMs;
    return this.snapshot.live?.open.some((o) => o.source === 'system' && o.startMs <= limit) ?? false;
  }

  /**
   * Held-back microphone lines whose call audio is final now (or all of them, with force): echoes are marked,
   * the rest go to the speaker session.
   */
  private releaseDeferred(ctx: SessionContext, doc: TranscriptDoc, pending: Set<string>, force: boolean): { doc: TranscriptDoc; send: SpeakerJob[] } {
    const send: SpeakerJob[] = [];
    for (const [id, job] of ctx.deferred) {
      const segment = findSegment(doc, id);
      if (!segment || segment.echoOf !== null) {
        ctx.deferred.delete(id);
        pending.delete(id);
        continue;
      }
      if (!force && this.callOpenAround(segment)) continue;
      ctx.deferred.delete(id);
      const echo = this.echoOf(ctx, doc, segment);
      if (echo) {
        doc = markEcho(doc, id, echo);
        pending.delete(id);
      } else {
        send.push(job);
      }
    }
    return { doc, send };
  }

  private onFinal(ctx: SessionContext, e: SegmentFinalEvent): void {
    ctx.finalized.add(e.segmentId);
    ctx.latencies.push(e.latencyMs);
    this.removeOpen((o) => o.segmentId === e.segmentId);
    const m = this.snapshot.meeting;
    if (!m || m.doc.transcript.id !== ctx.docId) return;
    let doc = m.doc;
    const pending = new Set(m.pendingSpeakers);
    const send: SpeakerJob[] = [];

    // Empty finals are noise that passed the voice detector: no line, and their audio is dropped.
    const text = cleanText(e.text);
    if (text) {
      const segment: MeetingSegment = {
        id: e.segmentId,
        source: e.source,
        startMs: e.startMs,
        endMs: e.endMs,
        text,
        words: e.words,
        speakerId: null,
        speakerConfidence: null,
        echoOf: null,
        speakerManual: false,
        originalText: null,
      };
      const job: SpeakerJob = { segmentId: e.segmentId, source: e.source, audio: e.audio, startMs: e.startMs, endMs: e.endMs };
      doc = addSegment(doc, segment);
      if (segment.source === 'mic') {
        const echo = this.echoOf(ctx, doc, segment);
        if (echo) doc = markEcho(doc, segment.id, echo);
        else if (ctx.sources.includes('system') && this.callOpenAround(segment)) ctx.deferred.set(segment.id, job);
        else send.push(job);
      } else {
        send.push(job);
        // Microphone lines around this call line may turn out to repeat it.
        const tolerance = this.timing.echoToleranceMs;
        for (const mic of doc.transcript.segments) {
          if (mic.source !== 'mic' || mic.echoOf !== null || !overlapsWithin(mic, segment, tolerance)) continue;
          const echo = this.echoOf(ctx, doc, mic);
          if (!echo) continue;
          doc = markEcho(doc, mic.id, echo);
          ctx.deferred.delete(mic.id);
          pending.delete(mic.id);
        }
      }
    }
    // Empty or not, a call segment that ended may release microphone lines held back for it.
    const released = this.releaseDeferred(ctx, doc, pending, false);
    doc = released.doc;
    send.push(...released.send);
    if (ctx.speaker) {
      for (const id of ctx.deferred.keys()) pending.add(id);
      for (const j of send) pending.add(j.segmentId);
    }

    this.patchMeeting(ctx, (d) => ({ ...d, doc, pendingSpeakers: pending }));
    for (const j of send) this.assignSpeaker(ctx, j);
  }

  private assignSpeaker(ctx: SessionContext, job: SpeakerJob): void {
    const speaker = ctx.speaker;
    if (!speaker) return;
    const task = attempt(() =>
      speaker.assign({ segmentId: job.segmentId, source: job.source, audio: job.audio, startMs: job.startMs, endMs: job.endMs }),
    ).then(
      (assignment) => {
        this.patchMeeting(ctx, (d) => {
          const doc = applyAssignment(d.doc, assignment);
          const pendingSpeakers = without(d.pendingSpeakers, job.segmentId);
          return doc === d.doc && pendingSpeakers === d.pendingSpeakers ? d : { ...d, doc, pendingSpeakers };
        });
        if (this.snapshot.phase === 'stopped') this.scheduleSave('meeting');
      },
      (e: unknown) => {
        this.patchMeeting(ctx, (d) => ({ ...d, pendingSpeakers: without(d.pendingSpeakers, job.segmentId) }));
        if (this.ctx === ctx) this.addNotice('warn', 'Speaker identification failed', errorMessage(e));
      },
    );
    ctx.assignments.add(task);
    void task.finally(() => ctx.assignments.delete(task));
  }

  private onStats(ctx: SessionContext, s: LiveSessionStats): void {
    ctx.lastStats = s;
    ctx.maxBacklogMs = Math.max(ctx.maxBacklogMs, s.backlogMs);
    this.patchLive((live) => ({
      ...live,
      stats: s,
      maxBacklogMs: ctx.maxBacklogMs,
      behind: live.behind ? catchUpMs(s) > this.timing.behindOffMs : catchUpMs(s) > this.timing.behindOnMs,
    }));
  }

  /**
   * A source ended on its own. Its segment in progress is still finalized by the session (that final releases any
   * microphone lines held back for it), so the live text stays until then; the rest of the meeting goes on.
   */
  private onSourceEnded(ctx: SessionContext, source: AudioSourceKind, reason: string): void {
    this.levels[source]?.set(0);
    this.patchLive((live) => ({ ...live, ended: { ...live.ended, [source]: reason } }));
    const remaining = ctx.sources.filter((s) => !this.snapshot.live?.ended[s]);
    const still = remaining.map((s) => SOURCE_LABEL[s].toLowerCase()).join(', ');
    this.addNotice(
      remaining.length > 0 ? 'warn' : 'info',
      `${SOURCE_LABEL[source]} stopped`,
      remaining.length > 0 ? `${reason} Still transcribing: ${still}.` : `${reason} No source is left, so the meeting was stopped.`,
      remaining.length > 0,
    );
    if (remaining.length === 0) this.stop();
  }

  // ----- pause / resume / stop ---------------------------------------------

  readonly pause = (): void => {
    const session = this.ctx?.session;
    if (!session || this.snapshot.phase !== 'live') return;
    try {
      session.pause();
    } catch (e) {
      this.addNotice('err', 'Pause failed', errorMessage(e), true);
      return;
    }
    for (const store of Object.values(this.levels)) store.set(0);
    this.patchLive((live) => ({ ...live, pausedAt: now() }));
    this.set({ phase: 'paused' });
  };

  readonly resume = (): void => {
    const session = this.ctx?.session;
    if (!session || this.snapshot.phase !== 'paused') return;
    try {
      session.resume();
    } catch (e) {
      this.addNotice('err', 'Resume failed', errorMessage(e), true);
      return;
    }
    this.patchLive((live) => ({ ...live, pausedAt: null }));
    this.set({ phase: 'live' });
  };

  /** Stop button (also: cancel while starting). */
  readonly stop = (): void => {
    const ctx = this.ctx;
    if (!ctx) return;
    const phase = this.snapshot.phase;
    if (phase === 'starting') {
      ctx.cancelled = true;
      this.patchLive((live) => ({ ...live, cancelling: true }));
      return;
    }
    if (phase !== 'live' && phase !== 'paused') return;
    this.set({ phase: 'stopping' });
    void this.finish(ctx);
  };

  private async finish(ctx: SessionContext): Promise<void> {
    const session = ctx.session;
    if (!session) return;
    const stoppedAt = now();
    this.stopAutosave(ctx);
    let stats: SessionStats | null = null;
    try {
      // Open segments are finalized first: their onFinal events arrive before this resolves.
      stats = await session.stop();
    } catch (e) {
      this.addNotice('err', 'Stopping the transcription failed', `${errorMessage(e)} The transcript so far is kept.`);
    }
    ctx.session = null;
    this.releaseActivity(ctx);
    for (const store of Object.values(this.levels)) store.set(0);
    if (this.ctx !== ctx) return;

    // Segments that never got a final are dropped; held-back microphone lines are decided against the final call text.
    this.removeOpen(() => true);
    const m = this.snapshot.meeting;
    if (m && m.doc.transcript.id === ctx.docId) {
      const pending = new Set(m.pendingSpeakers);
      const { doc, send } = this.releaseDeferred(ctx, m.doc, pending, true);
      this.patchMeeting(ctx, (d) => ({ ...d, doc, pendingSpeakers: pending }));
      for (const j of send) this.assignSpeaker(ctx, j);
    }
    // Let speaker assignments in flight land (bounded), so the saved transcript has its labels.
    await settle(ctx.assignments, this.timing.speakerSettleMs);
    if (this.ctx !== ctx) return;
    // One offline pass over the whole meeting gives the saved transcript the best labels (milliseconds of work).
    await this.reclusterAtStop(ctx);
    if (this.ctx !== ctx) return;

    const startedAt = this.snapshot.live?.startedAt ?? stoppedAt;
    const finalStats: SessionStats = stats
      ? { ...stats, speakerComputeMs: ctx.speaker ? ctx.speaker.computeMs : null }
      : this.provisionalStats(ctx);
    this.patchMeeting(ctx, (d) => ({
      ...d,
      status: 'complete',
      // Late assignments still land on their lines; until then they show Unknown rather than a placeholder.
      pendingSpeakers: new Set(),
      doc: withTranscript(d.doc, { durationMs: Math.max(0, stoppedAt - startedAt), stats: finalStats, updatedAt: new Date().toISOString() }),
    }));
    this.set({ phase: 'stopped', live: null, notices: this.snapshot.notices.filter((n) => !n.live) });
    await this.persist('meeting');
  }

  private async reclusterAtStop(ctx: SessionContext): Promise<void> {
    const speaker = ctx.speaker;
    if (!speaker) return;
    try {
      const counts = ctx.speakerCounts ? { speakersPerSource: ctx.speakerCounts } : undefined;
      const assignments = await withTimeout(speaker.recluster(counts), this.timing.speakerSettleMs, 'The speaker model');
      this.patchMeeting(ctx, (d) => ({
        ...d,
        doc: applyRecluster(d.doc, assignments),
        reidentify: { running: false, error: null, doneAt: new Date().toISOString() },
      }));
    } catch (e) {
      this.addNotice('warn', 'Final speaker re-identification failed', `${errorMessage(e)} The live speaker labels are kept.`);
    }
  }

  private provisionalStats(ctx: SessionContext): SessionStats {
    const s = ctx.lastStats;
    return {
      audioMs: s?.audioMs ?? {},
      asrComputeMs: s?.asrComputeMs ?? 0,
      rtf: s?.rtf ?? null,
      finalLatency: summarize(ctx.latencies),
      maxBacklogMs: ctx.maxBacklogMs,
      skippedPartials: s?.skippedPartials ?? 0,
      segments: s?.segments ?? ctx.latencies.length,
      speakerComputeMs: ctx.speaker ? ctx.speaker.computeMs : null,
    };
  }

  private stopAutosave(ctx: SessionContext): void {
    if (ctx.autosaveTimer !== null) clearInterval(ctx.autosaveTimer);
    ctx.autosaveTimer = null;
  }

  /** Every ~10 s while the meeting runs: duration and provisional stats, then save as 'recording' (also the heartbeat). */
  private autosave(ctx: SessionContext): void {
    if (this.ctx !== ctx || !ctx.session) return;
    const startedAt = this.snapshot.live?.startedAt;
    this.patchMeeting(ctx, (d) => ({
      ...d,
      doc: withTranscript(d.doc, {
        durationMs: startedAt == null ? 0 : Math.max(0, now() - startedAt),
        stats: this.provisionalStats(ctx),
        updatedAt: new Date().toISOString(),
      }),
    }));
    void this.persist('meeting');
  }

  /** Back to the setup after a stopped meeting. Its speaker session (needed for re-identification) is released. */
  readonly newMeeting = (): void => {
    if (this.snapshot.phase !== 'stopped') return;
    if (this.saveTimers.meeting) void this.persist('meeting');
    this.discardMeeting();
  };

  private discardMeeting(): void {
    const ctx = this.ctx;
    if (ctx && !ctx.session) {
      try {
        ctx.speaker?.dispose();
      } catch {
        // Nothing to keep.
      }
      ctx.speaker = null;
      this.ctx = null;
    }
    this.clearSaveTimer('meeting');
    this.set({ phase: 'idle', meeting: null, live: null, notices: [] });
  }

  // ----- speakers ----------------------------------------------------------

  /** Re-cluster every line of this page's meeting, optionally with known speaker counts per source. */
  readonly reidentify = async (speakersPerSource?: Partial<Record<AudioSourceKind, number>>): Promise<void> => {
    const ctx = this.ctx;
    const speaker = ctx?.speaker;
    const m = this.snapshot.meeting;
    if (!ctx || !speaker || !m || m.doc.transcript.id !== ctx.docId || m.reidentify.running) return;
    this.patchMeeting(ctx, (d) => ({ ...d, reidentify: { ...d.reidentify, running: true, error: null } }));
    try {
      const chosen = speakersPerSource && Object.keys(speakersPerSource).length > 0 ? speakersPerSource : null;
      // With counts the engine also caps later live assignments; without, it goes back to its similarity threshold.
      ctx.speakerCounts = chosen;
      const assignments = await speaker.recluster(chosen ? { speakersPerSource: chosen } : undefined);
      this.patchMeeting(ctx, (d) => {
        let doc = applyRecluster(d.doc, assignments);
        const stats = doc.transcript.stats;
        if (stats) doc = withTranscript(doc, { stats: { ...stats, speakerComputeMs: speaker.computeMs } });
        return { ...d, doc, reidentify: { running: false, error: null, doneAt: new Date().toISOString() } };
      });
      this.scheduleSave('meeting');
    } catch (e) {
      this.patchMeeting(ctx, (d) => ({ ...d, reidentify: { ...d.reidentify, running: false, error: errorMessage(e) } }));
    }
  };

  private slotOf(docId: string): DocSlot | null {
    if (this.snapshot.viewer?.doc.transcript.id === docId) return 'viewer';
    if (this.snapshot.meeting?.doc.transcript.id === docId) return 'meeting';
    return null;
  }

  /** Applies a user edit to the document with this id (meeting or opened transcript) and saves it shortly after. */
  private edit(docId: string, fn: (doc: TranscriptDoc) => TranscriptDoc, after?: (d: DocState) => DocState): void {
    const slot = this.slotOf(docId);
    if (!slot) return;
    let changed = false;
    this.patchSlot(slot, (d) => {
      const doc = fn(d.doc);
      if (doc === d.doc) return d;
      changed = true;
      const next = { ...d, doc: withTranscript(doc, { updatedAt: new Date().toISOString() }) };
      return after ? after(next) : next;
    });
    if (changed) this.scheduleSave(slot);
  }

  readonly renameSpeaker = (docId: string, speakerId: string, name: string): void => {
    this.edit(docId, (doc) => renameSpeaker(doc, speakerId, name));
  };

  readonly mergeSpeakers = (docId: string, fromId: string, intoId: string): void => {
    this.edit(docId, (doc) => mergeSpeakers(doc, fromId, intoId));
  };

  readonly reassignSegment = (docId: string, segmentId: string, target: SpeakerTarget): void => {
    this.edit(
      docId,
      (doc) => reassignSegment(doc, segmentId, target),
      (d) => ({ ...d, pendingSpeakers: without(d.pendingSpeakers, segmentId) }),
    );
  };

  readonly editSegmentText = (docId: string, segmentId: string, text: string): void => {
    this.edit(docId, (doc) => editSegmentText(doc, segmentId, text));
  };

  /** Title of the meeting, an opened transcript, or any saved one in the list. */
  readonly setTitle = async (docId: string, title: string): Promise<void> => {
    const clean = cleanTitle(title);
    if (!clean) return;
    if (this.slotOf(docId)) {
      this.edit(docId, (doc) => setTitle(doc, clean));
      return;
    }
    try {
      const summary = await this.enqueue(() => this.deps.store.rename(docId, clean));
      if (summary) this.upsertLibrary(summary);
    } catch (e) {
      this.patchLibrary({ error: `Renaming failed: ${storageErrorMessage(e)}` });
    }
  };

  // ----- saving ------------------------------------------------------------

  /** Storage writes run one at a time, in order, so an older save can never overwrite a newer one. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.saveQueue.then(task);
    this.saveQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private clearSaveTimer(slot: DocSlot): void {
    const timer = this.saveTimers[slot];
    if (timer !== undefined) clearTimeout(timer);
    delete this.saveTimers[slot];
  }

  private patchSave(slot: DocSlot, docId: string, patch: Partial<SaveState>): void {
    this.patchSlot(slot, (d) => (d.doc.transcript.id === docId ? { ...d, save: { ...d.save, ...patch } } : d));
  }

  private scheduleSave(slot: DocSlot): void {
    const state = this.snapshot[slot];
    if (!state) return;
    this.clearSaveTimer(slot);
    if (state.save.phase !== 'saving') this.patchSave(slot, state.doc.transcript.id, { phase: 'pending' });
    this.saveTimers[slot] = setTimeout(() => {
      delete this.saveTimers[slot];
      void this.persist(slot);
    }, this.timing.editSaveDelayMs);
  }

  /**
   * Saves the slot's document as it is now. Failures show on the document (and are retried with the next save).
   * A save still waiting in the queue just takes the newer document, so slow storage never piles up writes.
   */
  private persist(slot: DocSlot): Promise<void> {
    this.clearSaveTimer(slot);
    const state = this.snapshot[slot];
    if (!state) return Promise.resolve();
    const docId = state.doc.transcript.id;
    this.patchSave(slot, docId, { phase: 'saving' });
    const waiting = this.waitingSaves[slot];
    if (waiting && waiting.docId === docId) {
      waiting.state = state;
      return waiting.done;
    }
    const job: WaitingSave = { docId, state, done: Promise.resolve() };
    this.waitingSaves[slot] = job;
    job.done = this.enqueue(async () => {
      if (this.waitingSaves[slot] === job) delete this.waitingSaves[slot]; // started: later changes queue a new save
      const { transcript } = job.state.doc;
      try {
        const summary = await this.deps.store.put(transcript, job.state.status);
        const phase = this.saveTimers[slot] || this.waitingSaves[slot] ? 'pending' : 'saved';
        this.patchSave(slot, docId, { phase, savedAt: new Date().toISOString(), error: null });
        this.upsertLibrary(summary);
      } catch (e) {
        this.patchSave(slot, docId, { phase: 'error', error: storageErrorMessage(e) });
      }
    });
    return job.done;
  }

  // ----- saved transcripts -------------------------------------------------

  private patchLibrary(patch: Partial<MeetingSnapshot['library']>): void {
    this.set({ library: { ...this.snapshot.library, ...patch } });
  }

  private upsertLibrary(summary: TranscriptSummary): void {
    const items = this.snapshot.library.items.filter((i) => i.id !== summary.id);
    this.patchLibrary({ items: sortSummaries([...items, summary]) });
  }

  readonly refreshLibrary = async (): Promise<void> => {
    this.patchLibrary({ loading: true });
    try {
      const [items, recordingIds] = await Promise.all([this.deps.store.list(), this.recordingIds()]);
      this.patchLibrary({ items, recordingIds, loaded: true, loading: false, error: null });
    } catch (e) {
      this.patchLibrary({ loaded: true, loading: false, error: `Saved transcripts could not be read: ${storageErrorMessage(e)}` });
    }
  };

  private async recordingIds(): Promise<string[] | null> {
    try {
      return (await this.deps.locks?.held()) ?? null;
    } catch {
      return null;
    }
  }

  /** Opens a saved transcript (read-only view with speaker renames and text corrections). Not while a meeting runs. */
  readonly openSaved = async (id: string): Promise<void> => {
    if (isSessionActive(this.snapshot.phase)) return;
    if (this.snapshot.meeting?.doc.transcript.id === id) {
      this.closeViewer();
      return;
    }
    try {
      const stored = await this.deps.store.get(id);
      if (!stored) {
        this.patchLibrary({ error: 'That transcript no longer exists.' });
        void this.refreshLibrary();
        return;
      }
      if (isSessionActive(this.snapshot.phase)) return;
      if (this.saveTimers.viewer) void this.persist('viewer');
      // A 'recording' entry that is opened here belongs to a meeting that was cut off.
      const status: TranscriptStatus = stored.summary.status === 'recording' ? 'interrupted' : stored.summary.status;
      this.set({ viewer: newDocState(docFromTranscript(stored.transcript), status, { phase: 'saved', savedAt: stored.summary.updatedAt }) });
    } catch (e) {
      this.patchLibrary({ error: `Opening the transcript failed: ${storageErrorMessage(e)}` });
    }
  };

  readonly closeViewer = (): void => {
    if (!this.snapshot.viewer) return;
    if (this.saveTimers.viewer) void this.persist('viewer');
    this.set({ viewer: null });
  };

  /** The full transcript for an export: from the screen when it is open, otherwise from storage. */
  readonly loadTranscript = async (id: string): Promise<MeetingTranscript> => {
    const slot = this.slotOf(id);
    const state = slot ? this.snapshot[slot] : null;
    if (state) return state.doc.transcript;
    const stored = await this.deps.store.get(id);
    if (!stored) throw new Error('That transcript no longer exists.');
    return stored.transcript;
  };

  /**
   * "Refine with Teams transcript": a new saved transcript with our words and Teams' speaker names and turns
   * (lib/transcripts/teams/refine.ts). The transcript it starts from is not changed. Not while it is recording.
   * Rejects with a RefineError (not the same meeting, nothing to match) or a storage error.
   */
  readonly refineWithTeams = async (
    docId: string,
    teams: ParsedTeamsTranscript,
    options: { includeTeamsOnly: boolean },
    onProgress?: (progress: RefineProgress | { phase: 'saving'; fraction: number }) => void,
  ): Promise<{ id: string; title: string; refinement: TranscriptRefinement }> => {
    if (this.snapshot.meeting?.doc.transcript.id === docId && isSessionActive(this.snapshot.phase)) {
      throw new Error('Stop the meeting first.');
    }
    const original = await this.loadTranscript(docId);
    const result = await refineWithTeams(original, teams, {
      id: newRunId(),
      includeTeamsOnly: options.includeTeamsOnly,
      onProgress,
      pause: yieldToPage,
    });
    onProgress?.({ phase: 'saving', fraction: 0 });
    try {
      const summary = await this.enqueue(() => this.deps.store.put(result.transcript, 'complete'));
      this.upsertLibrary(summary);
    } catch (e) {
      throw new Error(`The refined transcript could not be saved: ${storageErrorMessage(e)}`);
    }
    return { id: result.transcript.id, title: result.transcript.title, refinement: result.refinement };
  };

  /** Deletes a saved transcript (the page asks for confirmation first). The running meeting cannot be deleted. */
  readonly deleteSaved = async (id: string): Promise<void> => {
    const m = this.snapshot.meeting;
    if (m?.doc.transcript.id === id && isSessionActive(this.snapshot.phase)) return;
    for (const slot of ['meeting', 'viewer'] as const) {
      if (this.snapshot[slot]?.doc.transcript.id === id) this.clearSaveTimer(slot);
    }
    try {
      // Queued behind any save of the same transcript, so a save in flight cannot bring it back.
      await this.enqueue(() => this.deps.store.delete(id));
      this.patchLibrary({ items: this.snapshot.library.items.filter((i) => i.id !== id), error: null });
      if (this.snapshot.viewer?.doc.transcript.id === id) this.set({ viewer: null });
      if (this.snapshot.meeting?.doc.transcript.id === id && this.snapshot.phase === 'stopped') this.discardMeeting();
    } catch (e) {
      this.patchLibrary({ error: `Deleting failed: ${storageErrorMessage(e)}` });
    }
  };

  /** Id of this page's meeting while it is running (the saved list marks it). */
  get runningMeetingId(): string | null {
    return isSessionActive(this.snapshot.phase) ? (this.snapshot.meeting?.doc.transcript.id ?? null) : null;
  }
}
/** Rough time the transcriber needs to work through its queue; before any pass has run, assume real time. */
function catchUpMs(s: LiveSessionStats): number {
  return s.backlogMs * (s.rtf ?? 1);
}

/** Meeting-mode state shared by the controller and the meeting panels, and what each state allows. */
import type { LiveSessionStats } from '@localspeech/speech-to-text';
import type { TranscriptDoc } from '@/lib/transcripts/model';
import type { TranscriptStatus, TranscriptSummary } from '@/lib/transcripts/types';
import type { AudioSourceKind, LoadProgress, ModelLoadRecord } from '@/lib/types';
import { ACTIVITY_NAMES, isRunActive, type FileProgress, type PipelineSnapshot } from '../pipeline/state';

export type MeetingPhase = 'idle' | 'starting' | 'live' | 'paused' | 'stopping' | 'stopped';

export type SourceSelection = Record<AudioSourceKind, boolean>;

/** Fixed order: microphone first. */
export const SOURCE_ORDER: readonly AudioSourceKind[] = ['mic', 'system'];

export const SOURCE_LABEL: Record<AudioSourceKind, string> = { mic: 'Microphone', system: 'Call audio' };

export interface SpeakerModelState {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  progress: LoadProgress | null;
  fileProgress: Record<string, FileProgress>;
  loadStartedAt: number | null;
  /** Result of the latest successful load() (a 'session' record when the instance was reused). */
  record: ModelLoadRecord | null;
  error: string | null;
}

/** A segment still being spoken: its live partial text. */
export interface OpenSegment {
  segmentId: string;
  source: AudioSourceKind;
  startMs: number;
  text: string;
}

export interface LiveState {
  /** now() when the session started (segment times are relative to it); null while starting. */
  startedAt: number | null;
  sources: AudioSourceKind[];
  /** Sources that ended on their own, with the reason. */
  ended: Partial<Record<AudioSourceKind, string>>;
  /** Segments still being spoken, by start time. */
  open: OpenSegment[];
  stats: LiveSessionStats | null;
  maxBacklogMs: number;
  /** Backlog went past ~5 s and has not come back under ~2 s: this machine can't keep up. */
  behind: boolean;
  pausedAt: number | null;
  /** Stop was pressed while the session was still starting. */
  cancelling: boolean;
}

export interface SaveState {
  /** 'pending' = changed, saving shortly. */
  phase: 'idle' | 'pending' | 'saving' | 'saved' | 'error';
  /** ISO time of the last successful save. */
  savedAt: string | null;
  error: string | null;
}

export interface ReidentifyState {
  running: boolean;
  error: string | null;
  /** ISO time of the last successful re-identification. */
  doneAt: string | null;
}

/** A transcript on screen: this page's meeting (live or stopped), or a saved one opened from the list. */
export interface DocState {
  doc: TranscriptDoc;
  status: TranscriptStatus;
  save: SaveState;
  /** Lines waiting for their speaker (placeholder chip). */
  pendingSpeakers: ReadonlySet<string>;
  /** Re-identification needs the meeting's speaker session (its embeddings), so only this page's latest meeting has it. */
  canReidentify: boolean;
  reidentify: ReidentifyState;
}

export interface LibraryState {
  items: TranscriptSummary[];
  /** Ids of meetings some tab of this app is recording right now (Web Locks); null when that cannot be known. */
  recordingIds: readonly string[] | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

export interface MeetingNotice {
  id: number;
  tone: 'info' | 'warn' | 'err';
  title: string;
  message: string;
  /** Repeats of the same notice are counted instead of listed. */
  count: number;
  /** Only meaningful while the meeting runs (e.g. a source that stopped); cleared at Stop. */
  live: boolean;
}

export interface StartProblem {
  title: string;
  message: string;
}

export interface MeetingSnapshot {
  /** Sources picked for the next meeting (remembered per browser). */
  sources: SourceSelection;
  /** Show microphone lines hidden as echo duplicates of the call audio. */
  showEcho: boolean;
  speakerModel: SpeakerModelState;
  /** "Load models" in progress (Parakeet through the app controller, then the speaker model). */
  loading: boolean;
  loadError: string | null;
  phase: MeetingPhase;
  startProblem: StartProblem | null;
  meeting: DocState | null;
  live: LiveState | null;
  viewer: DocState | null;
  library: LibraryState;
  notices: MeetingNotice[];
}

/** The sources a Start would use: call audio only where the browser can capture it. */
export function selectedSources(sources: SourceSelection, canCaptureSystemAudio: boolean): AudioSourceKind[] {
  return SOURCE_ORDER.filter((k) => sources[k] && (k !== 'system' || canCaptureSystemAudio));
}

export function isSessionActive(phase: MeetingPhase): boolean {
  return phase === 'starting' || phase === 'live' || phase === 'paused' || phase === 'stopping';
}

/** Why the app can't hand the microphone and models to a meeting right now (benchmark run, read aloud, loading). */
export function activityBlocker(p: PipelineSnapshot): string | null {
  if (p.activity && p.activity !== 'meeting') return `Stop ${ACTIVITY_NAMES[p.activity]} first (Read aloud tab).`;
  if (p.startPending || isRunActive(p.run)) {
    return 'A benchmark run is in progress. Let it finish (or cancel it) on the Benchmark tab, then start the meeting.';
  }
  if (p.loading) return 'Models are loading. Start once they are ready.';
  if (p.clearing) return 'Model caches are being cleared.';
  return null;
}

export function startBlocker(p: PipelineSnapshot, m: MeetingSnapshot, canCaptureSystemAudio: boolean): string | null {
  if (isSessionActive(m.phase)) return 'A meeting is already running.';
  if (selectedSources(m.sources, canCaptureSystemAudio).length === 0) {
    return m.sources.system ? 'This browser cannot capture call audio (no screen sharing). Choose the microphone.' : 'Choose at least one audio source.';
  }
  if (!p.environment) return 'Detecting the environment…';
  if (m.loading) return 'Wait for the models to finish loading.';
  const busy = activityBlocker(p);
  if (busy) return busy;
  if (p.models.parakeet.phase !== 'ready') return 'Load the models first.';
  return null;
}

export type SummaryState = 'recording-here' | 'recording-elsewhere' | 'interrupted' | 'complete';

/**
 * How a saved entry should read: this page's running meeting, a meeting another tab is recording, or one that was
 * cut off (page closed, reloaded or crashed mid-meeting: still 'recording' in storage, but nobody records it).
 * A recording tab holds a Web Lock per meeting (released by the browser when the tab goes away); without that
 * information (recordingIds null), an entry that is still being saved every few seconds counts as recording.
 */
export function summaryState(
  s: TranscriptSummary,
  runningMeetingId: string | null,
  recordingIds: readonly string[] | null,
  nowMs: number,
  staleMs: number,
): SummaryState {
  if (s.id === runningMeetingId) return 'recording-here';
  if (s.status !== 'recording') return s.status;
  if (recordingIds) return recordingIds.includes(s.id) ? 'recording-elsewhere' : 'interrupted';
  return nowMs - s.savedAtMs < staleMs ? 'recording-elsewhere' : 'interrupted';
}

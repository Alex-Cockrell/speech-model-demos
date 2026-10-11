'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { requestSystemAudio } from '@localspeech/speech-to-text';
import { requestPersistentStorage } from '@localspeech/core';
import { SpeakerEngine } from '@/lib/speakers/engine';
import { createIndexedDbTranscriptStore } from '@/lib/transcripts/store';
import type { PipelineController } from '../pipeline/controller';
import { MeetingController, type MeetingLocks, type MeetingPrefs } from './controller';

const PREFS_KEY = 'speech-poc:meeting:v1';
const LOCK_PREFIX = 'speech-poc:meeting-recording:';

function readPrefs(): Partial<MeetingPrefs> | null {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const v = value as { sources?: { mic?: unknown; system?: unknown }; showEcho?: unknown };
    return {
      sources:
        typeof v.sources?.mic === 'boolean' && typeof v.sources?.system === 'boolean'
          ? { mic: v.sources.mic, system: v.sources.system }
          : undefined,
      showEcho: typeof v.showEcho === 'boolean' ? v.showEcho : undefined,
    };
  } catch {
    return null;
  }
}

function writePrefs(prefs: MeetingPrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Per-browser convenience only.
  }
}

/** One Web Lock per meeting being recorded; the browser releases it when the tab closes, reloads or crashes. */
function meetingLocks(): MeetingLocks | undefined {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return undefined;
  return {
    hold(meetingId) {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      locks.request(LOCK_PREFIX + meetingId, () => held).catch(() => undefined);
      return release;
    },
    async held() {
      try {
        const { held = [] } = await locks.query();
        return held
          .map((lock) => lock.name ?? '')
          .filter((name) => name.startsWith(LOCK_PREFIX))
          .map((name) => name.slice(LOCK_PREFIX.length));
      } catch {
        return null;
      }
    },
  };
}

function createMeetingController(pipeline: PipelineController): MeetingController {
  return new MeetingController({
    pipeline,
    createSpeakerEngine: () => new SpeakerEngine(),
    requestSystemAudio,
    store: createIndexedDbTranscriptStore(),
    canCaptureSystemAudio: () => typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function',
    readPrefs,
    writePrefs,
    requestPersistence: () => {
      void requestPersistentStorage();
    },
    locks: meetingLocks(),
  });
}

/** One meeting controller per app (the view stays mounted while other tabs are open, so a meeting keeps running). */
export function useMeeting(pipeline: PipelineController) {
  const [controller] = useState(() => createMeetingController(pipeline));
  useEffect(() => controller.mount(), [controller]);
  useEffect(() => pipeline.onCachesCleared(controller.resetSpeakerModel), [pipeline, controller]);
  const meeting = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return { meeting, controller };
}

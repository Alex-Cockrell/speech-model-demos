'use client';

import type { RunError, RunStage } from './pipeline/state';
import { Notice } from './ui';

const STAGE_TITLE: Record<RunStage, string> = {
  microphone: 'Microphone',
  asr: 'ASR',
  tts: 'TTS',
  privacy: 'Privacy check incomplete',
};

/** Run errors for one section of the dashboard. Every error also lands in the run's benchmark record. */
export function RunErrors({ errors }: { errors: readonly RunError[] }) {
  if (errors.length === 0) return null;
  return (
    <>
      {errors.map((e, i) => (
        <Notice key={`${e.stage}-${i}`} tone={e.stage === 'privacy' ? 'warn' : 'err'} title={STAGE_TITLE[e.stage]}>
          {e.message}
        </Notice>
      ))}
    </>
  );
}

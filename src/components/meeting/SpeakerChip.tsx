'use client';

import type { MeetingSpeaker } from '@/lib/transcripts/types';
import type { AudioSourceKind } from '@/lib/types';
import { cx } from '../ui';
import { speakerSlot } from './format';
import { SourceIcon } from './icons';
import styles from './Meeting.module.css';

/** Speaker color dot: palette slot by speaker number; hollow when there is no speaker. */
export function SpeakerDot({ number, hollow }: { number?: number | null; hollow?: boolean }) {
  const slot = hollow ? 0 : speakerSlot(number);
  return <span className={cx(styles.dot, hollow && styles.dotUnknown, slot > 0 && styles[`spk${slot}`])} aria-hidden="true" />;
}

/**
 * Who said a line: color dot, name and source icon. 'pending' while the speaker is being identified, 'echo' for
 * a hidden duplicate of the call audio, 'live' for text still being spoken.
 */
export function SpeakerChip({
  speaker,
  source,
  state,
  onClick,
  expanded,
}: {
  speaker: MeetingSpeaker | null;
  source: AudioSourceKind;
  state?: 'pending' | 'echo' | 'live';
  onClick?: () => void;
  expanded?: boolean;
}) {
  const label =
    state === 'pending'
      ? 'Identifying…'
      : state === 'echo'
        ? 'Duplicate'
        : state === 'live'
          ? source === 'mic'
            ? 'Microphone'
            : 'Call'
          : (speaker?.name ?? 'Unknown');
  const named = !state && speaker !== null;
  const className = cx(styles.speaker, state === 'pending' && styles.chipPending, !named && state !== 'pending' && styles.chipMuted);
  const content = (
    <>
      {state === 'pending' ? <SpeakerDot /> : <SpeakerDot number={speaker?.number} hollow={!named} />}
      <span className={styles.speakerName}>{label}</span>
      <SourceIcon source={source} className={styles.sourceIcon} />
    </>
  );
  if (!onClick) {
    return (
      <span className={className} title={label}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      aria-expanded={expanded}
      title={`${label}: rename, or move this line to another speaker`}
    >
      {content}
    </button>
  );
}

'use client';

import type { PipelineController } from '../pipeline/controller';
import type { PipelineSnapshot } from '../pipeline/state';
import type { MeetingController } from './controller';
import { DocPanel } from './DocPanel';
import { LockIcon } from './icons';
import { SavedPanel } from './SavedPanel';
import { SetupPanel } from './SetupPanel';
import { SpeakersPanel } from './SpeakersPanel';
import type { MeetingSnapshot } from './state';
import { useMeeting } from './useMeeting';
import styles from './Meeting.module.css';

/**
 * Meeting transcription: microphone and/or call audio → live transcript with speaker labels → saved in this
 * browser → exported. Orchestration lives in MeetingController (./controller.ts); the components only render it.
 */
export function MeetingView({ snapshot, controller }: { snapshot: PipelineSnapshot; controller: PipelineController }) {
  const { meeting, controller: meetingController } = useMeeting(controller);
  return <MeetingLayout pipeline={snapshot} meeting={meeting} controller={meetingController} />;
}

export function MeetingLayout({ pipeline: p, meeting: m, controller: c }: { pipeline: PipelineSnapshot; meeting: MeetingSnapshot; controller: MeetingController }) {
  const backend = p.models.parakeet.record?.resolvedBackend ?? null;
  const showSetup = !m.viewer && (m.meeting === null || m.phase === 'idle' || m.phase === 'starting');
  const shown = m.viewer ?? (showSetup ? null : m.meeting);

  return (
    <main className={styles.layout}>
      <div className={styles.column}>
        {m.viewer ? (
          <DocPanel kind="saved" state={m.viewer} meeting={m} controller={c} backend={backend} />
        ) : showSetup || !m.meeting ? (
          <SetupPanel pipeline={p} meeting={m} controller={c} />
        ) : (
          <DocPanel kind="meeting" state={m.meeting} meeting={m} controller={c} backend={backend} />
        )}
      </div>
      <aside className={styles.column} aria-label="Speakers and saved transcripts">
        {shown && <SpeakersPanel state={shown} isMeeting={shown === m.meeting} controller={c} />}
        <SavedPanel meeting={m} controller={c} />
        <div className={styles.privacy}>
          <LockIcon className={styles.privacyIcon} />
          <p>
            <strong>Audio stays on this device.</strong> It is transcribed in this browser and never uploaded. Transcripts are
            stored only in this browser profile (clearing model caches keeps them); export one to keep a copy elsewhere.
          </p>
        </div>
      </aside>
    </main>
  );
}

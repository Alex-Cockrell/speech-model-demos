'use client';

import { useEffect, useId, useState } from 'react';
import { errorMessage } from '@/lib/benchmark/errors';
import { EXPORT_FORMATS, exportFileName, exportTranscript, formatInfo, type ExportFormat } from '@/lib/transcripts/export';
import type { MeetingTranscript } from '@/lib/transcripts/types';
import { copyText } from '../clipboard';
import { downloadText } from './download';
import { plural } from './format';
import styles from './Meeting.module.css';
import ui from '../ui.module.css';

type Status = { kind: 'idle' | 'copied' | 'downloaded' } | { kind: 'error'; message: string };

/**
 * Format, Copy, Download; hidden echo duplicates are left out unless included here. Lines inserted from a Teams
 * transcript (refined copies) are included, marked, unless left out here.
 */
export function ExportControls({
  load,
  echoLines,
  teamsLines = 0,
}: {
  load: () => Promise<MeetingTranscript>;
  echoLines: number;
  teamsLines?: number;
}) {
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [includeEcho, setIncludeEcho] = useState(false);
  const [includeTeamsOnly, setIncludeTeamsOnly] = useState(true);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const formatId = useId();

  useEffect(() => {
    if (status.kind !== 'copied' && status.kind !== 'downloaded') return;
    const timer = setTimeout(() => setStatus({ kind: 'idle' }), 1800);
    return () => clearTimeout(timer);
  }, [status]);

  const run = async (action: (t: MeetingTranscript, text: string) => Promise<void> | void, done: Status) => {
    try {
      const transcript = await load();
      await action(transcript, exportTranscript(transcript, format, { includeEcho, includeTeamsOnly }));
      setStatus(done);
    } catch (e) {
      setStatus({ kind: 'error', message: errorMessage(e) });
    }
  };

  return (
    <div className={styles.export}>
      <label htmlFor={formatId} className={styles.check}>
        Export
      </label>
      <select id={formatId} value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
        {EXPORT_FORMATS.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label} (.{f.extension})
          </option>
        ))}
      </select>
      <button type="button" onClick={() => void run((_, text) => copyText(text), { kind: 'copied' })}>
        {status.kind === 'copied' ? 'Copied ✓' : 'Copy'}
      </button>
      <button
        type="button"
        onClick={() =>
          void run((t, text) => downloadText(exportFileName(t.title, format), text, formatInfo(format).mime), { kind: 'downloaded' })
        }
      >
        {status.kind === 'downloaded' ? 'Downloaded ✓' : 'Download'}
      </button>
      {echoLines > 0 && (
        <label className={styles.check} title="Microphone lines that repeat the call audio (hidden in the transcript)">
          <input type="checkbox" checked={includeEcho} onChange={(e) => setIncludeEcho(e.target.checked)} />
          Include {plural(echoLines, 'duplicate line')}
        </label>
      )}
      {teamsLines > 0 && (
        <label className={styles.check} title="Lines inserted from the Teams transcript where this recording has no words; marked in the export">
          <input type="checkbox" checked={includeTeamsOnly} onChange={(e) => setIncludeTeamsOnly(e.target.checked)} />
          Include {plural(teamsLines, 'line')} from Teams
        </label>
      )}
      {status.kind === 'error' && (
        <span className={ui.inlineError} role="alert">
          Export failed: {status.message}
        </span>
      )}
    </div>
  );
}

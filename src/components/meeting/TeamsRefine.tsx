'use client';

import { useDeferredValue, useId, useMemo, useRef, useState, type DragEvent } from 'react';
import { errorMessage } from '@/lib/benchmark/errors';
import { TeamsFileError, parseTeamsFile, parseTeamsText } from '@/lib/transcripts/teams/parse';
import { RefineError, type RefineErrorCode, type RefinePhase } from '@/lib/transcripts/teams/refine';
import type { ParsedTeamsTranscript, TeamsInputKind, TeamsLayout } from '@/lib/transcripts/teams/types';
import type { MeetingTranscript, TranscriptRefinement } from '@/lib/transcripts/types';
import { fmtMs, fmtPct } from '../format';
import { Kv, KvList, Meter, Notice, cx } from '../ui';
import type { MeetingController } from './controller';
import { fmtDuration, plural } from './format';
import { LockIcon } from './icons';
import styles from './Meeting.module.css';
import panels from '../panels.module.css';

const INPUT_LABEL: Record<TeamsInputKind, string> = {
  paste: 'Pasted text',
  txt: 'Text file',
  vtt: 'Subtitle file (.vtt)',
  docx: 'Word document (.docx)',
};

const LAYOUT_LABEL: Record<TeamsLayout, string> = {
  'speaker-time': 'name and time lines',
  'timed-blocks': 'timed blocks (older Teams download)',
  webvtt: 'subtitle cues',
};

type Phase = RefinePhase | 'saving';

const PHASE_LABEL: Record<Phase, string> = {
  matching: 'Finding passages both transcripts share…',
  aligning: 'Aligning the words…',
  speakers: 'Assigning speakers and splitting lines…',
  saving: 'Saving the refined copy…',
};

/** Share of the whole run each phase starts at (alignment is the long part). */
const PHASE_START: Record<Phase, number> = { matching: 0, aligning: 0.1, speakers: 0.8, saving: 0.96 };
const PHASE_END: Record<Phase, number> = { matching: 0.1, aligning: 0.8, speakers: 0.96, saving: 1 };

const ERROR_TITLE: Record<RefineErrorCode, string> = {
  'not-same-meeting': 'Not the same meeting',
  'no-teams-text': 'Nothing to match',
  'no-teams-speakers': 'No speaker names',
  'no-words': 'Nothing to refine',
};

type Run =
  | { kind: 'idle' }
  | { kind: 'running'; phase: Phase; fraction: number }
  | { kind: 'done'; id: string; title: string; refinement: TranscriptRefinement }
  | { kind: 'error'; title: string; message: string };

const ACCEPT = '.txt,.vtt,.docx,text/plain,text/vtt,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * "Refine with Teams transcript" for a stopped or saved transcript: paste the Teams transcript or open its
 * download, check what was read, refine. The result is a new saved transcript; this one stays as it is.
 */
export function TeamsRefine({ transcript: t, controller: c }: { transcript: MeetingTranscript; controller: MeetingController }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [file, setFile] = useState<{ name: string; parsed: ParsedTeamsTranscript } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [includeTeamsOnly, setIncludeTeamsOnly] = useState(true);
  const [run, setRun] = useState<Run>({ kind: 'idle' });
  const fileInput = useRef<HTMLInputElement>(null);
  const textId = useId();
  const headingId = useId();

  const deferredText = useDeferredValue(text);
  const pasted = useMemo(() => (deferredText.trim() ? parseTeamsText(deferredText) : null), [deferredText]);
  const parsed = file ? file.parsed : pasted;
  const running = run.kind === 'running';
  const canRun = !running && !reading && parsed !== null && parsed.turns.length > 0 && parsed.speakers.length > 0;

  const resetResult = () => {
    if (run.kind === 'done' || run.kind === 'error') setRun({ kind: 'idle' });
  };

  const readFile = async (f: File) => {
    setReading(true);
    setFileError(null);
    resetResult();
    try {
      const parsedFile = await parseTeamsFile(f.name, new Uint8Array(await f.arrayBuffer()));
      setFile({ name: f.name, parsed: parsedFile });
    } catch (e) {
      setFile(null);
      setFileError(e instanceof TeamsFileError ? e.message : `The file could not be read: ${errorMessage(e)}`);
    } finally {
      setReading(false);
    }
  };

  const refine = async () => {
    if (!parsed || !canRun) return;
    setRun({ kind: 'running', phase: 'matching', fraction: 0 });
    try {
      const result = await c.refineWithTeams(t.id, parsed, { includeTeamsOnly }, (p) =>
        setRun({ kind: 'running', phase: p.phase, fraction: PHASE_START[p.phase] + (PHASE_END[p.phase] - PHASE_START[p.phase]) * p.fraction }),
      );
      setRun({ kind: 'done', ...result });
    } catch (e) {
      setRun(
        e instanceof RefineError
          ? { kind: 'error', title: ERROR_TITLE[e.code], message: e.message }
          : { kind: 'error', title: 'Refining failed', message: errorMessage(e) },
      );
    }
  };

  const hasDraggable = (e: DragEvent) => e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/plain');

  if (!open) {
    return (
      <div className={styles.refineCollapsed}>
        <button type="button" onClick={() => setOpen(true)} aria-expanded={false}>
          Refine with Teams transcript…
        </button>
        <span className={panels.hint}>Wrong or merged speakers? Use the speaker names from the Teams transcript of this meeting.</span>
      </div>
    );
  }

  return (
    <section
      className={cx(styles.refine, dragging && styles.refineDragging)}
      aria-labelledby={headingId}
      onDragOver={(e) => {
        if (running || !hasDraggable(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (running) return;
        e.preventDefault();
        setDragging(false);
        const dropped = e.dataTransfer.files[0];
        if (dropped) {
          void readFile(dropped);
          return;
        }
        const droppedText = e.dataTransfer.getData('text/plain');
        if (droppedText) {
          setFile(null);
          setFileError(null);
          setText(droppedText);
          resetResult();
        }
      }}
    >
      <div className={styles.refineHead}>
        <h3 id={headingId} className={styles.refineTitle}>
          Refine with Teams transcript
        </h3>
        <button type="button" onClick={() => setOpen(false)} disabled={running} aria-expanded={true}>
          Close
        </button>
      </div>
      <p className={styles.refineIntro}>
        Teams hears each participant&rsquo;s microphone separately, so its speaker names are right even where its words are not.
        Refining keeps this transcript&rsquo;s words and timing, takes the speaker names and turns from Teams, and splits lines where
        the speaker changes. The result is saved as a new transcript; this one stays as it is.
      </p>
      <details className={panels.details} open={!parsed}>
        <summary>How to get the Teams transcript</summary>
        <ol className={styles.refineSteps}>
          <li>
            In Teams, open the meeting&rsquo;s chat (or its calendar entry), then <strong>Recap</strong> &rarr; <strong>Transcript</strong>.
            Transcription must have been on during the meeting.
          </li>
          <li>
            Click in the transcript, select all (Ctrl+A), copy (Ctrl+C) and paste it below; or use <strong>Download</strong> and open the
            .docx or .vtt file here (or drop it on this panel).
          </li>
          <li>For long meetings the transcript pane may copy only the part it has loaded; if lines are missing, use the download.</li>
        </ol>
      </details>

      {file ? (
        <div className={styles.fileChip}>
          <span>
            File: <strong>{file.name}</strong>
          </span>
          <button type="button" className={styles.linkButton} onClick={() => setFile(null)} disabled={running}>
            Remove
          </button>
        </div>
      ) : (
        <div className={styles.refineInput}>
          <label htmlFor={textId} className={styles.sectionTitle}>
            Teams transcript
          </label>
          <textarea
            id={textId}
            className={styles.pasteArea}
            value={text}
            disabled={running}
            spellCheck={false}
            placeholder={'Paste the Teams transcript here, e.g.\nAlice Smith   0:03\nOkay, let’s get started.'}
            onChange={(e) => {
              setText(e.target.value);
              resetResult();
            }}
          />
        </div>
      )}
      <div className={styles.refineActions}>
        <button type="button" onClick={() => fileInput.current?.click()} disabled={running || reading}>
          {reading ? 'Reading…' : 'Open file…'}
        </button>
        <span className={panels.hint}>.txt, .vtt or .docx</span>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void readFile(f);
          }}
        />
      </div>
      {fileError && (
        <Notice tone="err" title="This file cannot be used">
          {fileError}
        </Notice>
      )}
      {parsed && <ParsePreview parsed={parsed} />}

      <label className={styles.check}>
        <input type="checkbox" checked={includeTeamsOnly} disabled={running} onChange={(e) => setIncludeTeamsOnly(e.target.checked)} />
        Add lines only Teams heard (people talking over each other), marked &ldquo;from Teams&rdquo;
      </label>
      <div className={styles.refineActions}>
        <button type="button" className={panels.primaryButton} onClick={() => void refine()} disabled={!canRun}>
          {running ? 'Refining…' : 'Refine'}
        </button>
        {!parsed && !file && <span className={panels.hint}>Paste the transcript or open a file first.</span>}
      </div>
      {run.kind === 'running' && (
        <div className={styles.refineProgress} aria-live="polite">
          <Meter fraction={run.fraction} label="Refining" />
          <span className={panels.hint}>{PHASE_LABEL[run.phase]}</span>
        </div>
      )}
      {run.kind === 'error' && (
        <Notice tone="err" title={run.title}>
          {run.message}
        </Notice>
      )}
      {run.kind === 'done' && (
        <div className={styles.refineDone} aria-live="polite">
          <Notice tone="ok" title="Refined copy saved">
            &ldquo;{run.title}&rdquo; is in Saved transcripts. This transcript is unchanged.
          </Notice>
          <RefinementFacts refinement={run.refinement} />
          <div className={styles.refineActions}>
            <button type="button" className={panels.primaryButton} onClick={() => void c.openSaved(run.id)}>
              Open refined transcript
            </button>
          </div>
        </div>
      )}
      <p className={styles.refinePrivacy}>
        <LockIcon className={styles.privacyIcon} />
        <span>Nothing is uploaded: the Teams transcript is read and matched in this browser.</span>
      </p>
    </section>
  );
}

/** Time of day for clock-time transcripts (ms since midnight; past midnight wraps). */
function clockOfDay(ms: number): string {
  const minutes = Math.floor((((ms % 86_400_000) + 86_400_000) % 86_400_000) / 60_000);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

function spanText(parsed: ParsedTeamsTranscript): string {
  const first = parsed.turns[0];
  const last = parsed.turns[parsed.turns.length - 1];
  const end = last.endMs ?? last.startMs;
  return parsed.clockTimes ? `${clockOfDay(first.startMs)} – ${clockOfDay(end)}` : `${fmtDuration(first.startMs)} – ${fmtDuration(end)}`;
}

const MAX_NAMES = 12;

function ParsePreview({ parsed }: { parsed: ParsedTeamsTranscript }) {
  if (parsed.turns.length === 0) {
    return (
      <Notice tone="err" title="No Teams transcript found">
        No lines with a speaker name and a time were recognized. Paste the text copied from the Teams transcript (names with times such as
        &ldquo;0:03&rdquo;), or open the .docx or .vtt file Teams downloads.
      </Notice>
    );
  }
  const names = parsed.speakers.slice(0, MAX_NAMES);
  return (
    <div className={styles.preview} aria-live="polite">
      <KvList>
        <Kv label="Read as">
          {INPUT_LABEL[parsed.input]}
          {parsed.layout ? ` · ${LAYOUT_LABEL[parsed.layout]}` : ''}
        </Kv>
        <Kv label="Turns">{parsed.turns.length}</Kv>
        <Kv label="Time span">{spanText(parsed)}</Kv>
        <Kv label="Speakers">{parsed.speakers.length > 0 ? parsed.speakers.length : 'none'}</Kv>
      </KvList>
      {names.length > 0 && (
        <ul className={styles.previewSpeakers} aria-label="Speakers in the Teams transcript">
          {names.map((n) => (
            <li key={n}>{n}</li>
          ))}
          {parsed.speakers.length > MAX_NAMES && <li>+{parsed.speakers.length - MAX_NAMES} more</li>}
        </ul>
      )}
      {parsed.speakers.length === 0 && (
        <Notice tone="err" title="No speaker names">
          The transcript has no speaker names, so it cannot fix the speakers. Teams names speakers when transcription runs in the meeting.
        </Notice>
      )}
      {parsed.warnings.length > 0 && (
        <Notice tone="warn" title={plural(parsed.warnings.length, 'note')}>
          <ul className={panels.compactList}>
            {parsed.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}
    </div>
  );
}

/** "Teams started transcribing 37.4 s before this recording", with clock drift when it matters. */
export function describeOffset(r: TranscriptRefinement): string {
  let text: string;
  if (r.clockTimes) {
    text = `This recording started at ${clockOfDay(-r.offsetMs)} by the Teams clock`;
  } else {
    const abs = Math.abs(r.offsetMs);
    const amount = abs < 120_000 ? `${(abs / 1000).toFixed(1)} s` : fmtDuration(abs);
    text =
      abs < 500
        ? 'Teams and this recording started together'
        : r.offsetMs < 0
          ? `Teams started transcribing ${amount} before this recording`
          : `Teams started transcribing ${amount} after this recording began`;
  }
  if (Math.abs(r.driftMsPerHour) >= 500) text += `; the clocks drift ${(Math.abs(r.driftMsPerHour) / 1000).toFixed(1)} s per hour`;
  return text;
}

export function RefinementFacts({ refinement: r }: { refinement: TranscriptRefinement }) {
  return (
    <KvList>
      <Kv label="Speakers from Teams">{r.speakers}</Kv>
      <Kv label="Words matched" hint="our words found in the Teams transcript">
        {fmtPct(r.wordsMatched)}
      </Kv>
      <Kv label="Lines split" hint="the speaker changed inside them">
        {r.segmentsSplit}
      </Kv>
      <Kv label="Lines added from Teams" hint="words only Teams heard">
        {r.teamsOnlyInserted}
      </Kv>
      <Kv label="Speaker uncertain" hint="few matching words; check these">
        {plural(r.lowConfidence, 'line')}
      </Kv>
      {r.outsideTeams > 0 && (
        <Kv label="Outside the Teams transcript" hint="kept their earlier speaker">
          {plural(r.outsideTeams, 'line')}
        </Kv>
      )}
      {r.correctionsSpread + r.correctionsKeptInFirstPiece > 0 && (
        <Kv label="Corrected lines split" hint={r.correctionsKeptInFirstPiece > 0 ? 'some corrections kept whole in the first piece' : 'corrections follow their words'}>
          {r.correctionsSpread + r.correctionsKeptInFirstPiece}
        </Kv>
      )}
      <Kv label="Timing">{describeOffset(r)}</Kv>
      <Kv label="Matched passages">
        {r.anchorsUsed} of {r.anchorsFound}
      </Kv>
      <Kv label="Time taken">{fmtMs(r.elapsedMs)}</Kv>
    </KvList>
  );
}

/** On a refined copy: where its speakers came from. */
export function RefinementInfo({ refinement: r }: { refinement: TranscriptRefinement }) {
  return (
    <details className={cx(panels.details, styles.refinedInfo)}>
      <summary>
        Speakers refined with the Teams transcript ({r.fileName ?? 'pasted text'}) from &ldquo;{r.fromTitle}&rdquo;
      </summary>
      <p className={panels.hint}>
        Names and turns come from Teams; words and timing from this recording. Lines marked &ldquo;speaker uncertain&rdquo; had few words
        matching that speaker in Teams; lines marked &ldquo;from Teams&rdquo; are words only Teams heard.
      </p>
      <RefinementFacts refinement={r} />
    </details>
  );
}

'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import { errorMessage } from '@/lib/benchmark/errors';
import { SPEED_RANGE, VOICES, voiceName } from '@/lib/benchmark/settings';
import { now } from '@localspeech/core';
import { MAX_SOURCE_CHARS, detectFormat, formatForFileName, parseDocument, type FormatChoice, type ReadDocument } from '@localspeech/text-to-speech';
import { planReading, type ReadingPlan, type SplitMode } from '@localspeech/text-to-speech';
import { DEFAULT_READ_AHEAD_SEC, ReadAloudSession, type ReaderPosition, type ReaderSnapshot } from '@localspeech/text-to-speech';
import type { PipelineController } from '../pipeline/controller';
import { pendingChanges } from '../pipeline/selectors';
import { isRunActive, loadBlocker, type ModelState, type PipelineSnapshot } from '../pipeline/state';
import type { TtsSettings } from '@/lib/types';
import { fileLabel, fmtBytes } from '../format';
import { Chip, Field, Meter, Notice, Panel, Segmented, SelectField, cx, useTicker } from '../ui';
import { KeepUpNotice, ReadAloudMetrics, fmtDuration } from './ReadAloudMetrics';
import { ReaderText, type ReaderCommand } from './ReaderText';
import { SHORT_SAMPLE, longSample } from './sample';
import styles from './ReadAloud.module.css';

interface Props {
  snapshot: PipelineSnapshot;
  controller: PipelineController;
}

/** A parsed and planned document, tied to the inputs it was built from. */
interface Prepared {
  source: string;
  format: FormatChoice;
  split: SplitMode;
  doc: ReadDocument;
  plan: ReadingPlan;
  /** charStart[i] = displayed characters before piece i (progress bar). */
  charStart: Float64Array;
}

interface NoticeState {
  tone: 'ok' | 'warn' | 'err' | 'info';
  title: string;
  text?: string;
}

const FORMAT_OPTIONS: readonly { value: FormatChoice; label: string; title?: string }[] = [
  { value: 'auto', label: 'Auto', title: 'Markdown when the text looks like Markdown' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'plain', label: 'Plain text' },
];

const SPLIT_OPTIONS: readonly { value: SplitMode; label: string; title: string }[] = [
  { value: 'sentence', label: 'Sentences', title: 'Whole sentences; long ones split at clauses. Best prosody.' },
  { value: 'clause', label: 'Clauses', title: 'Also split at , ; : — for earlier first audio on slow machines.' },
];

/** Characters per second of speech at speed 1, for the estimate shown before reading. */
const CHARS_PER_SEC = 14;
const MAX_FILE_BYTES = 5_000_000;
const PHASE_LABEL: Record<string, string> = {
  download: 'Downloading',
  initialize: 'Initializing',
  warmup: 'Warming up',
  ready: 'Ready',
  error: 'Error',
};

function prepare(source: string, format: FormatChoice, split: SplitMode): Prepared | null {
  const doc = parseDocument(source, format);
  const plan = planReading(doc.blocks, { split });
  if (plan.pieces.length === 0) return null;
  const charStart = new Float64Array(plan.pieces.length + 1);
  plan.pieces.forEach((p, i) => {
    charStart[i + 1] = charStart[i] + p.chars;
  });
  return { source, format, split, doc, plan, charStart };
}

function kokoroReady(controller: PipelineController): boolean {
  return controller.getSnapshot().models.kokoro.phase === 'ready' && controller.getTtsEngine().isLoaded;
}

/** Why claimActivity('readaloud') said no. */
function refusalReason(s: PipelineSnapshot): string {
  if (s.activity === 'meeting') return 'Meeting transcription is running. Stop it on the Meeting tab first: only one mode can use the models and audio at a time.';
  if (s.loading) return 'Models are loading. Try again when loading has finished.';
  if (s.clearing) return 'Model caches are being cleared.';
  if (s.startPending || isRunActive(s.run)) return 'A benchmark run is in progress on the Benchmark tab. Wait for it to finish.';
  return 'Another mode is using the models and audio output.';
}

function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function fileStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

const noSubscribe = () => () => undefined;
const noSnapshot = () => null;

function useReaderSnapshot(session: ReadAloudSession | null): ReaderSnapshot | null {
  return useSyncExternalStore(session?.subscribe ?? noSubscribe, session?.getSnapshot ?? noSnapshot, session?.getSnapshot ?? noSnapshot);
}

/** Latest-value ref, so handlers passed to memoised children stay stable. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * Read aloud: paste a document or a generated response (or open a .txt/.md file) and Kokoro reads it with
 * streaming playback, sentence highlighting, pause/resume and seeking. Generation runs a bounded distance
 * ahead of playback (lib/tts/reader.ts); everything stays in this browser.
 */
export function ReadAloudView({ snapshot: s, controller }: Props) {
  const fileInputId = useId();
  const voiceSpeedId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState('');
  const [format, setFormat] = useState<FormatChoice>('auto');
  const [fileName, setFileName] = useState<string | null>(null);
  const [view, setView] = useState<'edit' | 'read'>('edit');
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [cursor, setCursor] = useState(0);
  const [session, setSession] = useState<ReadAloudSession | null>(null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'starting'>('idle');
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [play, setPlay] = useState<{ clickedAt: number; loadMs: number | null } | null>(null);
  const [dragging, setDragging] = useState(false);
  const busy = useRef(false);

  const tts = s.settings.tts;
  const kokoro = s.models.kokoro;
  const record = kokoro.instanceRecord ?? kokoro.record;
  const reader = useReaderSnapshot(session);
  const status = reader?.status ?? null;
  const live = status === 'playing' || status === 'paused';
  useTicker(live, 200);
  const position: ReaderPosition | null = session && reader ? session.position() : null;
  const plan = prepared?.plan ?? null;

  // ---- session lifecycle -------------------------------------------------

  // Release the shared activity whenever the session ends, however it ends (session in the deps: two sessions
  // in a row can end with the same status).
  useEffect(() => {
    if (status === 'ended' || status === 'stopped' || status === 'error') controller.releaseActivity('readaloud');
    if (status === 'ended') setCursor(0);
  }, [session, status, controller]);

  const sessionRef = useLatest(session);
  useEffect(
    () => () => {
      sessionRef.current?.stop();
      controller.releaseActivity('readaloud');
    },
    [controller, sessionRef],
  );

  // Voice and speed are the shared TTS settings; a running session applies them from the next piece.
  useEffect(() => {
    if (session && live) session.setVoiceAndSpeed(tts.voice, tts.speed);
  }, [session, live, tts.voice, tts.speed]);

  // ---- playback ----------------------------------------------------------

  const stateRef = useLatest({ prepared, source, format, cursor, split: tts.split });

  /** Play: everything before the first await runs inside the click (audio unlock, autoplay policy). */
  const startReading = useCallback(
    async (fromSentence: number | null) => {
      if (busy.current) return;
      const engine = controller.getTtsEngine();
      try {
        engine.unlockAudio();
      } catch (e) {
        setNotice({ tone: 'err', title: 'Audio output could not be started', text: errorMessage(e) });
        return;
      }
      busy.current = true;
      const clickedAt = now();
      setNotice(null);
      let claimed = false;
      try {
        const st = stateRef.current;
        let ready = st.prepared;
        if (!ready || ready.source !== st.source || ready.format !== st.format || ready.split !== st.split) {
          ready = prepare(st.source, st.format, st.split);
          setPrepared(ready);
        }
        if (!ready) {
          setNotice({ tone: 'info', title: 'Nothing to read', text: 'Paste some text, open a .txt or .md file, or insert a sample.' });
          return;
        }
        setView('read');
        const sentence = Math.min(Math.max(0, fromSentence ?? st.cursor), ready.plan.sentences.length - 1);
        setCursor(sentence);

        let loadMs: number | null = null;
        if (!kokoroReady(controller)) {
          const blocker = loadBlocker(controller.getSnapshot());
          if (blocker) {
            setNotice({ tone: 'warn', title: 'The voice model cannot be loaded right now', text: blocker });
            return;
          }
          setPhase('loading');
          const loadStart = now();
          // loadModels refuses while an activity is claimed, so the model is loaded before claiming.
          await controller.loadModels(['kokoro']);
          loadMs = now() - loadStart;
          if (!kokoroReady(controller)) {
            setNotice({
              tone: 'err',
              title: 'The voice model could not be loaded',
              text: controller.getSnapshot().models.kokoro.error ?? loadBlocker(controller.getSnapshot()) ?? 'The load did not complete.',
            });
            return;
          }
          // The text may have been edited while the model loaded: do not read the old version.
          if (stateRef.current.source !== st.source || stateRef.current.format !== st.format) return;
        }

        if (!controller.claimActivity('readaloud')) {
          setNotice({ tone: 'warn', title: 'Read aloud cannot start right now', text: refusalReason(controller.getSnapshot()) });
          return;
        }
        claimed = true;
        setPhase('starting');
        const output = await controller.getTtsEngine().outputContext();
        const current = controller.getSnapshot().settings.tts;
        sessionRef.current?.stop();
        const next = new ReadAloudSession({
          ctx: output,
          backend: controller.getTtsEngine(),
          pieces: ready.plan.pieces,
          startPiece: ready.plan.sentences[sentence].firstPiece,
          voice: current.voice,
          speed: current.speed,
        });
        setPlay({ clickedAt, loadMs });
        setSession(next);
        next.start();
        claimed = false; // the session owns the activity now; the status effect releases it
      } catch (e) {
        setNotice({ tone: 'err', title: 'Read aloud could not start', text: errorMessage(e) });
      } finally {
        if (claimed) controller.releaseActivity('readaloud');
        busy.current = false;
        setPhase('idle');
      }
    },
    [controller, sessionRef, stateRef],
  );

  const positionRef = useLatest({ session, live, status, plan });

  /** The sentence being read right now, from the audio clock (null when not playing). */
  const sentenceNow = useCallback((): number | null => {
    const { session: current, live: isLive, plan: p } = positionRef.current;
    const piece = current && isLive ? current.position().piece : null;
    return p && piece !== null ? (p.pieces[piece]?.sentence ?? null) : null;
  }, [positionRef]);

  const togglePlay = useCallback(() => {
    const { session: current, status: st } = positionRef.current;
    if (current && st === 'playing') current.pause();
    else if (current && st === 'paused') current.resume(); // resume() restarts audio inside this click
    else void startReading(null);
  }, [positionRef, startReading]);

  const stop = useCallback(() => {
    const { session: current, live: isLive } = positionRef.current;
    if (!current || !isLive) return;
    const at = sentenceNow();
    if (at !== null) setCursor(at);
    current.stop();
  }, [positionRef, sentenceNow]);

  const seekSentence = useCallback(
    (index: number) => {
      const { session: current, live: isLive, plan: p } = positionRef.current;
      if (!p) return;
      const target = Math.min(Math.max(0, index), p.sentences.length - 1);
      setCursor(target);
      if (current && isLive) current.seek(p.sentences[target].firstPiece);
    },
    [positionRef],
  );

  const step = useCallback(
    (delta: number) => {
      const at = sentenceNow() ?? stateRef.current.cursor;
      seekSentence(at + delta);
    },
    [sentenceNow, seekSentence, stateRef],
  );

  const onSentence = useCallback(
    (index: number) => {
      if (positionRef.current.live) seekSentence(index);
      else void startReading(index);
    },
    [positionRef, seekSentence, startReading],
  );

  const onCommand = useCallback(
    (command: ReaderCommand) => {
      if (command === 'toggle') togglePlay();
      else step(command === 'prev' ? -1 : 1);
    },
    [togglePlay, step],
  );

  const backToEdit = () => {
    session?.stop();
    setView('edit');
  };

  const preview = () => {
    const ready = prepare(source, format, tts.split);
    if (!ready) {
      setNotice({ tone: 'info', title: 'Nothing to read', text: 'Paste some text, open a .txt or .md file, or insert a sample.' });
      return;
    }
    setNotice(null);
    setPrepared(ready);
    setCursor(0);
    setView('read');
  };

  // ---- input ---------------------------------------------------------------

  const replaceText = (text: string, name: string | null, fileFormat: FormatChoice) => {
    session?.stop();
    setSource(text);
    setFileName(name);
    setFormat(fileFormat);
    setPrepared(null);
    setCursor(0);
    setView('edit');
  };

  const openFile = (file: File) => {
    const knownFormat = formatForFileName(file.name);
    if (!knownFormat && !file.type.startsWith('text/')) {
      setNotice({ tone: 'warn', title: 'Unsupported file', text: `${file.name} is not a .txt or .md file.` });
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setNotice({ tone: 'warn', title: 'File too large', text: `${file.name} is ${fmtBytes(file.size)}; this prototype reads files up to ${fmtBytes(MAX_FILE_BYTES)}.` });
      return;
    }
    const fileReader = new FileReader();
    fileReader.onload = () => {
      const text = String(fileReader.result ?? '');
      if (text.length > MAX_SOURCE_CHARS) {
        setNotice({ tone: 'warn', title: 'File too long', text: `${file.name} has ${text.length.toLocaleString()} characters; the limit is ${MAX_SOURCE_CHARS.toLocaleString()}.` });
        return;
      }
      setNotice(null);
      replaceText(text, file.name, knownFormat ?? 'auto');
    };
    fileReader.onerror = () => setNotice({ tone: 'err', title: 'Could not read the file', text: errorMessage(fileReader.error) });
    // Read locally; nothing is uploaded.
    fileReader.readAsText(file);
  };

  const onFileChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) openFile(file);
  };

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!dragging) setDragging(true);
  };
  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) openFile(file);
  };

  // ---- derived display -----------------------------------------------------

  const detected = useMemo(() => (source.trim() ? detectFormat(source) : null), [source]);
  const words = useMemo(() => (source.match(/\S+/g) ?? []).length, [source]);
  const pending = useMemo(() => pendingChanges(s.models, s.settings).kokoro.filter((p) => !p.startsWith('Voice')), [s.models, s.settings]);
  const appliedVoice = kokoro.applied?.settings.voice ?? null;
  const activeSentence = live && plan && position?.piece != null ? (plan.pieces[position.piece]?.sentence ?? null) : null;
  const waiting = live && position !== null && (position.starting || position.stalledSec !== null);
  const sentenceCount = plan?.sentences.length ?? 0;
  const shownSentence = activeSentence ?? (plan ? Math.min(cursor, sentenceCount - 1) : null);
  const progress =
    prepared && position && position.piece !== null
      ? (prepared.charStart[position.piece] + position.pieceProgress * prepared.plan.pieces[position.piece].chars) / prepared.charStart[prepared.plan.pieces.length]
      : status === 'ended'
        ? 1
        : null;
  const busyStarting = phase !== 'idle';
  const loadBlock = loadBlocker(s);
  const playLabel = status === 'playing' ? 'Pause' : status === 'paused' ? 'Resume' : busyStarting ? 'Starting…' : 'Play';

  let statusLine: { text: string; warn?: boolean };
  if (phase === 'loading') statusLine = { text: 'Loading the voice model…' };
  else if (phase === 'starting') statusLine = { text: 'Starting audio…' };
  else if (status === 'error') statusLine = { text: 'Stopped by an error', warn: true };
  else if (live && reader?.pausedReason === 'audio-suspended') statusLine = { text: 'The browser suspended audio output: press Resume', warn: true };
  else if (status === 'paused') statusLine = { text: `Paused at sentence ${(activeSentence ?? 0) + 1} of ${sentenceCount}` };
  else if (live && position?.starting)
    statusLine = { text: `Preparing audio for sentence ${(activeSentence ?? 0) + 1}… ${position.generating ? `${(position.generating.elapsedMs / 1000).toFixed(1)} s` : ''}` };
  else if (live && position?.stalledSec != null)
    statusLine = { text: `Waiting for generation: ${position.stalledSec.toFixed(1)} s pause before sentence ${(activeSentence ?? 0) + 1}`, warn: true };
  else if (status === 'playing') statusLine = { text: `Reading sentence ${(activeSentence ?? 0) + 1} of ${sentenceCount}` };
  else if (status === 'ended') statusLine = { text: 'Finished' };
  else if (status === 'stopped') statusLine = { text: `Stopped · Play continues from sentence ${cursor + 1}` };
  else if (view === 'read' && plan) statusLine = { text: `${sentenceCount} sentences · Play starts at sentence ${cursor + 1}` };
  else statusLine = { text: source.trim() ? 'Ready to read' : 'Paste text or open a file to begin' };

  const notes = prepared?.doc.notes;
  const noteText = notes
    ? [
        prepared.doc.format === 'markdown' ? 'Markdown' : 'Plain text',
        notes.codeBlocks > 0 ? `${notes.codeBlocks} code block${notes.codeBlocks === 1 ? '' : 's'} announced, not read` : null,
        notes.tables > 0 ? `${notes.tables} table${notes.tables === 1 ? '' : 's'} read row by row` : null,
        notes.links + notes.images > 0 ? `${notes.links + notes.images} link${notes.links + notes.images === 1 ? '' : 's'} read as text` : null,
        notes.urls > 0 ? `${notes.urls} URL${notes.urls === 1 ? '' : 's'} read as the host name` : null,
        `${prepared.plan.pieces.length} pieces`,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  const setTts = (patch: Partial<TtsSettings>) => controller.updateSettings((x) => ({ ...x, tts: { ...x.tts, ...patch } }));

  return (
    <main className={styles.layout}>
      <div className={styles.main}>
        <Panel
          title="Read aloud"
          subtitle="Reads pasted text or a .txt / .md file aloud in this browser; nothing is uploaded"
          actions={
            view === 'read' ? (
              <button type="button" onClick={backToEdit}>
                Edit text
              </button>
            ) : undefined
          }
        >
          {notice && (
            <Notice tone={notice.tone} title={notice.title}>
              {notice.text}
            </Notice>
          )}

          <div className={styles.player}>
            <div className={styles.controls}>
              <div className={styles.transport}>
                <button
                  type="button"
                  className={cx(styles.iconButton)}
                  onClick={() => step(-1)}
                  disabled={!plan || (shownSentence ?? 0) <= 0}
                  aria-label="Previous sentence"
                  title="Previous sentence (←)"
                >
                  <span className={styles.glyph} aria-hidden="true">
                    ◀◀
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.playButton}
                  onClick={togglePlay}
                  disabled={busyStarting || (!live && !source.trim())}
                  aria-label={playLabel}
                  title="Play / pause (Space in the reader)"
                >
                  <span className={styles.glyph} aria-hidden="true">
                    {status === 'playing' ? '❚❚' : '▶'}
                  </span>
                  {playLabel}
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() => step(1)}
                  disabled={!plan || shownSentence === null || shownSentence >= sentenceCount - 1}
                  aria-label="Next sentence"
                  title="Next sentence (→)"
                >
                  <span className={styles.glyph} aria-hidden="true">
                    ▶▶
                  </span>
                </button>
                <button type="button" className={styles.iconButton} onClick={stop} disabled={!live} aria-label="Stop" title="Stop">
                  <span className={styles.glyph} aria-hidden="true">
                    ■
                  </span>
                </button>
              </div>
              <div className={styles.settingsRow}>
                <div className={styles.voice}>
                  <SelectField
                    label="Voice"
                    value={tts.voice}
                    options={VOICES.map((v) => ({ value: v.id, label: v.label }))}
                    onChange={(voice) => setTts({ voice })}
                  />
                </div>
                <div className={styles.speed}>
                  <Field label={`Speed ${tts.speed.toFixed(2)}×`} htmlFor={voiceSpeedId}>
                    <input
                      id={voiceSpeedId}
                      type="range"
                      min={SPEED_RANGE.min}
                      max={SPEED_RANGE.max}
                      step={SPEED_RANGE.step}
                      value={tts.speed}
                      onChange={(e) => setTts({ speed: Number(e.target.value) })}
                    />
                  </Field>
                </div>
              </div>
            </div>

            {/* No aria-live: it changes every sentence and would talk over the audio. */}
            <div className={styles.status}>
              <span className={cx(styles.statusMain, statusLine.warn && styles.statusWarn)}>{statusLine.text}</span>
              {position && plan && (
                <span className="num">
                  {live && position.piece !== null ? `piece ${position.piece + 1} of ${plan.pieces.length} · ` : ''}
                  {fmtDuration(position.playedSec)} played · about {fmtDuration(position.remainingSec)} left
                </span>
              )}
            </div>
            {(live || status === 'ended') && <Meter fraction={progress} label="Reading progress" />}
            {phase === 'loading' && <KokoroLoad model={kokoro} />}
            <KeepUpNotice snapshot={reader} record={record} />
            <p className={styles.hint}>
              Voice and speed apply from the next sentence.
              {appliedVoice && tts.voice !== appliedVoice
                ? ` The ${voiceName(tts.voice)} voice was not loaded with the model: it is downloaded on first use${s.online ? '' : ', which fails offline'}.`
                : ''}{' '}
              The voice is shared with the benchmark, where a change needs Load models.
            </p>
          </div>

          {kokoro.phase !== 'ready' && phase !== 'loading' && (
            <p className={styles.hint}>
              {kokoro.phase === 'error' && kokoro.error ? `The voice model failed to load: ${kokoro.error} ` : ''}
              Play loads the voice model first (≈163 MB on WASM, ≈326 MB on WebGPU with the automatic precision; stored in the browser
              after the first download).
              {loadBlock && !live ? ` Right now: ${loadBlock}` : ''}
            </p>
          )}
          {kokoro.phase === 'ready' && pending.length > 0 && (
            <Notice tone="info" title="The voice model is loaded with different settings">
              {pending.join(' · ')}. Read aloud uses the loaded model; reload it to apply these.{' '}
              <button type="button" onClick={() => void controller.loadModels(['kokoro'])} disabled={loadBlock !== null}>
                Reload the voice model
              </button>
            </Notice>
          )}

          {view === 'edit' ? (
            <div className={styles.dropZone} data-dragging={dragging} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
              <div className={styles.toolbar}>
                <input id={fileInputId} ref={fileInput} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" className={styles.hiddenInput} onChange={onFileChosen} />
                <button type="button" onClick={() => fileInput.current?.click()}>
                  Open file…
                </button>
                <SelectField
                  label={<span className="muted">Insert a sample</span>}
                  value=""
                  options={[
                    { value: '', label: 'Samples…' },
                    { value: 'short', label: 'Short (≈ 2 min, every construct)' },
                    { value: 'long', label: 'Long (≈ 30 min, flow control)' },
                  ]}
                  onChange={(v) => {
                    if (v === 'short') replaceText(SHORT_SAMPLE, null, 'markdown');
                    else if (v === 'long') replaceText(longSample(), null, 'markdown');
                  }}
                />
                {fileName && (
                  <span className={styles.fileName} title={fileName}>
                    {fileName}
                  </span>
                )}
                <span className={styles.toolbarSpacer} />
                <Segmented label="Text format" value={format} options={FORMAT_OPTIONS} onChange={setFormat} />
              </div>
              <textarea
                className={styles.textarea}
                aria-label="Text to read aloud"
                placeholder="Paste a document or a response here, or drop a .txt / .md file. Markdown is cleaned up for listening: headings, lists and tables are read naturally, links by their text, and code blocks are announced instead of read."
                value={source}
                spellCheck={false}
                onChange={(e) => {
                  setSource(e.target.value.slice(0, MAX_SOURCE_CHARS));
                  setCursor(0);
                }}
              />
              <div className={styles.toolbar}>
                <span className={styles.docStats}>
                  {source.length.toLocaleString()} characters · {words.toLocaleString()} words · about {fmtDuration(source.length / CHARS_PER_SEC / tts.speed)} at{' '}
                  {tts.speed.toFixed(2)}×{detected && format === 'auto' ? ` · looks like ${detected === 'markdown' ? 'Markdown' : 'plain text'}` : ''}
                </span>
                <span className={styles.toolbarSpacer} />
                <Segmented
                  label="Piece size"
                  value={tts.split}
                  options={SPLIT_OPTIONS}
                  onChange={(split) => setTts({ split })}
                />
                <button type="button" onClick={preview} disabled={!source.trim()}>
                  Preview
                </button>
                <button type="button" onClick={() => replaceText('', null, 'auto')} disabled={!source}>
                  Clear
                </button>
              </div>
            </div>
          ) : (
            plan && (
              <>
                <div className={styles.toolbar}>
                  <span className={styles.docStats}>{noteText}</span>
                  <span className={styles.toolbarSpacer} />
                  {prepared && prepared.split !== tts.split && <Chip tone="info">Piece size applies on the next Play</Chip>}
                </div>
                <ReaderText
                  plan={plan}
                  activeSentence={activeSentence}
                  activePiece={live ? (position?.piece ?? null) : null}
                  waiting={waiting}
                  cursor={live ? null : Math.min(cursor, sentenceCount - 1)}
                  onSentence={onSentence}
                  onCommand={onCommand}
                />
                <p className={styles.hint}>Click a sentence to read from there · in the text: Space play/pause, ← → previous/next sentence.</p>
              </>
            )
          )}
          {reader?.status === 'error' && reader.error && (
            <Notice tone="err" title="Read aloud stopped">
              {reader.error}
            </Notice>
          )}
        </Panel>
      </div>

      <aside className={styles.side} aria-label="Read-aloud metrics">
        <ReadAloudMetrics
          snapshot={reader}
          position={position}
          totalPieces={plan?.pieces.length ?? 0}
          record={record}
          play={play}
          readAheadSec={DEFAULT_READ_AHEAD_SEC}
          onDownload={() => {
            const blob = session?.exportWav();
            if (blob) downloadBlob(`read-aloud-${fileStamp()}.wav`, blob);
          }}
        />
      </aside>
    </main>
  );
}

/** The voice model's load progress while Play waits for it. */
function KokoroLoad({ model }: { model: ModelState<TtsSettings> }) {
  const files = Object.values(model.fileProgress);
  const loaded = files.reduce((n, f) => n + f.loadedBytes, 0);
  const total = files.length > 0 && files.every((f) => f.totalBytes != null) ? files.reduce((n, f) => n + (f.totalBytes ?? 0), 0) : null;
  const stage = model.progress?.phase ?? 'download';
  const fraction = stage === 'download' && total ? loaded / total : null;
  return (
    <div className={styles.player}>
      <div className={styles.status}>
        <span>
          {PHASE_LABEL[stage] ?? stage} the voice model{model.progress?.file ? ` · ${fileLabel(model.progress.file)}` : ''}
        </span>
        {files.length > 0 && (
          <span className="num">
            {fmtBytes(loaded)}
            {total ? ` of ${fmtBytes(total)}` : ''}
          </span>
        )}
      </div>
      <Meter fraction={fraction} label="Loading the voice model" />
    </div>
  );
}

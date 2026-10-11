'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { errorMessage } from '@/lib/benchmark/errors';
import { now } from '@localspeech/core';
import { copyText } from './clipboard';
import { fmtMs } from './format';
import styles from './ui.module.css';

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'neutral';

/** Status never relies on colour alone: every tone has its own glyph. */
const TONE_ICON: Record<Tone, string> = { ok: '✓', warn: '▲', err: '✕', info: '●', neutral: '○' };

export function Panel({
  title,
  subtitle,
  actions,
  className,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section className={cx(styles.panel, className)} aria-labelledby={id}>
      <header className={styles.panelHeader}>
        <h2 id={id} className={styles.panelTitle}>
          {title}
        </h2>
        {subtitle != null && <span className={styles.panelSubtitle}>{subtitle}</span>}
        {actions != null && <div className={styles.panelActions}>{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function Chip({ tone = 'neutral', title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  return (
    <span className={cx(styles.chip, styles[`chip-${tone}`])} title={title}>
      <span className={styles.chipIcon} aria-hidden="true">
        {TONE_ICON[tone]}
      </span>
      {children}
    </span>
  );
}

export function Notice({ tone, title, children }: { tone: Exclude<Tone, 'neutral'>; title: ReactNode; children?: ReactNode }) {
  return (
    <div className={cx(styles.notice, styles[`notice-${tone}`])} role={tone === 'err' ? 'alert' : undefined}>
      <span className={styles.noticeIcon} aria-hidden="true">
        {TONE_ICON[tone]}
      </span>
      <div className={styles.noticeBody}>
        <div className={styles.noticeTitle}>{title}</div>
        {children != null && <div className={styles.noticeText}>{children}</div>}
      </div>
    </div>
  );
}

/** Label / value list. `numeric` right-aligns values so units line up. */
export function KvList({ numeric, className, children }: { numeric?: boolean; className?: string; children: ReactNode }) {
  return <dl className={cx(styles.kv, numeric && styles.kvNumeric, className)}>{children}</dl>;
}

export function Kv({
  label,
  strong,
  hint,
  title,
  children,
}: {
  label: ReactNode;
  strong?: boolean;
  hint?: ReactNode;
  title?: string;
  children: ReactNode;
}) {
  return (
    <>
      <dt title={title}>{label}</dt>
      <dd className={cx(strong && styles.kvStrong)}>
        {children}
        {hint != null && <span className={styles.kvHint}>{hint}</span>}
      </dd>
    </>
  );
}

/** Progress / level bar. fraction null = indeterminate. */
export function Meter({ fraction, label, tone }: { fraction: number | null; label: string; tone?: 'warn' | 'err' }) {
  const pct = fraction == null ? null : Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div
      className={styles.meter}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct == null ? undefined : Math.round(pct)}
    >
      <div
        className={cx(styles.meterFill, pct == null && styles.meterIndeterminate, tone && styles[`meter-${tone}`])}
        style={pct == null ? undefined : { width: `${pct}%` }}
      />
    </div>
  );
}

/** Re-renders only the caller, every intervalMs, while active. */
export function useTicker(active: boolean, intervalMs = 100): number {
  const [t, setT] = useState(now);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setT(now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return t;
}

export function Elapsed({ since }: { since: number }) {
  const t = useTicker(true);
  return <span className="num">{fmtMs(Math.max(0, t - since))}</span>;
}

export function Field({ label, hint, htmlFor, children }: { label: ReactNode; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint != null && <div className={styles.fieldHint}>{hint}</div>}
    </div>
  );
}

export function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
  hint,
  disabled,
}: {
  label: ReactNode;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <select
        id={id}
        value={String(value)}
        disabled={disabled}
        onChange={(e) => {
          const option = options.find((o) => String(o.value) === e.target.value);
          if (option) onChange(option.value);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <div className={styles.segmented} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.value} className={cx(styles.segment, o.value === value && styles.segmentOn)} title={o.title}>
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={o.value === value}
            disabled={disabled}
            onChange={() => onChange(o.value)}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

export function CopyButton({ label, getText, disabled }: { label: string; getText: () => string; disabled?: boolean }) {
  const [state, setState] = useState<{ kind: 'idle' | 'copied' } | { kind: 'error'; message: string }>({ kind: 'idle' });
  useEffect(() => {
    if (state.kind !== 'copied') return;
    const timer = setTimeout(() => setState({ kind: 'idle' }), 1800);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <span className={styles.inlineAction}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          copyText(getText()).then(
            () => setState({ kind: 'copied' }),
            (e) => setState({ kind: 'error', message: errorMessage(e) }),
          );
        }}
      >
        {state.kind === 'copied' ? 'Copied ✓' : label}
      </button>
      {state.kind === 'error' && (
        <span className={styles.inlineError} role="alert">
          Copy failed: {state.message}
        </span>
      )}
    </span>
  );
}

/** Destructive action: the first click arms it, the second (within 4 s) runs it. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
  title,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  title?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      className={cx(armed && styles.dangerButton)}
      disabled={disabled}
      title={title}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

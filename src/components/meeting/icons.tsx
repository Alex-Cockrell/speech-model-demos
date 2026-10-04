import type { AudioSourceKind } from '@/lib/types';
import { SOURCE_LABEL } from './state';

interface IconProps {
  className?: string;
  /** Accessible name; without it the icon is decorative. */
  title?: string;
}

function Svg({ className, title, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
    </Svg>
  );
}

/** Headset: audio from the call (shared tab, window or screen). */
export function CallIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 10V8a5.5 5.5 0 0 1 11 0v2" />
      <rect x="1.75" y="9" width="3" height="4.75" rx="1" />
      <rect x="11.25" y="9" width="3" height="4.75" rx="1" />
    </Svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="7" width="10" height="7.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </Svg>
  );
}

export function SourceIcon({ source, className, labelled = true }: { source: AudioSourceKind; className?: string; labelled?: boolean }) {
  const title = labelled ? SOURCE_LABEL[source] : undefined;
  return source === 'mic' ? <MicIcon className={className} title={title} /> : <CallIcon className={className} title={title} />;
}

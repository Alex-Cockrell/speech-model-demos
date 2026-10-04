'use client';

import { useRef, useState } from 'react';

/**
 * An inline-editable title: saves on Enter or when focus leaves, Escape restores it. Give it key={value} so a
 * title changed elsewhere replaces the draft.
 */
export function TitleInput({
  value,
  onCommit,
  label,
  className,
}: {
  value: string;
  onCommit: (title: string) => void;
  label: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);
  return (
    <input
      type="text"
      className={className}
      value={draft}
      maxLength={120}
      aria-label={label}
      title="Click to rename"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (cancelled.current) {
          cancelled.current = false;
          setDraft(value);
          return;
        }
        const title = draft.replace(/\s+/g, ' ').trim();
        if (title && title !== value) onCommit(title);
        // A successful rename changes `value` (and the key); a failed one leaves the old title showing.
        setDraft(value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

import type { Metadata, Viewport } from 'next';
import './globals.css';

// Inline icon: browsers fetch (and re-validate) favicons on their own schedule, including mid-run,
// which would show up in the "no network during a speech run" privacy check.
const ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#256abf"/><g fill="#fff"><rect x="6" y="13" width="3" height="6" rx="1.5"/><rect x="11" y="9" width="3" height="14" rx="1.5"/><rect x="16" y="5" width="3" height="22" rx="1.5"/><rect x="21" y="10" width="3" height="12" rx="1.5"/><rect x="26" y="14" width="2.5" height="4" rx="1.25"/></g></svg>',
  );

export const metadata: Metadata = {
  title: 'Local Speech Test',
  description: 'Browser-local speech recognition and speech synthesis proof of concept with benchmark instrumentation.',
  icons: { icon: ICON },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

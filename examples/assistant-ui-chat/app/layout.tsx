import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'Local speech · assistant-ui example' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

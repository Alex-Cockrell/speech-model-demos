'use client';

import dynamic from 'next/dynamic';

// Everything touches browser-only APIs (navigator.gpu, AudioContext, Workers), so the app
// renders client-side only; the static export ships an empty shell for this page.
const App = dynamic(() => import('@/components/App'), { ssr: false });

export default function Page() {
  return <App />;
}

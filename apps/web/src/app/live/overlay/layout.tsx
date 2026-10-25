import type { Metadata } from 'next';

const TITLE = 'Live Scoreboard Overlay';
const DESCRIPTION = 'Broadcast scoreboard overlay for GCDIS Drone Soccer Championship matches.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  // Do not inherit the home page canonical from the root layout.
  alternates: { canonical: null },
  openGraph: { title: `${TITLE} | GCDIS`, description: DESCRIPTION, url: '/live/overlay' },
  twitter: { title: `${TITLE} | GCDIS`, description: DESCRIPTION },
  robots: { index: false, follow: false }
};

export default function OverlayLayout({ children }: { children: React.ReactNode }) {
  return children;
}

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Team Portal',
  description: 'Sign in or register your team for the GCDIS National Drone Soccer Championship 2026 and manage your team dashboard.',
  robots: { index: false, follow: false },
  // Do not inherit the root canonical ('/') on a noindex page
  alternates: { canonical: null }
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return children;
}

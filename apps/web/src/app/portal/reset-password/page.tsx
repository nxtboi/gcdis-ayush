import type { Metadata } from 'next';
import PortalCardShell from '../_components/PortalCardShell';
import ResetPasswordClient from './ResetPasswordClient';

export const metadata: Metadata = {
  title: { absolute: 'Reset Password | GCDIS' },
  description: 'Set a new password for your GCDIS Team Portal captain account.',
  robots: { index: false, follow: false, nocache: true },
  alternates: { canonical: null },
  // The URL carries a one-time token: never pass it on in a Referer header.
  referrer: 'no-referrer'
};

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const { token } = await searchParams;
  return (
    <PortalCardShell
      eyebrow="Team Portal"
      title="Reset your password"
      intro="Choose a new password for your team captain account."
    >
      <ResetPasswordClient token={typeof token === 'string' ? token : ''} />
    </PortalCardShell>
  );
}

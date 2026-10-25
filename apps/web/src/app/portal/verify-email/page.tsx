import type { Metadata } from 'next';
import PortalCardShell from '../_components/PortalCardShell';
import VerifyEmailClient from './VerifyEmailClient';

export const metadata: Metadata = {
  title: { absolute: 'Verify Email Address | GCDIS' },
  description: 'Verify the email address of your GCDIS Team Portal captain account.',
  robots: { index: false, follow: false, nocache: true },
  alternates: { canonical: null },
  // The URL carries a one-time token: never pass it on in a Referer header.
  referrer: 'no-referrer'
};

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const { token } = await searchParams;
  return (
    <PortalCardShell eyebrow="Team Portal" title="Email verification">
      <VerifyEmailClient token={typeof token === 'string' ? token : ''} />
    </PortalCardShell>
  );
}

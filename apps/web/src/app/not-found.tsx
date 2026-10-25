import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, Trophy } from 'lucide-react';
import { Navbar } from '@/components/layout/Navbar';
import { Footer } from '@/components/layout/Footer';
import { MotionRoot, Reveal } from '@/components/motion/Reveal';
import { getSiteContent } from '@/lib/site-content';

export const metadata: Metadata = {
  title: 'Page Not Found',
  alternates: { canonical: null },
  robots: { index: false, follow: false }
};

export default async function NotFound() {
  const { siteInfo } = await getSiteContent();
  return (
    <MotionRoot>
    <div className="min-h-screen bg-topography text-slate-900 font-sans flex flex-col">
      <Navbar />

      <main id="main" className="flex-1 flex items-center px-4 pt-32 pb-24">
        <Reveal className="max-w-2xl mx-auto text-center space-y-6">
          <p className="text-xs font-mono font-bold text-[#15803D] uppercase tracking-wider">Error 404</p>
          <h1 className="text-3xl sm:text-4xl font-black text-slate-950 uppercase tracking-tight">Page Not Found</h1>
          <p className="text-sm text-slate-600 leading-relaxed font-medium">
            The requested page could not be found on the official website of the {siteInfo.organisationName} ({siteInfo.shortName}). It may
            have been moved or removed, or the address may have been entered incorrectly. For assistance, please write to{' '}
            <a href={`mailto:${siteInfo.email}`} className="font-semibold text-[#15803D] hover:underline">
              {siteInfo.email}
            </a>
            .
          </p>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-3 pt-2">
            <Link
              href="/"
              className="inline-flex items-center justify-center gap-2 px-5 py-3 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-black text-xs uppercase tracking-wider rounded-lg transition-colors shadow-sm"
            >
              <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Return to Home
            </Link>
            <Link
              href="/events/drone-soccer-2026"
              className="inline-flex items-center justify-center gap-2 px-5 py-3 bg-[#15803D] hover:bg-[#166534] text-white font-black text-xs uppercase tracking-wider rounded-lg transition-colors shadow-sm"
            >
              <Trophy className="w-4 h-4" aria-hidden="true" /> Championship 2026
            </Link>
          </div>
        </Reveal>
      </main>

      <Footer />
    </div>
    </MotionRoot>
  );
}

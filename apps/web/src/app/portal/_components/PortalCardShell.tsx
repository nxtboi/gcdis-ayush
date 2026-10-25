import React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Logo } from '@/components/brand/Logo';

/**
 * Full-screen frame for the single-purpose portal pages (email verification, password reset):
 * the lab photograph of the sign-in view behind a centred card, with the same entrance motion.
 */
export default function PortalCardShell({
  eyebrow,
  title,
  intro,
  children
}: {
  eyebrow: string;
  title: string;
  intro?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen flex-col bg-[#0b1120] font-sans text-slate-900">
      <div className="hero-kenburns fixed inset-0" aria-hidden="true">
        <Image src="/images/gcdis-drone-lab.jpg" alt="" fill priority sizes="100vw" className="object-cover object-center" />
      </div>
      <div
        aria-hidden="true"
        className="fixed inset-0"
        style={{
          background:
            'linear-gradient(160deg, rgba(11,17,32,0.90) 0%, rgba(11,17,32,0.78) 50%, rgba(11,17,32,0.95) 100%), radial-gradient(ellipse at 30% 40%, rgba(37,99,235,0.20), transparent 60%)'
        }}
      />

      <header className="relative flex items-center justify-between gap-4 px-4 pt-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2">
          <Logo size={36} withWordmark />
        </Link>
        <nav aria-label="Portal" className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider">
          <Link href="/" className="rounded-full px-3 py-1.5 text-slate-200 transition-colors hover:text-white">
            Home
          </Link>
          <Link href="/portal" className="rounded-full px-3 py-1.5 text-slate-200 transition-colors hover:text-white">
            Team Portal
          </Link>
        </nav>
      </header>

      <main id="main" className="relative flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
        <div
          className="hero-rise w-full max-w-md rounded-3xl border border-slate-200/90 bg-white p-6 shadow-2xl shadow-slate-900/30 sm:p-9"
          style={{ animationDelay: '0.15s' }}
        >
          <div className="space-y-2 text-center">
            <div className="mx-auto w-fit">
              <Logo size={56} />
            </div>
            <p className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-[#15803D]">{eyebrow}</p>
            <h1 className="text-2xl font-black uppercase tracking-tight text-slate-950">{title}</h1>
            {intro && <p className="text-sm text-slate-600">{intro}</p>}
          </div>
          <div className="mt-6">{children}</div>
        </div>
      </main>

      <footer className="relative px-4 pb-6 text-center font-mono text-[11px] text-slate-400">
        Galgotias Centre for Drone Intelligence &amp; Simulation • Galgotias University
      </footer>
    </div>
  );
}

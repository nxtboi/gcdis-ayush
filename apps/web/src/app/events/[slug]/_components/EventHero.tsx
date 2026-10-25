'use client';

/**
 * Client parts of the championship bento hero: the main tile's background (the console video over its
 * poster, or the laboratory photograph) with a slow parallax drift, the static headline, the flip countdown
 * with the registration status, the transparent equal-width buttons (with a hover shine) and the green
 * marquee strip of dates and classes.
 *
 * The video is muted, looped, inline and silent, and starts only after the page has loaded. With
 * `prefers-reduced-motion` or `navigator.connection.saveData` only the poster is shown.
 */
import React, { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, Asterisk, Radio } from 'lucide-react';
import { useEventCountdown } from '@/components/home-bento/Countdown';
import { HeroParallax } from '@/components/home-bento/Effects';
import { Marquee } from '@/components/home-bento/Marquee';
import { useReduce } from '@/components/home-bento/hooks';
import { isApiHostedImage } from '@/lib/site-content';
import { DEFAULT_HERO_POSTER } from '@/lib/championship-media';
import { EVENT_DATES_LABEL, type RegistrationStatus } from '@/lib/championship-event';
import { FlipCountdown, SHINE, cx } from './EventPrimitives';

/** Headline: plain static text (no decode or sweep); the lines only fade and slide in with `hero-rise`. */
export function HeroTitle({ lead, highlight }: { lead: string; highlight: string }) {
  return (
    <>
      <span className="hero-rise block" style={{ animationDelay: '0.2s' }}>
        {lead}
      </span>
      <span className="hero-rise mt-2 inline-block" style={{ animationDelay: '0.32s' }}>
        <span className="inline-block rounded-lg border-[2.5px] border-bento-ink bg-[#22C55E] px-3 py-0.5 text-bento-ink shadow-[4px_4px_0_#111] sm:px-4">
          {highlight}
        </span>
      </span>
    </>
  );
}

interface NavigatorConnection {
  saveData?: boolean;
}

/** Whether the background video may play: no reduced-motion request and no data-saving mode. */
function useVideoAllowed(): boolean {
  const reduce = useReduce();
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: NavigatorConnection }).connection;
    setAllowed(!reduce && !connection?.saveData);
  }, [reduce]);
  return allowed;
}

/**
 * Full-bleed background: the poster (console image or the laboratory photograph) is always rendered first;
 * the video is mounted only after the page load event, when allowed, and fades in once it is playing.
 */
export function HeroMedia({ videoUrl, posterUrl }: { videoUrl: string | null; posterUrl: string | null }) {
  const poster = posterUrl || DEFAULT_HERO_POSTER;
  const allowed = useVideoAllowed();
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Lazy start: wait for the window load event so the video never competes with the page's own resources.
  useEffect(() => {
    if (!videoUrl || !allowed) return;
    if (document.readyState === 'complete') {
      setLoaded(true);
      return;
    }
    const onLoad = () => setLoaded(true);
    window.addEventListener('load', onLoad, { once: true });
    return () => window.removeEventListener('load', onLoad);
  }, [videoUrl, allowed]);

  // Pause while the hero is off screen.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) video.play().catch(() => undefined);
      else video.pause();
    });
    io.observe(video);
    return () => io.disconnect();
  }, [loaded]);

  const unoptimized = poster !== DEFAULT_HERO_POSTER && !isApiHostedImage(poster);
  return (
    <>
      <HeroParallax className="absolute -inset-y-16 inset-x-0 -z-20">
        <div aria-hidden="true" className="absolute inset-0">
          <Image src={poster} alt="" fill priority sizes="100vw" unoptimized={unoptimized} className="object-cover object-center" />
          {videoUrl && allowed && loaded && (
            <video
              ref={videoRef}
              className={cx('absolute inset-0 h-full w-full object-cover transition-opacity duration-1000', playing ? 'opacity-100' : 'opacity-0')}
              src={videoUrl}
              poster={poster}
              muted
              loop
              playsInline
              autoPlay
              preload="metadata"
              disablePictureInPicture
              disableRemotePlayback
              aria-hidden="true"
              tabIndex={-1}
              onPlaying={() => setPlaying(true)}
            />
          )}
        </div>
      </HeroParallax>
      {/* Legibility: dark navy gradient, heavier at the bottom and on the left */}
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10"
        style={{
          background:
            'linear-gradient(180deg, rgba(15,23,42,0.50) 0%, rgba(30,58,138,0.38) 40%, rgba(15,23,42,0.92) 100%), linear-gradient(90deg, rgba(15,23,42,0.6) 0%, rgba(37,99,235,0.10) 70%)'
        }}
      />
    </>
  );
}

/** Countdown to the start (from the API event dates) with the registration status. */
export function HeroCountdown({ status, startsAt, endsAt }: { status: RegistrationStatus; startsAt: string; endsAt: string }) {
  const { parts, phase } = useEventCountdown(startsAt, endsAt);
  return (
    <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-6">
      <div>
        {status !== 'unknown' && (
          <p className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-white backdrop-blur-sm">
            <span className={cx('h-1.5 w-1.5 rounded-full', status === 'open' ? 'radar-live-badge bg-[#16A34A]' : 'bg-slate-400')} aria-hidden="true" />
            {status === 'open' ? 'Registration open' : 'Registration closed'}
          </p>
        )}
        <p className="mt-2 font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-slate-300">
          {phase === 'live' ? 'Under way' : phase === 'ended' ? 'Concluded' : 'Starts in'}
        </p>
      </div>
      {phase === 'live' ? (
        <a href="#scores" className="inline-flex items-center gap-2 text-sm font-bold uppercase text-white underline decoration-[#4ADE80] decoration-2 underline-offset-4">
          <Radio className="h-4 w-4 text-[#4ADE80]" aria-hidden="true" />
          Follow the live scores
        </a>
      ) : phase === 'ended' ? null : (
        <FlipCountdown parts={parts} />
      )}
    </div>
  );
}

/** Register / programme / live-score buttons: the home hero's transparent style, equal widths, hover shine. */
export function HeroActions() {
  const cls = cx(
    'inline-flex w-full items-center justify-center gap-2 rounded-full border border-white/30 bg-white/5 px-6 py-3 text-xs font-black uppercase tracking-wider text-white whitespace-nowrap backdrop-blur-sm transition-colors hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:w-52',
    SHINE
  );
  return (
    <div className="hero-rise mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap" style={{ animationDelay: '0.6s' }}>
      <Link href="/portal" className={cls}>
        Register your team
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Link>
      <a href="#programme" className={cls}>
        View programme
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </a>
      <a href="#scores" className={cls}>
        Live scores
        <Radio className="h-4 w-4" aria-hidden="true" />
      </a>
    </div>
  );
}

/** Tilted green band below the hero (the home page's marquee strip) with the dates, classes and headline facts. */
export function FactsMarquee({ items }: { items: string[] }) {
  return (
    <div className="relative overflow-hidden bg-[#0F172A] py-7">
      <div className="relative -mx-4 -rotate-[1.5deg] overflow-hidden border-y-[2.5px] border-bento-ink bg-bento-lime py-3.5 shadow-[0_6px_0_#111]">
        <Marquee label={`Championship at a glance: ${EVENT_DATES_LABEL}`} speed={50} trackClassName="gap-8 pr-8">
          {items.map((item) => (
            <span key={item} className="flex shrink-0 items-center gap-8 whitespace-nowrap text-base font-extrabold uppercase tracking-tight text-bento-ink sm:text-xl">
              {item}
              <Asterisk className="h-5 w-5" aria-hidden="true" />
            </span>
          ))}
        </Marquee>
      </div>
    </div>
  );
}

import React from 'react';
import { headers } from 'next/headers';
import { Calendar, MapPin, Trophy } from 'lucide-react';
import { Navbar } from '@/components/layout/Navbar';
import { Footer } from '@/components/layout/Footer';
import { MotionRoot } from '@/components/motion/Reveal';
import { CLASS_SPECS, PRIZE_POOL_INR, formatInr } from '@/lib/championship';
import {
  EVENT_DATES_LABEL,
  EVENT_DAY_COUNT,
  buildEventJsonLd,
  feeLabel,
  eventWindow,
  registrationStatus,
  serialiseJsonLd,
  venueLabel
} from '@/lib/championship-event';
import { galleryWithFallback, getChampionshipMedia } from '@/lib/championship-media';
import { getEventDetails } from '@/lib/events';
import { getGalleryImages, getSiteContent } from '@/lib/site-content';
import { SITE_URL } from '@/lib/site';
import { ChampionshipSections } from './_components/ChampionshipSections';
import { FactsMarquee, HeroActions, HeroCountdown, HeroMedia, HeroTitle } from './_components/EventHero';
import { Counter } from './_components/EventPrimitives';

/**
 * Drone Soccer Championship 2026: a single-page event site, a sibling of the home page's bold bento design in
 * the brighter GCDIS palette. The bento hero (its main tile carries the console video and poster from
 * GET /cms/public/championship-media) is rendered here, with its motion in client components; the anchored sections below live in ChampionshipSections. Facts come from
 * lib/championship.ts, the API (`GET /events/:slug`: entry fees, active categories) and the console-managed
 * site information; anything unknown is left out. The layout validates the slug and sets the metadata.
 */
export default async function EventExperiencePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [details, { siteInfo, gallerySection }, media, requestHeaders] = await Promise.all([
    getEventDetails(slug),
    getSiteContent(),
    getChampionshipMedia(),
    headers()
  ]);
  // Published site gallery photographs: the Drones & Arena gallery falls back to them (and the laboratory
  // photograph) until championship photographs are uploaded.
  const siteGallery = media.gallery.length === 0 && gallerySection.enabled ? await getGalleryImages() : [];

  // Per-request CSP nonce (src/middleware.ts): every inline script, including JSON-LD, carries it.
  const nonce = requestHeaders.get('x-nonce') ?? undefined;
  const jsonLd = serialiseJsonLd(buildEventJsonLd({ details, siteInfo, siteUrl: SITE_URL }));
  const venue = venueLabel(details, siteInfo);
  const status = registrationStatus(details);
  const eventDates = eventWindow(details);
  const d20Fee = feeLabel(details, 'd20');
  const d40Fee = feeLabel(details, 'd40');

  const marquee = [
    EVENT_DATES_LABEL,
    `${CLASS_SPECS.d20.name} (D20)`,
    `${CLASS_SPECS.d40.name} (D40)`,
    `${formatInr(PRIZE_POOL_INR)} prize pool`,
    'FIDA Dronesoccer Regulations',
    ...(venue ? [venue] : [])
  ];

  return (
    <MotionRoot>
      {/* Browsers hide the nonce attribute from the DOM after load, so React would report a hydration mismatch on it. */}
      <script type="application/ld+json" nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: jsonLd }} />
      <div className="min-h-screen bg-[#0F172A] font-sans text-slate-900 selection:bg-bento-lime selection:text-bento-ink">
        <Navbar />

        <main id="main">
          {/* EVENT HERO (bento, as the home page): a large tile with the background video, title, dates, buttons
              and countdown, beside smaller key-fact tiles */}
          <section aria-labelledby="event-heading" className="relative isolate overflow-hidden bg-[#0F172A] px-4 pb-10 pt-28 sm:px-6 sm:pt-32 lg:px-8">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 -z-10 [background-image:radial-gradient(#26324A_1.5px,transparent_1.6px)] [background-size:20px_20px]"
            />
            <div className="mx-auto grid max-w-7xl grid-cols-1 gap-6 lg:grid-cols-12">
              <div className="hero-rise relative isolate flex min-h-[560px] flex-col justify-end overflow-hidden rounded-[18px] border-2 border-bento-line bg-[#1E293B] p-6 text-white shadow-[6px_6px_0_#C6F432] sm:p-10 lg:col-span-8">
                <HeroMedia videoUrl={media.heroVideoUrl} posterUrl={media.heroPosterUrl} />

                <p className="hero-rise inline-flex w-fit items-center gap-2 rounded-md bg-[#4ADE80] px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-bento-ink">
                  <Trophy className="h-3.5 w-3.5" aria-hidden="true" />
                  National Championship · FIDA regulations
                </p>

                <h1
                  id="event-heading"
                  className="mt-5 font-sans text-[clamp(2.1rem,5.6vw,4.5rem)] font-extrabold uppercase leading-[1] tracking-[-0.04em] [overflow-wrap:anywhere]"
                >
                  <HeroTitle lead="Drone Soccer" highlight="Championship 2026" />
                </h1>

                <ul className="hero-rise mt-6 flex flex-col gap-2 text-sm font-semibold text-slate-100 sm:flex-row sm:gap-8 sm:text-base" style={{ animationDelay: '0.45s' }}>
                  <li className="flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-[#4ADE80]" aria-hidden="true" />
                    {EVENT_DATES_LABEL}
                  </li>
                  {venue && (
                    <li className="flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-[#4ADE80]" aria-hidden="true" />
                      {venue}
                    </li>
                  )}
                </ul>

                <HeroActions />

                <div className="hero-rise mt-8 border-t border-white/15 pt-6" style={{ animationDelay: '0.75s' }}>
                  <HeroCountdown status={status} startsAt={eventDates.startsAt} endsAt={eventDates.endsAt} />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-6 sm:grid-cols-3 lg:col-span-4 lg:grid-cols-1">
                <div
                  className="hero-rise flex min-h-[170px] flex-col justify-between rounded-[18px] border-[2.5px] border-bento-ink bg-bento-lime p-6 text-bento-ink shadow-[6px_6px_0_#22C55E]"
                  style={{ animationDelay: '0.25s' }}
                >
                  <p className="font-mono text-[11px] font-bold uppercase tracking-[0.2em]">Prize pool</p>
                  <div>
                    <Counter value={PRIZE_POOL_INR} format="inr" className="block text-[clamp(2.25rem,4vw,3.25rem)] font-extrabold leading-none tracking-[-0.045em]" />
                    <p className="mt-2 text-sm font-bold">Across both classes</p>
                  </div>
                </div>
                <div
                  className="hero-rise flex min-h-[170px] flex-col justify-between rounded-[18px] border-[2.5px] border-bento-ink bg-white p-6 text-bento-ink shadow-[6px_6px_0_#22C55E]"
                  style={{ animationDelay: '0.35s' }}
                >
                  <p className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-[#15803D]">Dates</p>
                  <div>
                    <p className="text-2xl font-extrabold tracking-tight">{EVENT_DATES_LABEL}</p>
                    <p className="mt-1 text-sm text-slate-600">
                      {EVENT_DAY_COUNT} days of competition{venue ? `, ${venue}` : ''}
                    </p>
                  </div>
                </div>
                <div
                  className="hero-rise flex min-h-[170px] flex-col justify-between rounded-[18px] border-[2.5px] border-bento-ink bg-white p-6 text-bento-ink shadow-[6px_6px_0_#22C55E]"
                  style={{ animationDelay: '0.45s' }}
                >
                  <p className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-[#15803D]">Classes</p>
                  <div>
                    <p className="text-2xl font-extrabold tracking-tight">D20 · D40</p>
                    {d20Fee && d40Fee ? (
                      <p className="mt-1 text-sm text-slate-600">
                        Entry {d20Fee} / {d40Fee} per team, GST-inclusive
                      </p>
                    ) : (
                      <p className="mt-1 text-sm text-slate-600">
                        {CLASS_SPECS.d20.name} and {CLASS_SPECS.d40.name}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <FactsMarquee items={marquee} />

          <ChampionshipSections
            details={details}
            gallery={galleryWithFallback(media.gallery, siteGallery)}
            startsAt={eventDates.startsAt}
            endsAt={eventDates.endsAt}
            sectionMedia={media.sections}
          />
        </main>

        <Footer />
      </div>
    </MotionRoot>
  );
}

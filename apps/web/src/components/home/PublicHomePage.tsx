'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Navbar } from '@/components/layout/Navbar';
import { ArrowRight, ChevronDown } from 'lucide-react';
import { motion, MotionConfig, useReducedMotion } from 'framer-motion';
import { fetchApi, resolveApiAssetUrl } from '@/lib/api-client';
import { HomeBento } from '@/components/home-bento/HomeBento';
import { BentoFooter } from '@/components/home-bento/BentoFooter';
import { HeroParallax, LightSweep, Magnetic, Spotlight } from '@/components/home-bento/Effects';
import { VideoLayer } from '@/components/home-bento/Media';
import type { HomeContent } from '@/lib/home-content';
import type { HomeBodyKey } from '@/lib/home-sections';
import type { GalleryImage, GallerySectionSettings, Sponsor } from '@/lib/site-content';

interface HeroBackground {
  mediaUrl?: string;
  mediaType?: string;
  focusX?: number;
  focusY?: number;
  zoom?: number;
  overlayColor?: string;
  overlayOpacity?: number;
  blurPx?: number;
  brightnessPct?: number;
}

interface HeroSectionData extends HeroBackground {
  background?: HeroBackground;
  headline?: string;
  description?: string;
  announcementTitle?: string;
  announcementBody?: string;
  announcementDate?: string;
}

export interface PublicHomePageProps {
  /** HOME-placement sponsors, or `null` when the sponsors section is disabled for the home page. */
  sponsors: Sponsor[] | null;
  /** Published gallery images, or `null` when the gallery section is disabled. */
  gallery: GalleryImage[] | null;
  gallerySection: GallerySectionSettings;
  /** Home content with placeholders resolved for the environment (lib/home-content.ts). */
  content: HomeContent;
  /** Enabled body sections in the order set in the staff console. */
  order: HomeBodyKey[];
  /** Whether the green ticker below the hero is shown. */
  showTicker: boolean;
  /** Anchors of hidden sections (links to them are not shown). */
  hiddenAnchors: string[];
}

/**
 * Home page (client): the original hero and its ticker (with light after effects layered on top: headline
 * blur-to-sharp, light sweep, magnetic CTAs, background parallax and a pointer spotlight, all off with
 * reduced motion), then the "bold bento" body (components/home-bento) with the console-managed sponsors and
 * gallery passed from app/page.tsx.
 */
export function PublicHomePage({ sponsors, gallery, gallerySection, content, order, showTicker, hiddenAnchors }: PublicHomePageProps) {
  // A link to a home section that staff have switched off is hidden rather than left pointing nowhere
  const isShownLink = (href?: string | null) => !(href && href.startsWith('#') && hiddenAnchors.includes(href.slice(1)));
  const reduceMotion = useReducedMotion();
  const hero = content.hero;
  const highlights = hero.facts.filter((f) => isShownLink(f.url));
  // The hero buttons share one style and width (owner's request); a button pointing to a switched-off section is hidden
  const heroButtons = [hero.primaryCta, hero.secondaryCta, hero.tertiaryCta].filter(
    (cta): cta is NonNullable<typeof cta> => Boolean(cta && cta.label && cta.href) && isShownLink(cta!.href)
  );

  // Dynamic CMS Hero Background State
  const [heroBg, setHeroBg] = useState<{
    mediaUrl?: string;
    mediaType?: string;
    focusX?: number;
    focusY?: number;
    zoom?: number;
    overlayColor?: string;
    overlayOpacity?: number;
    blurPx?: number;
    brightnessPct?: number;
    headline?: string;
    description?: string;
    announcementTitle?: string;
    announcementBody?: string;
    announcementDate?: string;
  } | null>(null);

  useEffect(() => {
    // Load the published hero CMS section from the API; on failure keep the default static hero.
    fetchApi<{ data?: HeroSectionData }>('/cms/section/hero')
      .then((section) => {
        const d = section?.data;
        if (!d) return;
        // The admin console stores background fields at the top level of `data`; older content nests them under `background`.
        const bg = d.background ?? d;
        setHeroBg({
          ...bg,
          mediaUrl: bg.mediaUrl ? resolveApiAssetUrl(bg.mediaUrl) : undefined,
          headline: d.headline,
          description: d.description,
          announcementTitle: d.announcementTitle,
          announcementBody: d.announcementBody,
          announcementDate: d.announcementDate
        });
      })
      .catch(() => {
        // No published hero section (404) or API unreachable: the static default hero is intentionally used.
      });
  }, []);

  // Hero background. The Home Page Hero image (CMS section) is a still image only: a legacy "video" value there is
  // never used as an image. A hero video (Home Page Sections, EVENT_VIDEO upload) plays muted and looped over the
  // still, with the hero poster image (falling back to the Home Page Hero image) shown first, and only the still
  // with reduced motion or data saving (VideoLayer).
  const cmsImage = heroBg?.mediaUrl && heroBg.mediaType !== 'video' ? heroBg.mediaUrl : null;
  const heroPoster = hero.imageUrl || null;
  const heroStill = hero.videoUrl ? heroPoster || cmsImage : cmsImage || heroPoster;
  const stillIsCms = Boolean(heroStill && heroStill === cmsImage);

  return (
    <MotionConfig reducedMotion="user">
    <div className="min-h-screen bg-topography text-slate-900 font-sans selection:bg-blue-600 selection:text-white">
      <Navbar />

      <main id="main">

      {/* HERO: lab photograph (or CMS-configured media) with a formal staggered entrance */}
      <section
        aria-labelledby="hero-heading"
        className="relative isolate flex min-h-[92vh] flex-col justify-center overflow-hidden bg-[#0b1120] px-4 pt-32 pb-16 sm:pt-40 sm:pb-20 text-white"
      >
        {/* Background media: slow settle-in zoom (Ken Burns), once; gentle scroll parallax on top */}
        <HeroParallax className="absolute inset-0 -z-20">
        <div aria-hidden="true" className="hero-kenburns absolute inset-0 -z-20">
          {heroStill ? (
            <div
              className="absolute inset-0 bg-cover bg-no-repeat"
              style={
                stillIsCms && heroBg
                  ? {
                      backgroundImage: `url(${heroStill})`,
                      backgroundPosition: `${heroBg.focusX ?? 50}% ${heroBg.focusY ?? 50}%`,
                      transform: `scale(${(heroBg.zoom ?? 100) / 100})`,
                      filter: `blur(${heroBg.blurPx ?? 0}px) brightness(${heroBg.brightnessPct ?? 100}%)`
                    }
                  : { backgroundImage: `url(${heroStill})`, backgroundPosition: '50% 50%' }
              }
            />
          ) : (
            <Image
              src="/images/gcdis-drone-lab.jpg"
              alt=""
              fill
              priority
              sizes="100vw"
              className="object-cover object-center"
            />
          )}
          <VideoLayer videoUrl={hero.videoUrl} poster={heroStill ?? '/images/gcdis-drone-lab.jpg'} eager />
        </div>
        </HeroParallax>

        {/* Legibility overlays: navy wash fading darker at the bottom, faint engineering grid */}
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10"
          style={
            cmsImage && heroBg?.overlayColor
              ? { backgroundColor: heroBg.overlayColor, opacity: heroBg.overlayOpacity ?? 0.85 }
              : {
                  background:
                    'linear-gradient(180deg, rgba(11,17,32,0.80) 0%, rgba(11,17,32,0.62) 45%, rgba(11,17,32,0.94) 100%), radial-gradient(ellipse at 50% 35%, rgba(37,99,235,0.18), transparent 60%)'
                }
          }
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 opacity-[0.07] [background-image:linear-gradient(rgba(255,255,255,0.6)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.6)_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_at_center,black_40%,transparent_75%)]"
        />

        {/* Soft pointer spotlight (desktop pointers only) */}
        <Spotlight colour="rgba(34,197,94,0.10)" size={640} />

        <div className="relative mx-auto w-full max-w-5xl text-center">
          <p style={{ animationDelay: '0.25s' }}
            className="hero-rise inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-slate-200 backdrop-blur-sm sm:text-[11px]"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[#22C55E]" aria-hidden="true" />
            {hero.eyebrow}
          </p>

          <h1
            id="hero-heading"
            className="mt-6 font-sans text-[clamp(2rem,6.2vw,4.5rem)] font-black uppercase leading-[1.08] tracking-tight [overflow-wrap:anywhere]"
          >
            <span style={{ animationDelay: '0.37s' }}
            className="hero-rise hero-sharpen block">
              {hero.headlineLead}
            </span>
            <span style={{ animationDelay: '0.49s' }}
            className="hero-rise hero-sharpen mt-2 inline-block">
              <span className="relative inline-block rounded-md bg-[#2563EB] px-3 py-0.5 shadow-lg shadow-blue-900/40 sm:px-4 sm:py-1">
                {hero.headlineHighlight}
                <span aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-md">
                  <LightSweep />
                </span>
              </span>
            </span>
          </h1>

          {/* Accent rule draws in from the centre */}
          <div aria-hidden="true" style={{ animationDelay: '0.6s' }}
            className="hero-rule mx-auto mt-6 h-1 w-20 origin-center rounded-full bg-[#22C55E]"
          />

          {hero.keywords.length > 0 && (
          <div style={{ animationDelay: '0.61s' }}
            className="hero-rise mt-5 flex items-center justify-center gap-3 font-mono text-xs font-bold uppercase tracking-widest text-slate-300 sm:text-sm"
          >
            {hero.keywords.map((word, i) => (
              <React.Fragment key={`${i}-${word}`}>
                {i > 0 && <span className="text-[#22C55E]" aria-hidden="true">•</span>}
                <span>{word}</span>
              </React.Fragment>
            ))}
          </div>
          )}

          <p style={{ animationDelay: '0.73s' }}
            className="hero-rise mx-auto mt-5 max-w-2xl text-sm font-medium leading-relaxed text-slate-200 sm:text-base"
          >
            {heroBg?.description ||
              'The Galgotias Centre for Drone Intelligence & Simulation (GCDIS), Galgotias University, supports education and research in aerial robotics and flight simulation, and organises the Drone Soccer Championship 2026.'}
          </p>

          <div style={{ animationDelay: '0.85s' }}
            className="hero-rise mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            {heroButtons.map((cta) => (
            <Magnetic key={`${cta.href}-${cta.label}`} className="w-full sm:w-auto">
            <Link
              href={cta.href}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-white/30 bg-white/5 px-6 py-3 text-xs font-black uppercase tracking-wider text-white whitespace-nowrap backdrop-blur-sm transition-colors hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:w-60"
            >
              {cta.label}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
            </Magnetic>
            ))}
          </div>

          {/* Highlights strip: GCDIS areas, each tile links to its section (edited under Home Page Sections) */}
          {highlights.length > 0 && (
          <ul
            aria-label="Explore GCDIS"
            style={{ animationDelay: '0.97s' }}
            className={`hero-rise mx-auto mt-12 grid max-w-3xl grid-cols-1 divide-y divide-white/10 overflow-hidden rounded-2xl border border-white/10 bg-white/5 backdrop-blur-md sm:divide-x sm:divide-y-0 ${
              highlights.length === 1 ? 'sm:grid-cols-1' : highlights.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3'
            }`}
          >
            {highlights.map((fact, i) => {
              const body = (
                <>
                  <span className="block font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">{fact.label}</span>
                  <span className="mt-1 flex items-center justify-center gap-2 text-lg font-black tracking-tight text-white sm:text-xl">
                    {fact.value}
                    {fact.url && (
                      <ArrowRight
                        className="h-4 w-4 text-[#22C55E] transition-transform duration-200 group-hover:translate-x-1 motion-reduce:transition-none"
                        aria-hidden="true"
                      />
                    )}
                  </span>
                </>
              );
              return (
                <li key={`${i}-${fact.label}`}>
                  {fact.url ? (
                    <Link
                      href={fact.url}
                      className="group block px-6 py-4 transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className="px-6 py-4">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
          )}
        </div>

        {/* Scroll cue (to the news section, when it is shown) */}
        {!hiddenAnchors.includes('news') && (
        <motion.a
          href="#news"
          aria-label="Scroll to the latest bulletin"
          className="absolute bottom-6 left-1/2 hidden -translate-x-1/2 text-slate-300 transition-colors hover:text-white sm:block"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.6, duration: 0.6 }}
        >
          <motion.span
            className="block"
            animate={reduceMotion ? undefined : { y: [0, 6, 0] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
          >
            <ChevronDown className="h-6 w-6" aria-hidden="true" />
          </motion.span>
        </motion.a>
        )}
      </section>

      {/* GREEN LIVE MARQUEE TICKER (continuous, pauses on hover, static when reduced motion is requested) */}
      {showTicker && content.ticker.items.length > 0 && (
      <div className="overflow-hidden border-y border-[#16A34A] bg-[#22C55E] py-2.5 text-xs font-bold uppercase tracking-wider text-slate-950 shadow-inner">
        <div className={`flex w-max whitespace-nowrap ${reduceMotion ? '' : 'animate-ticker hover:[animation-play-state:paused]'}`}>
          {[0, 1].map((copy) => (
            <div key={copy} className="flex items-center gap-10 pr-10" aria-hidden={copy === 1 ? true : undefined}>
              {content.ticker.items.map((item, i) => (
                <span key={`${i}-${item}`} className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-slate-950" aria-hidden="true" />
                  {item}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
      )}

      <HomeBento
        content={content}
        order={order}
        hiddenAnchors={hiddenAnchors}
        sponsors={sponsors ?? []}
        gallery={gallery ?? []}
        galleryTitle={gallerySection.title}
        announcement={
          heroBg?.announcementTitle
            ? { title: heroBg.announcementTitle, body: heroBg.announcementBody, date: heroBg.announcementDate }
            : null
        }
      />

      </main>

      <BentoFooter content={content.footer} hiddenAnchors={hiddenAnchors} />
    </div>
    </MotionConfig>
  );
}

'use client';

/**
 * Body of the single-page championship event site, below the hero: a sticky in-page navigation with
 * scroll-spy, then the anchored sections (key facts, how to take part, categories, the drones and arena
 * gallery, programme and fixtures, prizes, rules, teams, live scores, sponsors, venue and contact, and the
 * final call to action), as a bento card grid in a restrained, formal palette.
 *
 * Fixtures and teams are loaded from the API; live scores arrive over Socket.io, with a 30-second polling
 * fallback while the live connection is unavailable. Fragments of the former tabbed page (#schedule,
 * #scoring, #overview and so on) are mapped to their new sections (lib/championship-event.ts).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { ArrowRight, Building2, CalendarClock, Camera, Download, ExternalLink, Handshake, Mail, MapPin, Maximize2, Phone, Radio, Search, Trophy, Users } from 'lucide-react';
import { fetchApi } from '@/lib/api-client';
import { useMatchSocket, type LiveFixtureUpdate } from '@/lib/useMatchSocket';
import {
  formatMatchTime,
  formatStage,
  formatStatus,
  isInProgress,
  mergeFixtureUpdate,
  normalizeFixtures,
  pickLiveFixture,
  type PublicFixture
} from '@/lib/fixtures';
import {
  CHAMPIONSHIP_DAYS,
  CLASS_20_ARENA,
  CLASS_SPECS,
  FIDA_EDITION,
  FIDA_NAME,
  MAX_COACHES,
  MAX_ROSTER,
  MINUTES_PER_SET,
  PLAYERS_PER_TEAM,
  PRIZE_POOL_INR,
  SETS_PER_MATCH,
  formatInr,
  type ClassSpec
} from '@/lib/championship';
import {
  EVENT_DATES_LABEL,
  EVENT_DAY_COUNT,
  EVENT_SECTIONS,
  TAKE_PART_STEPS,
  feeLabel,
  registrationStatus,
  sectionFromHash,
  venueLabel,
  type EventDetails,
  type EventSectionId
} from '@/lib/championship-event';
import {
  GALLERY_KINDS,
  GALLERY_KIND_LABELS,
  type ChampionshipGalleryItem,
  type ChampionshipSectionMedia,
  type GalleryContent,
  type GalleryKind,
  type SlotMedia
} from '@/lib/championship-media';
import type { GalleryImage, Sponsor } from '@/lib/site-content';
import { usePlacementSponsors, useSiteContent, useSiteInfo } from '@/components/site/SiteContentProvider';
import { CmsImage } from '@/components/site/CmsImage';
import { GalleryLightbox } from '@/components/site/GallerySection';
import { Accordion } from '@/components/motion/Accordion';
import { AnimatedScore } from '@/components/motion/AnimatedScore';
import { Stagger } from '@/components/home-bento/Section';
import { useReduce } from '@/components/home-bento/hooks';
import { useEventCountdown } from '@/components/home-bento/Countdown';
import { pad2 } from '@/lib/countdown';
import { EASE } from '@/components/home-bento/tokens';
import {
  ACCENT_TEXT,
  ACCENT_TEXT_DARK,
  ANCHOR,
  BTN_OUTLINE,
  BTN_OUTLINE_DARK,
  BTN_PRIMARY,
  CONTAINER,
  Card,
  Counter,
  EmptyState,
  EventSection,
  FOCUS,
  FOCUS_DARK,
  H2,
  SectionTitle,
  TimelineLine,
  Tilt,
  cx
} from './EventPrimitives';
import { CardMedia, MediaBackdrop, MediaBanner, SectionMediaProvider, useSectionMedia } from './SectionMedia';

interface PublicTeam {
  id: string;
  name?: string;
  institutionName?: string;
  institute?: string;
  city?: string;
  country?: string;
  category?: { name?: string; slug?: string } | string | null;
}

type RawFixture = Record<string, unknown>;

/** Bottom of the floating site navbar plus the sticky section nav (scroll-spy threshold, in px). */
const SPY_OFFSET = 150;
const POLL_INTERVAL_MS = 30_000;
const LABEL = 'font-mono text-[11px] font-bold uppercase tracking-[0.2em]';

/* ------------------------------------------------------------------ */
/* Sticky section navigation with scroll-spy                           */
/* ------------------------------------------------------------------ */

/** Compact countdown for the sticky nav ("46d 07h 41m"), or the live state. */
function NavCountdown({ startsAt, endsAt }: { startsAt: string; endsAt: string }) {
  const { parts, phase } = useEventCountdown(startsAt, endsAt);
  if (phase === 'ended' || phase === null) return null;
  if (phase === 'live') {
    return (
      <a href="#scores" className={cx('hidden items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-wider text-white md:inline-flex', FOCUS_DARK)}>
        <span className="radar-live-badge h-1.5 w-1.5 rounded-full bg-[#16A34A]" aria-hidden="true" />
        Live now
      </a>
    );
  }
  if (!parts) return null;
  return (
    <p className="hidden items-center gap-2 whitespace-nowrap font-mono text-[11px] font-bold uppercase tracking-wider md:flex">
      <span className="text-slate-300">Starts in</span>
      <span className="tabular-nums text-white">
        {parts.days}d {pad2(parts.hours)}h {pad2(parts.minutes)}m
      </span>
    </p>
  );
}

function SectionNav({
  sections,
  startsAt,
  endsAt,
  registrationOpen
}: {
  sections: readonly { id: EventSectionId; label: string }[];
  startsAt: string;
  endsAt: string;
  registrationOpen: boolean;
}) {
  const [active, setActive] = useState<EventSectionId | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const linkRefs = useRef<Partial<Record<EventSectionId, HTMLAnchorElement | null>>>({});
  const reduce = useReduce();
  // The final call-to-action section is not listed: the hero and section buttons lead to registration
  // (the sticky nav has no Register button, at the owner's request).
  const links = sections.filter((s) => s.id !== 'register');

  // Scroll-spy: the active section is the last one whose top has passed below the sticky bars.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      let current: EventSectionId | null = null;
      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= SPY_OFFSET) current = s.id;
      }
      // At the very bottom of the page the last section is active even if it is short.
      if (current && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = sections[sections.length - 1].id;
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [sections]);

  // Keep the active link visible inside the horizontally scrolling strip (only the strip scrolls).
  useEffect(() => {
    const list = listRef.current;
    const link = active ? linkRefs.current[active] : null;
    if (!list || !link || list.scrollWidth <= list.clientWidth) return;
    const left = link.offsetLeft - (list.clientWidth - link.offsetWidth) / 2;
    list.scrollTo({ left: Math.max(0, left), behavior: reduce ? 'auto' : 'smooth' });
  }, [active, reduce]);

  return (
    <nav aria-label="Championship sections" className="sticky top-[4.75rem] z-30 border-b border-white/10 bg-[#0F172A]/95 text-white backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
        <LayoutGroup id="event-nav">
          <ul ref={listRef} className="scrollbar-none -ml-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-2 [mask-image:linear-gradient(90deg,black_calc(100%-32px),transparent)]">
            {links.map((s) => {
              const isActive = active === s.id;
              return (
                <li key={s.id} className="shrink-0">
                  <a
                    ref={(el) => {
                      linkRefs.current[s.id] = el;
                    }}
                    href={`#${s.id}`}
                    aria-current={isActive ? 'true' : undefined}
                    className={cx(
                      'relative isolate inline-flex min-h-[40px] items-center whitespace-nowrap rounded-full px-3.5 text-[11px] font-bold uppercase tracking-wider transition-colors',
                      isActive ? 'text-white' : 'text-slate-300 hover:text-white',
                      FOCUS_DARK
                    )}
                  >
                    {isActive && (
                      <motion.span
                        layoutId="event-nav-pill"
                        className="absolute inset-0 -z-10 rounded-full bg-[#15803D]"
                        transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 36 }}
                        aria-hidden="true"
                      />
                    )}
                    {s.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </LayoutGroup>
        <NavCountdown startsAt={startsAt} endsAt={endsAt} />
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* Key facts                                                           */
/* ------------------------------------------------------------------ */

function FactsSection({ details }: { details: EventDetails | null }) {
  const d20Fee = feeLabel(details, 'd20');
  const d40Fee = feeLabel(details, 'd40');
  const big = 'block text-[clamp(2.5rem,5vw,3.75rem)] font-extrabold leading-none tracking-[-0.04em] text-slate-950';
  const media = useSectionMedia('facts');
  return (
    <EventSection id="facts" labelledBy="facts-heading" tone="white">
      <SectionTitle id="facts-heading" eyebrow="Key facts" title="The championship in numbers" />
      <MediaBanner media={media.own} fallbackAlt="Drone Soccer Championship 2026" />
      <Stagger className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <Card dark wrapperClassName="sm:col-span-2 lg:row-span-2" className="relative flex min-h-[260px] flex-col justify-between overflow-hidden !bg-[#15803D] p-7 text-white">
          <p className={cx(LABEL, 'flex items-center gap-2 text-white')}>
            <Trophy className="h-4 w-4 text-white" aria-hidden="true" />
            Prize pool
          </p>
          <div>
            <Counter value={PRIZE_POOL_INR} format="inr" className="block text-[clamp(3rem,7.5vw,5.75rem)] font-extrabold leading-none tracking-[-0.045em]" />
            <p className="mt-3 text-sm text-white">Cash prizes and trophies across both classes</p>
          </div>
        </Card>
        <Card className="flex flex-col justify-between p-6">
          <p className={cx(LABEL, 'text-slate-600')}>Classes</p>
          <div>
            <Counter value={2} format="plain" className={big} />
            <p className="mt-2 text-sm text-slate-600">
              {CLASS_SPECS.d20.name} (D20) and {CLASS_SPECS.d40.name} (D40)
            </p>
          </div>
        </Card>
        <Card className="flex flex-col justify-between p-6">
          <p className={cx(LABEL, 'text-slate-600')}>Days</p>
          <div>
            <Counter value={EVENT_DAY_COUNT} format="plain" className={big} />
            <p className="mt-2 text-sm text-slate-600">{EVENT_DATES_LABEL}</p>
          </div>
        </Card>
        {(d20Fee || d40Fee) && (
          <Card className="flex flex-col justify-between p-6">
            <p className={cx(LABEL, 'text-slate-600')}>Entry fee per team</p>
            <div className="space-y-1">
              {d20Fee && (
                <p className="text-2xl font-extrabold tracking-tight text-slate-950">
                  <span className="mr-2 font-mono text-xs font-bold text-slate-600">D20</span>
                  {d20Fee}
                </p>
              )}
              {d40Fee && (
                <p className="text-2xl font-extrabold tracking-tight text-slate-950">
                  <span className="mr-2 font-mono text-xs font-bold text-slate-600">D40</span>
                  {d40Fee}
                </p>
              )}
              <p className={cx('pt-1 text-xs font-bold uppercase tracking-wider', ACCENT_TEXT)}>GST-inclusive</p>
            </div>
          </Card>
        )}
        <Card className="flex flex-col justify-between p-6">
          <p className={cx(LABEL, 'flex items-center gap-2 text-slate-600')}>
            <Users className="h-4 w-4" aria-hidden="true" />
            Team members
          </p>
          <div>
            <Counter value={MAX_ROSTER} format="plain" className={big} />
            <p className="mt-2 text-sm text-slate-600">
              Up to {MAX_ROSTER} members, at most {MAX_COACHES} of them coaches
            </p>
          </div>
        </Card>
      </Stagger>
    </EventSection>
  );
}

/* ------------------------------------------------------------------ */
/* How to take part                                                    */
/* ------------------------------------------------------------------ */

function TakePartSection() {
  const ref = useRef<HTMLOListElement>(null);
  const media = useSectionMedia('takePart');
  return (
    <EventSection id="take-part" labelledBy="take-part-heading" tone="navy">
      <SectionTitle
        id="take-part-heading"
        eyebrow="How to take part"
        title="From sign-up to the arena"
        lead="Registration runs entirely through the Team Portal. These are the steps every team follows."
        dark
      />
      <MediaBanner media={media.own} dark fallbackAlt="Teams taking part in the Drone Soccer Championship" />

      <ol ref={ref} className="relative mt-14 grid grid-cols-1 gap-7 pl-12 lg:grid-cols-8 lg:gap-4 lg:pl-0 lg:pt-14">
        <TimelineLine target={ref} orientation="y" dark className="bottom-4 left-[15px] top-2 w-0.5 lg:hidden" />
        <TimelineLine target={ref} orientation="x" dark className="left-4 right-4 top-[15px] hidden h-0.5 lg:block" />
        {TAKE_PART_STEPS.map((step, i) => (
          <motion.li
            key={step.title}
            className="relative"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-40px' }}
            transition={{ duration: 0.5, ease: EASE, delay: (i % 4) * 0.06 }}
          >
            <span
              aria-hidden="true"
              className="absolute -left-12 top-0 flex h-8 w-8 items-center justify-center rounded-full border border-[#4ADE80]/60 bg-[#0F172A] font-mono text-[11px] font-bold text-white lg:-top-14 lg:left-0"
            >
              {String(i + 1).padStart(2, '0')}
            </span>
            <h3 className="text-sm font-bold uppercase leading-tight tracking-wide text-white lg:mt-2">
              <span className="sr-only">Step {i + 1}: </span>
              {step.title}
            </h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-slate-400">{step.detail}</p>
          </motion.li>
        ))}
      </ol>

      <div className="mt-14 flex flex-col gap-3 sm:flex-row">
          <Link href="/portal" className={cx(BTN_PRIMARY, FOCUS_DARK, 'w-full sm:w-auto')}>
            Open the Team Portal
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        <Link href="/portal" className={cx(BTN_OUTLINE_DARK, FOCUS_DARK)}>
          Already registered? Sign in
        </Link>
      </div>
    </EventSection>
  );
}

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

const CLASS_40_ARENA = '10–20 m × 5–10 m × 4–5 m';

function CategoryCard({ spec, fee, media }: { spec: ClassSpec; fee: string | null; media?: SlotMedia }) {
  const rows: [string, string][] = [
    ['Drone ball diameter', spec.ballDiameter],
    ['Maximum weight in play', spec.maxWeight],
    ['Players per match', `${PLAYERS_PER_TEAM} per team`],
    ['Strikers', spec.strikerSummary],
    ['Team roster', `Up to ${MAX_ROSTER} (maximum ${MAX_COACHES} coaches)`],
    ['Goal inner diameter', spec.goalDiameter],
    ['Arena size', spec.id === 'd20' ? CLASS_20_ARENA : CLASS_40_ARENA]
  ];
  return (
    <Tilt id={spec.id} className="h-full">
      <Card as="article" reveal={false} wrapperClassName="h-full" className="flex h-full flex-col p-6 sm:p-8">
        <CardMedia media={media} fallbackAlt={`${spec.name} (${spec.shortName}) drone`} className="mb-6" />
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className={cx(LABEL, 'text-slate-600')}>Entry category</p>
            <h3 className="mt-2 text-2xl font-extrabold uppercase tracking-tight text-slate-950">{spec.name}</h3>
          </div>
          <span aria-hidden="true" className="text-[clamp(2.75rem,6vw,4.25rem)] font-extrabold leading-none tracking-[-0.05em] text-slate-200">
            {spec.shortName}
          </span>
        </div>

        {fee && (
          <p className="mt-4 flex flex-wrap items-baseline gap-x-2">
            <span className="text-3xl font-extrabold tracking-tight text-slate-950">{fee}</span>
            <span className="text-xs text-slate-600">entry fee per team, GST-inclusive</span>
          </p>
        )}

        <dl className="mt-6 flex-1 divide-y divide-slate-100 border-y border-slate-200 text-[13px]">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 py-2.5">
              <dt className="text-slate-600">{label}</dt>
              <dd className="text-right font-mono font-semibold text-slate-900">{value}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Link href="/portal" className={cx(BTN_PRIMARY, FOCUS, 'flex-1')}>
            Register for {spec.shortName}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
          <a href={spec.rulebookUrl} target="_blank" rel="noreferrer" className={cx(BTN_OUTLINE, FOCUS, 'flex-1')}>
            <Download className="h-4 w-4" aria-hidden="true" />
            Rulebook
            <span className="sr-only"> for {spec.name} (PDF, opens in a new tab)</span>
          </a>
        </div>
      </Card>
    </Tilt>
  );
}

function CategoriesSection({ details }: { details: EventDetails | null }) {
  const media = useSectionMedia('categories');
  return (
    <EventSection id="categories" labelledBy="categories-heading" tone="mist">
      <SectionTitle
        id="categories-heading"
        eyebrow="Categories"
        title="Two classes, one arena"
        lead={`Both classes are played under the ${FIDA_NAME} (FIDA) Dronesoccer Regulations, ${FIDA_EDITION}.`}
      />
      <MediaBanner media={media.own} fallbackAlt="Class 20 and Class 40 drone balls" />
      <motion.div
        className="mt-12 grid grid-cols-1 gap-8 md:grid-cols-2"
        initial={{ opacity: 0, y: 28 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-80px' }}
        transition={{ duration: 0.7, ease: EASE }}
      >
        <CategoryCard spec={CLASS_SPECS.d20} fee={feeLabel(details, 'd20')} media={media.items.d20} />
        <CategoryCard spec={CLASS_SPECS.d40} fee={feeLabel(details, 'd40')} media={media.items.d40} />
      </motion.div>
    </EventSection>
  );
}

/* ------------------------------------------------------------------ */
/* Drones and arena gallery                                            */
/* ------------------------------------------------------------------ */

function toLightboxImage(item: ChampionshipGalleryItem, index: number): GalleryImage {
  const label = GALLERY_KIND_LABELS[item.kind];
  return {
    id: item.id,
    imageUrl: item.imageUrl,
    title: item.caption ?? `${label} photograph`,
    caption: item.caption,
    altText: item.alt ?? item.caption ?? `${label} photograph, Drone Soccer Championship`,
    category: label,
    displayOrder: index,
    width: null,
    height: null
  };
}

function GallerySection({ content }: { content: GalleryContent }) {
  const { items, isFallback } = content;
  const [kind, setKind] = useState<GalleryKind | 'all'>('all');
  const [open, setOpen] = useState<number | null>(null);
  const reduce = useReduce();
  const filtered = useMemo(() => items.filter((i) => kind === 'all' || i.kind === kind), [items, kind]);
  const images = useMemo(() => filtered.map(toLightboxImage), [filtered]);
  const mosaic = filtered.length >= 3;

  return (
    <EventSection id="gallery" labelledBy="gallery-heading" tone="white">
      <SectionTitle
        id="gallery-heading"
        eyebrow="Gallery"
        title="Drones & arena"
        lead={isFallback ? 'Photographs from the Galgotias Centre for Drone Intelligence & Simulation.' : 'The drones, the arena and the championship in pictures.'}
      />

      {/* Filter chips: a kind without photographs is shown disabled */}
      <div role="group" aria-label="Filter photographs" className="mt-8 flex flex-wrap gap-2">
        {(['all', ...GALLERY_KINDS] as const).map((k) => {
          const count = k === 'all' ? items.length : items.filter((i) => i.kind === k).length;
          const selected = kind === k;
          return (
            <button
              key={k}
              type="button"
              aria-pressed={selected}
              disabled={count === 0}
              onClick={() => setKind(k)}
              className={cx(
                'inline-flex min-h-[44px] items-center gap-2 rounded-full border-[2.5px] border-bento-ink px-4 text-[11px] font-extrabold uppercase tracking-wider transition-colors duration-200 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-transparent disabled:text-slate-500',
                selected ? 'bg-[#4ADE80] text-bento-ink' : 'bg-white text-bento-ink hover:bg-[#4ADE80]/40',
                FOCUS
              )}
            >
              {k === 'all' ? 'All' : GALLERY_KIND_LABELS[k]}
              <span className={cx('rounded-full px-1.5 text-[10px]', selected ? 'bg-bento-ink text-white' : 'bg-bento-ink/10')}>{count}</span>
            </button>
          );
        })}
      </div>

      <motion.ul layout className={cx('mt-8 grid gap-5', mosaic ? 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4' : 'grid-cols-1 md:grid-cols-3')}>
        <AnimatePresence initial={false} mode="popLayout">
          {filtered.map((item, i) => (
            <motion.li
              key={item.id}
              layout
              initial={{ opacity: 0, scale: 0.94 }}
              whileInView={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={reduce ? { duration: 0 } : { duration: 0.55, ease: EASE, delay: Math.min(i, 6) * 0.05 }}
              className={cx(mosaic && i === 0 && 'col-span-2 row-span-2', !mosaic && i === 0 && 'md:col-span-2 md:row-span-2')}
            >
              <button
                type="button"
                onClick={() => setOpen(i)}
                className={cx(
                  'group relative block h-full min-h-[180px] w-full overflow-hidden rounded-[18px] border-[2.5px] border-bento-ink bg-slate-200 shadow-[5px_5px_0_#111] transition-[transform,box-shadow] duration-200 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[8px_8px_0_#111] motion-reduce:transform-none',
                  mosaic ? 'aspect-[4/3]' : 'aspect-[16/10]',
                  FOCUS
                )}
              >
                <CmsImage
                  src={item.imageUrl}
                  alt={images[i]?.altText ?? ''}
                  sizes="(min-width: 1024px) 50vw, (min-width: 768px) 66vw, 100vw"
                  className="object-cover transition-transform duration-700 ease-out group-hover:scale-[1.06] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
                />
                <span className="pointer-events-none absolute left-3 top-3 rounded-md border-2 border-bento-ink bg-white px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-bento-ink">
                  {GALLERY_KIND_LABELS[item.kind]}
                </span>
                <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/75 to-transparent p-3 text-left text-white">
                  <span className="text-xs font-semibold">{item.caption ?? GALLERY_KIND_LABELS[item.kind]}</span>
                  <Maximize2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                </span>
                <span className="sr-only">Open the photograph{item.caption ? `: ${item.caption}` : ''}</span>
              </button>
            </motion.li>
          ))}
        </AnimatePresence>
        <motion.li layout key="coming-soon" className={cx(!mosaic && 'md:col-span-1')}>
          <div className="flex h-full min-h-[180px] flex-col justify-center gap-3 rounded-[18px] border-[2.5px] border-dashed border-bento-ink bg-[#EFF6FF] p-6">
            <Camera className="h-6 w-6" aria-hidden="true" />
            <p className="text-sm font-extrabold">More photos of our drones and arena are coming soon.</p>
          </div>
        </motion.li>
      </motion.ul>

      {open !== null && images[open] && <GalleryLightbox images={images} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />}
    </EventSection>
  );
}

/* ------------------------------------------------------------------ */
/* Programme and fixtures                                              */
/* ------------------------------------------------------------------ */

function StatusBadge({ status }: { status: string }) {
  const live = isInProgress(status);
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase',
        live ? 'border-[#16A34A]/60 text-[#86EFAC]' : 'border-white/20 text-slate-300'
      )}
    >
      {live && <span className="radar-live-badge h-1.5 w-1.5 rounded-full bg-[#16A34A]" aria-hidden="true" />}
      {formatStatus(status)}
    </span>
  );
}

function ProgrammeSection({ fixtures, loading }: { fixtures: PublicFixture[]; loading: boolean }) {
  const ref = useRef<HTMLOListElement>(null);
  const media = useSectionMedia('programme');
  return (
    <EventSection id="programme" labelledBy="programme-heading" tone="navy">
      <SectionTitle id="programme-heading" eyebrow="Programme" title="Two days of drone soccer" lead={EVENT_DATES_LABEL} dark />
      <MediaBanner media={media.own} dark fallbackAlt="The championship programme" />

      <ol ref={ref} className="relative mt-14 grid grid-cols-1 gap-6 pl-12 lg:grid-cols-2 lg:gap-6 lg:pl-0 lg:pt-14">
        <TimelineLine target={ref} orientation="y" dark className="bottom-6 left-[15px] top-4 w-0.5 lg:hidden" />
        <TimelineLine target={ref} orientation="x" dark className="left-4 right-4 top-[15px] hidden h-0.5 lg:block" />
        {CHAMPIONSHIP_DAYS.map((day, i) => (
          <motion.li
            key={day.day}
            className="relative"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-40px' }}
            transition={{ duration: 0.6, ease: EASE, delay: i * 0.08 }}
          >
            <span
              aria-hidden="true"
              className="absolute -left-12 top-5 flex h-8 w-8 items-center justify-center rounded-full border border-[#4ADE80]/60 bg-[#0F172A] font-mono text-xs font-bold text-white lg:-top-14 lg:left-0"
            >
              {i + 1}
            </span>
            <Card dark reveal={false} className="p-6">
              <CardMedia media={media.items[`day${i + 1}`]} dark fallbackAlt={`${day.day}: ${day.title}`} className="mb-5" />
              <p className={cx(LABEL, ACCENT_TEXT_DARK)}>
                {day.day} · {day.date}
              </p>
              <h3 className="mt-2 text-xl font-extrabold uppercase leading-tight tracking-tight">{day.title}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-slate-300">{day.detail}</p>
            </Card>
          </motion.li>
        ))}
      </ol>

      <div id="fixtures" className="mt-16 scroll-mt-36">
        <h3 className="flex items-center gap-2 text-lg font-bold uppercase tracking-wide">
          <CalendarClock className="h-5 w-5 text-slate-400" aria-hidden="true" />
          Match fixtures
        </h3>
        <p className="mt-1 text-[13px] text-slate-400">Times are shown in Indian Standard Time (IST).</p>
        <div className="mt-6">
          {loading ? (
            <EmptyState dark>Loading the match fixtures…</EmptyState>
          ) : fixtures.length === 0 ? (
            <EmptyState dark>No matches have been scheduled yet. Fixtures will be published here after technical inspection.</EmptyState>
          ) : (
            <ul className="space-y-3">
              {fixtures.map((f) => {
                const time = formatMatchTime(f.scheduledStart);
                return (
                  <li key={f.id} className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.04] p-4 sm:flex-row sm:items-center">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] uppercase text-slate-400">
                        {f.matchNumber !== null && <span className="font-bold text-slate-200">Match {f.matchNumber}</span>}
                        <span>{formatStage(f.stage)}</span>
                        {f.categoryName && <span>· {f.categoryName}</span>}
                        {f.arenaName && <span>· {f.arenaName}</span>}
                      </p>
                      <p className="mt-1 text-sm font-bold [overflow-wrap:anywhere]">
                        {f.team1.name} <span className="font-normal text-slate-400">vs</span> {f.team2.name}
                      </p>
                      {time && <p className="mt-1 font-mono text-[10px] text-slate-400">{time} IST</p>}
                    </div>
                    <div className="flex w-full items-center justify-between gap-4 sm:w-auto sm:justify-end">
                      <p className="font-mono text-lg font-bold">
                        <AnimatedScore value={f.team1.score} label={`${f.team1.name} score`} />
                        <span className="px-1 text-slate-600" aria-hidden="true">
                          :
                        </span>
                        <AnimatedScore value={f.team2.score} label={`${f.team2.name} score`} />
                      </p>
                      <StatusBadge status={f.status} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </EventSection>
  );
}

/* ------------------------------------------------------------------ */
/* Prizes                                                              */
/* ------------------------------------------------------------------ */

function PrizesSection() {
  const media = useSectionMedia('prizes');
  return (
    <EventSection id="prizes" labelledBy="prizes-heading" tone="white">
      <SectionTitle id="prizes-heading" eyebrow="Prizes" title="Prizes and trophies" />
      <MediaBanner media={media.own} fallbackAlt="Championship trophies" />
      <Stagger className="mt-12 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card dark className="flex min-h-[220px] flex-col justify-between !bg-[#15803D] p-7 text-white">
          <p className={cx(LABEL, 'text-white')}>Total prize pool</p>
          <Counter value={PRIZE_POOL_INR} format="inr" duration={1.8} className="block text-[clamp(2.75rem,5.5vw,4.25rem)] font-extrabold leading-none tracking-[-0.045em]" />
        </Card>
        {[CLASS_SPECS.d20, CLASS_SPECS.d40].map((spec) => (
          <Card key={spec.id} as="article" className="p-7">
            <CardMedia media={media.items[spec.id]} fallbackAlt={`${spec.name} (${spec.shortName}) prizes`} className="mb-6" />
            <h3 className="flex items-center gap-3 text-lg font-extrabold uppercase tracking-tight text-slate-950">
              <Trophy className="h-5 w-5 text-slate-400" aria-hidden="true" />
              {spec.name} ({spec.shortName})
            </h3>
            <ul className="mt-6 space-y-4">
              {spec.prizes.map((p, i) => (
                <li key={p.place} className="flex items-end justify-between gap-4 border-b border-slate-100 pb-4 last:border-b-0 last:pb-0">
                  <div>
                    <p className={cx(LABEL, i === 0 ? ACCENT_TEXT : 'text-slate-600')}>{p.place}</p>
                    <p className="mt-1 text-[13px] text-slate-600">{p.award}</p>
                  </div>
                  <Counter value={p.amount} format="inr" className="text-[clamp(1.6rem,3vw,2.25rem)] font-extrabold leading-none tracking-tight text-slate-950" />
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </Stagger>
    </EventSection>
  );
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

const RULE_SECTIONS = [
  {
    title: 'Drone Ball Specifications',
    text: `Each drone must be enclosed in a rounded exoskeleton that is not easily damaged during play. Class 20: diameter ${CLASS_SPECS.d20.ballDiameter}, maximum weight in play ${CLASS_SPECS.d20.maxWeight}, and open area of any single exoskeleton surface not exceeding 70 cm². Class 40: diameter ${CLASS_SPECS.d40.ballDiameter}, maximum weight in play ${CLASS_SPECS.d40.maxWeight}, and open area of any single surface not exceeding 150 cm². Drone balls of different types may not be used in the same competition. Teams are identified by red or blue LEDs, and Strikers carry an identification tag; a goal scored after a Striker's tag has become detached, such that the Striker can no longer be identified, is not counted.`
  },
  {
    title: 'Teams and Players',
    text: `A team roster may include up to ${MAX_ROSTER} members, of whom no more than ${MAX_COACHES} may be coaches. Each team plays with ${PLAYERS_PER_TEAM} players, each controlling one drone ball; a match may proceed with a minimum of 3 players. In Class 40, only the Striker may score, and the Guide may replace a Striker who withdraws. In Class 20, two players per team are designated as Strikers. Substitutions are permitted only between sets.`
  },
  {
    title: 'Scoring and Defence',
    text: `A goal is awarded when a Striker's drone ball passes completely through the opponent's goal from front to back. After scoring, the attacking team is offside and may not score again until all of its drone balls in the opponent's half have returned behind the half line. Defenders may pass through their own goal from front to back, but entering a goal from the back is not permitted. Goal inner diameter: ${CLASS_SPECS.d20.goalDiameter} (Class 20) and ${CLASS_SPECS.d40.goalDiameter} (Class 40).`
  },
  {
    title: 'Match Format, Penalties and Safety',
    text: `A match consists of ${SETS_PER_MATCH} sets of ${MINUTES_PER_SET} minutes each, with a repair interval of at least 5 minutes between sets; time-outs are not permitted. In Class 20, the first team to win two sets wins the match; in Class 40, a team with one win and two drawn sets is also declared the winner. Scoring while offside, entering a goal from the back, and two accumulated warnings each result in a penalty kick for the opposing team. Using a drone ball to threaten or endanger any person results in loss of the game. Radio equipment must comply with the applicable laws of India and must not interfere with other players.`
  },
  {
    title: 'Technical Queries',
    text: 'Registered teams may submit technical queries through the Team Portal under Doubt Session 2. In the event of any discrepancy between this website and the official FIDA rulebooks, the rulebooks prevail.'
  }
];

const KEY_RULES = [
  { value: `${SETS_PER_MATCH} × ${MINUTES_PER_SET}`, label: 'Sets × minutes' },
  { value: String(PLAYERS_PER_TEAM), label: 'Players per side' },
  { value: `${MAX_ROSTER} / ${MAX_COACHES}`, label: 'Roster / coaches' }
];

function RulesSection() {
  const media = useSectionMedia('rules');
  return (
    <EventSection id="rules" labelledBy="rules-heading" tone="mist">
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div>
          <SectionTitle
            id="rules-heading"
            eyebrow="Rules and regulations"
            title="Know the rulebook"
            lead={`A summary of the Dronesoccer Regulations of the ${FIDA_NAME} (FIDA), ${FIDA_EDITION}, in effect from 1 January 2026. In the event of any discrepancy, the official FIDA rulebooks prevail.`}
          />
          <ul className="mt-8 grid grid-cols-3 gap-3">
            {KEY_RULES.map((r) => (
              <li key={r.label} className="rounded-xl border border-slate-200 bg-white p-3 text-center">
                <p className="font-mono text-lg font-bold text-slate-950 sm:text-xl">{r.value}</p>
                <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-slate-600">{r.label}</p>
              </li>
            ))}
          </ul>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row lg:flex-col xl:flex-row">
            {[CLASS_SPECS.d20, CLASS_SPECS.d40].map((spec) => (
              <a key={spec.id} href={spec.rulebookUrl} target="_blank" rel="noreferrer" className={cx(BTN_OUTLINE, FOCUS, 'flex-1')}>
                <Download className="h-4 w-4" aria-hidden="true" />
                FIDA {spec.name} rulebook
                <span className="sr-only"> (PDF, opens in a new tab)</span>
              </a>
            ))}
          </div>
        </div>
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-40px' }} transition={{ duration: 0.6, ease: EASE }}>
          <Accordion items={RULE_SECTIONS.map((r) => ({ question: r.title, answer: r.text }))} />
        </motion.div>
      </div>
      <MediaBanner media={media.own} className="!mt-12" fallbackAlt="A drone soccer match under the FIDA rules" />
    </EventSection>
  );
}

/* ------------------------------------------------------------------ */
/* Teams                                                               */
/* ------------------------------------------------------------------ */

function teamCategory(team: PublicTeam): { key: 'd20' | 'd40' | 'other'; label: string } {
  const cat = team.category;
  const slug = typeof cat === 'object' && cat ? (cat.slug ?? '').toLowerCase() : '';
  const name = typeof cat === 'string' ? cat : typeof cat === 'object' && cat ? (cat.name ?? '') : '';
  const probe = `${slug} ${name}`.toLowerCase();
  if (probe.includes('d20') || probe.includes('class 20')) return { key: 'd20', label: 'Class 20 (D20)' };
  if (probe.includes('d40') || probe.includes('class 40')) return { key: 'd40', label: 'Class 40 (D40)' };
  return { key: 'other', label: name || 'Category to be confirmed' };
}

function TeamsSection({ teams, loading }: { teams: PublicTeam[]; loading: boolean }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'all' | 'd20' | 'd40'>('all');
  const reduce = useReduce();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return teams.filter((t) => {
      if (category !== 'all' && teamCategory(t).key !== category) return false;
      if (!q) return true;
      return [t.name, t.institutionName ?? t.institute, t.city].some((v) => (v ?? '').toLowerCase().includes(q));
    });
  }, [teams, query, category]);
  const media = useSectionMedia('teams');

  return (
    <EventSection id="teams" labelledBy="teams-heading" tone="white">
      <SectionTitle id="teams-heading" eyebrow="Teams" title="Registered teams" lead="Teams whose registrations have been approved by the organising committee." />
      <MediaBanner media={media.own} fallbackAlt="Teams at the Drone Soccer Championship" />

      <div className="mt-10 flex flex-col items-stretch justify-between gap-4 border-b border-slate-200 pb-4 md:flex-row md:items-center">
        <div role="group" aria-label="Filter by category" className="flex flex-wrap gap-2">
          {(
            [
              ['all', 'All'],
              ['d20', 'D20'],
              ['d40', 'D40']
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={category === id}
              onClick={() => setCategory(id)}
              className={cx(
                'relative isolate min-h-[40px] rounded-full border px-4 text-[11px] font-bold uppercase tracking-wider transition-colors',
                category === id ? 'border-[#0F172A] text-white' : 'border-slate-300 bg-white text-slate-700 hover:border-slate-900',
                FOCUS
              )}
            >
              {category === id && (
                <motion.span
                  layoutId="team-category-pill"
                  className="absolute inset-0 -z-10 rounded-full bg-[#0F172A]"
                  transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 36 }}
                  aria-hidden="true"
                />
              )}
              {label}
            </button>
          ))}
        </div>
        <div className="relative w-full md:w-80">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-600" aria-hidden="true" />
          <input
            aria-label="Search registered teams"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by team, institution or city"
            autoComplete="off"
            className="h-11 w-full rounded-full border border-slate-300 bg-white pl-11 pr-4 text-sm text-slate-900 placeholder:text-slate-600 focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
          />
        </div>
      </div>

      <p className="sr-only" aria-live="polite">
        {loading ? 'Loading registered teams.' : `${filtered.length} ${filtered.length === 1 ? 'team' : 'teams'} shown.`}
      </p>

      <div className="mt-10">
        {loading ? (
          <EmptyState>Loading registered teams…</EmptyState>
        ) : filtered.length === 0 ? (
          <EmptyState>{teams.length === 0 ? 'No registered teams are listed yet. Approved teams will appear here.' : 'No registered teams match the selected filters.'}</EmptyState>
        ) : (
          <motion.ul layout className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
            <AnimatePresence initial={false} mode="popLayout">
              {filtered.map((team) => {
                const cat = teamCategory(team);
                const place = [team.city, team.country].filter(Boolean).join(', ');
                return (
                  <motion.li
                    key={team.id}
                    layout
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    transition={reduce ? { duration: 0 } : { duration: 0.25, ease: EASE }}
                  >
                    <Card reveal={false} className="space-y-2 p-5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 font-mono text-[10px] font-bold text-slate-700">{cat.label}</span>
                        <span className={cx('font-mono text-[10px] font-bold uppercase', ACCENT_TEXT)}>Approved</span>
                      </div>
                      <h3 className="text-base font-bold text-slate-950 [overflow-wrap:anywhere]">{team.name || 'Unnamed team'}</h3>
                      <p className="flex items-center gap-1.5 text-[13px] text-slate-600">
                        <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {team.institutionName || team.institute || 'Institution not specified'}
                      </p>
                      {place && <p className="font-mono text-[10px] text-slate-600">{place}</p>}
                    </Card>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </motion.ul>
        )}
      </div>
    </EventSection>
  );
}

/* ------------------------------------------------------------------ */
/* Live scores                                                         */
/* ------------------------------------------------------------------ */

function ScoresSection({
  fixtures,
  loading,
  socketStatus,
  scoreboardHref
}: {
  fixtures: PublicFixture[];
  loading: boolean;
  socketStatus: ReturnType<typeof useMatchSocket>;
  scoreboardHref: string;
}) {
  const live = pickLiveFixture(fixtures);
  const others = fixtures.filter((f) => f.id !== live?.id && isInProgress(f.status));
  const reduce = useReduce();
  const media = useSectionMedia('scores');

  return (
    <EventSection id="scores" labelledBy="scores-heading" tone="navy">
      <div className="flex flex-col items-start justify-between gap-6 lg:flex-row lg:items-end">
        <SectionTitle
          id="scores-heading"
          eyebrow="Live scores"
          title="Follow every goal"
          lead="Scores confirmed by match officials are updated here automatically while matches are in progress."
          dark
        />
        <span role="status" className="inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1.5 font-mono text-[11px] font-bold uppercase text-slate-300">
          {socketStatus === 'connected' && <span className="radar-live-badge h-1.5 w-1.5 rounded-full bg-[#16A34A]" aria-hidden="true" />}
          {socketStatus === 'connected' ? 'Live connection' : socketStatus === 'connecting' ? 'Connecting…' : 'Refreshing every 30 seconds'}
        </span>
      </div>
      <MediaBanner media={media.own} dark fallbackAlt="A live drone soccer match" />

      <Card dark reveal={false} wrapperClassName="mt-10" className="relative overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          {live ? (
            <motion.div
              key={live.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={reduce ? { duration: 0 } : { duration: 0.3, ease: EASE }}
              className="grid grid-cols-1 items-center gap-6 p-6 sm:p-10 md:grid-cols-3"
            >
              <div className="space-y-1 text-center md:text-left">
                <p className="font-mono text-[10px] font-bold uppercase text-slate-400">{live.arenaName || 'Arena to be confirmed'}</p>
                <p className="text-xl font-extrabold uppercase [overflow-wrap:anywhere] sm:text-2xl">{live.team1.name}</p>
                {live.team1.institution && <p className="text-xs text-slate-400">{live.team1.institution}</p>}
              </div>
              <div className="space-y-2 text-center font-mono">
                <p className="text-5xl font-bold tracking-wider text-white sm:text-6xl">
                  <AnimatedScore value={live.team1.score} label={`${live.team1.name} score`} />
                  <span className="px-2 text-slate-600" aria-hidden="true">
                    :
                  </span>
                  <AnimatedScore value={live.team2.score} label={`${live.team2.name} score`} />
                </p>
                <p className="text-xs uppercase text-slate-400">
                  {formatStage(live.stage)} · {formatStatus(live.status)}
                  {live.currentSet !== null ? ` · Set ${live.currentSet} of ${SETS_PER_MATCH}` : ''}
                </p>
              </div>
              <div className="space-y-1 text-center md:text-right">
                <p className="font-mono text-[10px] font-bold uppercase text-slate-400">{live.categoryName || 'Drone Soccer'}</p>
                <p className="text-xl font-extrabold uppercase [overflow-wrap:anywhere] sm:text-2xl">{live.team2.name}</p>
                {live.team2.institution && <p className="text-xs text-slate-400">{live.team2.institution}</p>}
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0 : 0.2 }}
              className="space-y-3 p-8 text-center sm:p-12"
            >
              <Radio className="mx-auto h-7 w-7 text-slate-400" aria-hidden="true" />
              <p className="text-lg font-bold uppercase tracking-wide">{loading ? 'Loading live scores' : 'No match in progress'}</p>
              <p className="mx-auto max-w-md text-[13px] text-slate-400">
                {loading ? 'Retrieving the current match status.' : 'Scores will appear here as soon as the head referee starts a match. All fixtures are listed in the programme.'}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </Card>

      {others.length > 0 && (
        <div className="mt-8 space-y-2">
          <h3 className="font-mono text-[11px] font-bold uppercase text-slate-400">Other matches in progress</h3>
          <ul className="space-y-2">
            {others.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm">
                <span className="font-semibold [overflow-wrap:anywhere]">
                  {f.team1.name} <span className="font-normal text-slate-400">vs</span> {f.team2.name}
                </span>
                <span className="font-mono font-bold">
                  <AnimatedScore value={f.team1.score} /> : <AnimatedScore value={f.team2.score} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-10">
          <Link href={scoreboardHref} prefetch={false} className={cx(BTN_OUTLINE_DARK, FOCUS_DARK)}>
            Open the full scoreboard
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
      </div>
    </EventSection>
  );
}

/* ------------------------------------------------------------------ */
/* Sponsors                                                            */
/* ------------------------------------------------------------------ */

/**
 * Partners and sponsors, always shown: the EVENT sponsors' logo wall (console order, names, sponsored links)
 * when sponsors are enabled and exist; otherwise the sponsorship-opportunities card of the home page's
 * partners strip, with the Secretariat's email and telephone from the site information. No names are invented.
 */
function SponsorsSection({ sponsors, title, subtitle }: { sponsors: Sponsor[]; title: string; subtitle: string }) {
  const site = useSiteInfo();
  // The console's display order (the shared loader groups by tier first).
  const ordered = [...sponsors].sort((a, b) => a.displayOrder - b.displayOrder);
  const mail = site.email ? `mailto:${site.email}?subject=${encodeURIComponent('Sponsorship: Drone Soccer Championship 2026')}` : null;
  return (
    <EventSection id="partners" labelledBy="partners-heading" tone="mist">
      <SectionTitle
        id="partners-heading"
        eyebrow="Partners & sponsors"
        title={ordered.length > 0 ? title : 'Partners & sponsors'}
        lead={ordered.length > 0 ? subtitle || 'The organising committee gratefully acknowledges the support of the following organisations.' : undefined}
      />
      {ordered.length > 0 ? (
      <Stagger as="ul" className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {ordered.map((s) => {
            const body = (
              <>
                <span className="relative block h-16 w-full">
                  {s.logoUrl ? (
                    <CmsImage src={s.logoUrl} alt="" sizes="200px" className="object-contain" />
                  ) : (
                    <span className="flex h-full items-center justify-center text-center text-sm font-bold uppercase text-slate-700">{s.name}</span>
                  )}
                </span>
                <span className="mt-3 block border-t border-slate-100 pt-3 text-center text-xs font-semibold text-slate-700 [overflow-wrap:anywhere]">{s.name}</span>
              </>
            );
            return (
              <Card key={s.id} as="li" className="h-full">
                {s.websiteUrl ? (
                  <a href={s.websiteUrl} target="_blank" rel="noopener noreferrer sponsored" className={cx('block h-full rounded-2xl p-5', FOCUS)}>
                    {body}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ) : (
                  <div className="p-5">{body}</div>
                )}
              </Card>
            );
          })}
        </Stagger>
      ) : (
        <Card wrapperClassName="mt-10" className="flex flex-col gap-6 p-6 sm:p-8 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-[2.5px] border-bento-ink bg-[#4ADE80]" aria-hidden="true">
              <Handshake className="h-6 w-6" />
            </span>
            <div>
              <h3 className="text-lg font-extrabold uppercase tracking-tight">Sponsorship opportunities</h3>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600">
                Organisations interested in supporting the Drone Soccer Championship 2026 are invited to contact the Secretariat.
              </p>
              <ul className="mt-3 flex flex-col gap-1 text-sm sm:flex-row sm:gap-6">
                {site.email && (
                  <li className="flex items-center gap-2">
                    <Mail className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <a href={`mailto:${site.email}`} className={cx('break-all font-bold underline decoration-2 underline-offset-4 hover:decoration-[#22C55E]', FOCUS)}>
                      {site.email}
                    </a>
                  </li>
                )}
                {site.phones[0] && (
                  <li className="flex items-center gap-2">
                    <Phone className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <a href={`tel:${site.phones[0].tel}`} className={cx('font-bold underline decoration-2 underline-offset-4 hover:decoration-[#22C55E]', FOCUS)}>
                      {site.phones[0].display}
                    </a>
                  </li>
                )}
              </ul>
            </div>
          </div>
          {mail && (
            <a href={mail} className={cx(BTN_PRIMARY, FOCUS, 'shrink-0')}>
              Become a sponsor
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
          )}
        </Card>
      )}
    </EventSection>
  );
}

/* ------------------------------------------------------------------ */
/* Venue and contact                                                   */
/* ------------------------------------------------------------------ */

function VenueSection({ details }: { details: EventDetails | null }) {
  const site = useSiteInfo();
  const venue = venueLabel(details, site);
  const head = cx(LABEL, 'flex items-center gap-2 text-slate-600');
  const link = cx('font-semibold text-slate-900 underline decoration-slate-300 underline-offset-4 hover:decoration-[#15803D]', FOCUS);
  const media = useSectionMedia('venue');
  return (
    <EventSection id="venue" labelledBy="venue-heading" tone="white">
      <SectionTitle id="venue-heading" eyebrow="Venue and contact" title={venue ?? 'Venue and contact'} lead={EVENT_DATES_LABEL} />
      <MediaBanner media={media.own} fallbackAlt={venue ? `The venue: ${venue}` : 'The championship venue'} />
      <Stagger className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-3">
        {site.addressLines.length > 0 && (
          <Card className="p-6">
            <h3 className={head}>
              <MapPin className="h-4 w-4" aria-hidden="true" />
              Address
            </h3>
            <address className="mt-3 text-sm not-italic leading-relaxed text-slate-800">
              {site.addressLines.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </address>
            {site.mapUrl && (
              <a href={site.mapUrl} target="_blank" rel="noopener noreferrer" className={cx('mt-4 inline-flex items-center gap-1.5 text-xs', link)}>
                Open in maps
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
          </Card>
        )}
        {site.phones.length > 0 && (
          <Card className="p-6">
            <h3 className={head}>
              <Phone className="h-4 w-4" aria-hidden="true" />
              Telephone
            </h3>
            <ul className="mt-3 space-y-1 text-sm">
              {site.phones.map((p) => (
                <li key={p.tel}>
                  <a href={`tel:${p.tel}`} className={link}>
                    {p.display}
                  </a>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {site.email && (
          <Card className="p-6">
            <h3 className={head}>
              <Mail className="h-4 w-4" aria-hidden="true" />
              Email
            </h3>
            <a href={`mailto:${site.email}`} className={cx('mt-3 block break-all text-sm', link)}>
              {site.email}
            </a>
            <p className="mt-2 text-xs text-slate-600">Registered teams can also raise technical queries from the Team Portal.</p>
          </Card>
        )}
      </Stagger>
    </EventSection>
  );
}

/* ------------------------------------------------------------------ */
/* Final call to action                                                */
/* ------------------------------------------------------------------ */

function FinalCta() {
  const { email } = useSiteInfo();
  const media = useSectionMedia('finalCta');
  return (
    <section id="register" aria-labelledby="register-heading" className={cx('relative isolate overflow-hidden bg-[#0F172A] text-white', ANCHOR)}>
      <MediaBackdrop media={media.own} fallbackAlt="Drone Soccer Championship 2026" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 [background-image:linear-gradient(rgba(255,255,255,.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.04)_1px,transparent_1px)] [background-size:48px_48px]"
      />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_50%_120%,rgba(91,140,110,0.35),transparent_60%)]" />
      <motion.div
        className={cx(CONTAINER, 'py-20 text-center sm:py-24')}
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-80px' }}
        transition={{ duration: 0.7, ease: EASE }}
      >
        <p className={cx(LABEL, ACCENT_TEXT_DARK)}>{EVENT_DATES_LABEL}</p>
        <h2 id="register-heading" className={cx(H2, 'mx-auto mt-4 max-w-4xl')}>
          Register your team before registration closes
        </h2>
        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/portal" className={cx(BTN_PRIMARY, FOCUS_DARK, 'w-60')}>
              Register your team
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
            <a href={email ? `mailto:${email}` : '#venue'} className={cx(BTN_OUTLINE_DARK, FOCUS_DARK, 'w-60')}>
              <Mail className="h-4 w-4" aria-hidden="true" />
              Contact us
            </a>
        </div>
      </motion.div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Container                                                           */
/* ------------------------------------------------------------------ */

export function ChampionshipSections({
  details,
  gallery,
  startsAt,
  endsAt,
  sectionMedia = {}
}: {
  details: EventDetails | null;
  /** Console-managed image / video for each section and item (empty: the page is unchanged). */
  sectionMedia?: ChampionshipSectionMedia;
  /** Event window (API dates, IST fallback) for the countdown in the sticky nav. */
  startsAt: string;
  endsAt: string;
  /** Drones & Arena photographs (championship media, or the real site photographs as a fallback). */
  gallery: GalleryContent;
}) {
  const [rawFixtures, setRawFixtures] = useState<RawFixture[]>([]);
  const [teams, setTeams] = useState<PublicTeam[]>([]);
  const [fixturesLoading, setFixturesLoading] = useState(true);
  const [teamsLoading, setTeamsLoading] = useState(true);
  const [errors, setErrors] = useState<{ fixtures?: boolean; teams?: boolean }>({});
  const params = useParams<{ slug?: string }>();
  const scoreboardHref = `/events/${encodeURIComponent(params?.slug ?? 'drone-soccer-2026')}/scoreboard`;
  const rawRef = useRef<RawFixture[]>([]);
  rawRef.current = rawFixtures;
  const reduce = useReduce();

  // EVENT-placement sponsors (loaded by the layout); the section shows the sponsorship card when there are none.
  const { sponsorsSection } = useSiteContent();
  const eventSponsors = usePlacementSponsors('EVENT');
  const sponsors = sponsorsSection.enabled && sponsorsSection.showOn.event ? eventSponsors : [];
  // Every section is always rendered, so the nav lists them all.
  const sections = EVENT_SECTIONS;

  const loadFixtures = useCallback(() => {
    return fetchApi<unknown>('/competition/fixtures')
      .then((data) => {
        setRawFixtures(Array.isArray(data) ? (data as RawFixture[]) : []);
        setErrors((e) => ({ ...e, fixtures: false }));
      })
      .catch(() => setErrors((e) => ({ ...e, fixtures: true })))
      .finally(() => setFixturesLoading(false));
  }, []);

  useEffect(() => {
    loadFixtures();
    fetchApi<unknown>('/teams/public')
      .then((data) => {
        setTeams(Array.isArray(data) ? (data as PublicTeam[]).filter((t) => t && typeof t.id === 'string') : []);
        setErrors((e) => ({ ...e, teams: false }));
      })
      .catch(() => setErrors((e) => ({ ...e, teams: true })))
      .finally(() => setTeamsLoading(false));
  }, [loadFixtures]);

  // Live score updates. Summary updates are partial (scores and status), so merge them into the loaded
  // fixtures; an update for a fixture that is not in the list triggers a reload of the list.
  const socketStatus = useMatchSocket(
    (update: LiveFixtureUpdate) => {
      const merged = mergeFixtureUpdate(rawRef.current, update as Record<string, unknown>);
      if (merged === null) {
        loadFixtures();
        return;
      }
      rawRef.current = merged;
      setRawFixtures(merged);
    },
    { reconnectionAttempts: 2 }
  );

  // Fallback while the live connection is unavailable: refresh the fixtures periodically (visible tab only).
  useEffect(() => {
    if (socketStatus === 'connected' || socketStatus === 'connecting') return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') loadFixtures();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [socketStatus, loadFixtures]);

  // Deep links: fragments of the former tabs (#schedule, #scoring, #overview...) are rewritten to their new
  // section and scrolled to. On load the scroll is repeated once the fixtures and teams have loaded (they
  // change the height of the sections above), unless the visitor has scrolled in the meantime.
  const pendingHash = useRef(false);
  const scrollToHash = useCallback(
    (smooth: boolean) => {
      const target = sectionFromHash(window.location.hash);
      if (!target) return false;
      if (window.location.hash.slice(1) !== target.elementId) {
        window.history.replaceState(window.history.state, '', `#${target.elementId}`);
      }
      const el = document.getElementById(target.elementId) ?? document.getElementById(target.section);
      if (!el) return false;
      el.scrollIntoView({ behavior: smooth && !reduce ? 'smooth' : 'instant', block: 'start' });
      return true;
    },
    [reduce]
  );

  useEffect(() => {
    pendingHash.current = Boolean(sectionFromHash(window.location.hash));
    const frame = requestAnimationFrame(() => scrollToHash(false));
    const cancelPending = () => {
      pendingHash.current = false;
    };
    const onHash = () => scrollToHash(true);
    window.addEventListener('hashchange', onHash);
    window.addEventListener('wheel', cancelPending, { passive: true });
    window.addEventListener('touchmove', cancelPending, { passive: true });
    window.addEventListener('keydown', cancelPending);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('wheel', cancelPending);
      window.removeEventListener('touchmove', cancelPending);
      window.removeEventListener('keydown', cancelPending);
    };
  }, [scrollToHash]);

  useEffect(() => {
    if (fixturesLoading || teamsLoading || !pendingHash.current) return;
    pendingHash.current = false;
    const frame = requestAnimationFrame(() => scrollToHash(false));
    return () => cancelAnimationFrame(frame);
  }, [fixturesLoading, teamsLoading, scrollToHash]);

  const fixtures = useMemo(() => normalizeFixtures(rawFixtures), [rawFixtures]);
  const failed = [errors.fixtures && 'the match fixtures and live scores', errors.teams && 'the list of registered teams'].filter(Boolean);

  return (
    <SectionMediaProvider value={sectionMedia}>
      <SectionNav sections={sections} startsAt={startsAt} endsAt={endsAt} registrationOpen={registrationStatus(details) !== 'closed'} />

      <AnimatePresence initial={false}>
        {failed.length > 0 && (
          <motion.div role="alert" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden bg-white">
            <div className={cx(CONTAINER, 'pt-6')}>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900">
                {`We were unable to load ${failed.join(' or ')}. Please refresh the page to try again.`}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <FactsSection details={details} />
      <TakePartSection />
      <CategoriesSection details={details} />
      <ProgrammeSection fixtures={fixtures} loading={fixturesLoading} />
      {/* Social proof: the drones and arena photographs, then the sponsors logo wall */}
      <GallerySection content={gallery} />
      <SponsorsSection sponsors={sponsors} title={sponsorsSection.title} subtitle={sponsorsSection.subtitle} />
      <PrizesSection />
      <RulesSection />
      <TeamsSection teams={teams} loading={teamsLoading} />
      <ScoresSection fixtures={fixtures} loading={fixturesLoading} socketStatus={socketStatus} scoreboardHref={scoreboardHref} />
      <VenueSection details={details} />
      <FinalCta />
    </SectionMediaProvider>
  );
}

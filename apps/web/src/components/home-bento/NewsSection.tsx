'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { CHAMPIONSHIP_PATH } from '@/lib/championship';
import { splitIsoDate, type HomeContent, type NewsCategory, type NewsItem } from '@/lib/home-content';
import { BentoCard } from './BentoCard';
import { CountdownDigits, useEventCountdown } from './Countdown';
import { LightSweep, Magnetic } from './Effects';
import { MediaFill, SectionMedia } from './Media';
import { BentoSection } from './Section';
import { Eyebrow, RevealHeading } from './Text';
import { useReduce } from './hooks';
import { BTN_LIME, CHIP, CONTAINER, EASE, FOCUS, FOCUS_DARK, H2, ICON_BTN, cx } from './tokens';

/** Announcement from the published hero CMS section (shown as a news card when present). */
export interface HomeAnnouncement {
  title?: string;
  body?: string;
  date?: string;
}

const BADGE: Record<NewsCategory, { label: string; className: string }> = {
  event: { label: 'Event', className: 'bg-bento-lime text-bento-ink' },
  workshop: { label: 'Workshop', className: 'bg-bento-orange text-bento-ink' },
  news: { label: 'News', className: 'bg-white text-bento-ink' },
  visit: { label: 'Industry visit', className: 'bg-bento-ink text-white' }
};

/* ------------------------------------------------------------------ */
/* Countdown                                                           */
/* ------------------------------------------------------------------ */

function NextEventBanner({ event }: { event: NonNullable<HomeContent['news']['nextEvent']> }) {
  // Time-based values exist only after mount (no hydration mismatch); the boxes keep their size meanwhile.
  const { parts, phase } = useEventCountdown(event.startsAt, event.endsAt);
  if (phase === 'ended') return null;

  return (
    <BentoCard reveal={false} shadow="lime" className="group relative mt-8 overflow-hidden bg-bento-ink p-6 text-white">
      <LightSweep tone="dark" />
      <div className="relative flex flex-col items-start justify-between gap-5 lg:flex-row lg:items-center">
        <div className="flex items-center gap-4">
          <span className="relative flex h-3 w-3 shrink-0" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#EF4444] opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-[#EF4444]" />
          </span>
          <div>
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-bento-lime">{phase === 'live' ? 'Under way' : event.label}</p>
            <p className="text-lg font-extrabold">
              {event.title} · {event.dates}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 font-mono">
          {phase !== 'live' && <CountdownDigits parts={parts} />}
          <Magnetic className="ml-1">
            <Link href={phase === 'live' ? event.live.href : event.register.href} className={cx(BTN_LIME, FOCUS_DARK, 'font-sans')}>
              {phase === 'live' ? event.live.label : event.register.label}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Magnetic>
        </div>
      </div>
    </BentoCard>
  );
}

/* ------------------------------------------------------------------ */
/* News cards                                                          */
/* ------------------------------------------------------------------ */

function NewsCard({ item }: { item: NewsItem }) {
  const date = splitIsoDate(item.date);
  const badge = BADGE[item.category];
  const internal = item.href.startsWith('/') || item.href.startsWith('#');
  const LinkTag = internal && item.href.startsWith('/') ? Link : 'a';
  return (
    <BentoCard as="article" wrapperClassName="h-full" className="group flex flex-col overflow-hidden bg-white">
      <div className="relative h-52 shrink-0 overflow-hidden border-b-[2.5px] border-bento-ink">
        <motion.div className="absolute inset-0" whileHover={{ scale: 1.06 }} transition={{ duration: 0.7, ease: EASE }}>
          <MediaFill media={item} position={item.imagePosition} sizes="(min-width: 1024px) 400px, (min-width: 768px) 45vw, 85vw" />
        </motion.div>
        <div className="absolute left-4 top-4 rounded-lg border-2 border-bento-ink bg-white px-3 py-2 text-center leading-none shadow-[3px_3px_0_#111]">
          {date ? (
            <>
              <p className="font-mono text-[10px] font-bold uppercase">{date.month}</p>
              <p className="text-xl font-extrabold">{date.day}</p>
            </>
          ) : (
            <p className="font-mono text-[11px] font-bold uppercase">{item.status ?? badge.label}</p>
          )}
        </div>
        <span className={cx('absolute bottom-4 left-4 rounded border-2 border-bento-ink px-2 py-1 font-mono text-[10px] font-bold uppercase', badge.className)}>{badge.label}</span>
      </div>
      <div className="flex flex-1 flex-col p-6">
        <h3 className="text-base font-extrabold leading-snug">{item.title}</h3>
        <p className="mt-2 flex-1 text-[13px] leading-relaxed text-bento-muted">{item.summary}</p>
        <LinkTag href={item.href} className={cx('mt-4 inline-flex min-h-[44px] w-fit items-center gap-2 text-xs font-extrabold uppercase underline decoration-2 underline-offset-4', FOCUS)}>
          Read more
          <span className="sr-only">: {item.title}</span>
          <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" aria-hidden="true" />
        </LinkTag>
      </div>
    </BentoCard>
  );
}

export function NewsSection({ content, announcement }: { content: HomeContent['news']; announcement?: HomeAnnouncement | null }) {
  const reduce = useReduce();
  const items: NewsItem[] = [...content.items];
  if (announcement?.title) {
    items.splice(1, 0, {
      id: 'cms-announcement',
      category: 'news',
      title: announcement.title,
      summary: announcement.body ?? '',
      status: 'Bulletin',
      href: CHAMPIONSHIP_PATH,
      imagePosition: '40% 40%'
    });
  }
  const filters = content.filters.filter((f) => items.some((i) => i.category === f.id));
  const [filter, setFilter] = useState<NewsCategory | 'all'>('all');
  const shown = items.filter((i) => filter === 'all' || i.category === filter);

  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const updateEdges = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    updateEdges();
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(updateEdges);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateEdges, shown.length]);

  const scrollByCard = (dir: 1 | -1) => {
    const el = scroller.current;
    const card = el?.firstElementChild as HTMLElement | null;
    if (!el || !card) return;
    el.scrollBy({ left: dir * (card.offsetWidth + 20), behavior: reduce ? 'auto' : 'smooth' });
  };

  return (
    <BentoSection id="news" labelledBy="news-heading" backdrop="grid">
      <div className={cx(CONTAINER, 'py-20')}>
        <div className="flex flex-col items-start justify-between gap-5 md:flex-row md:items-end">
          <div>
            <Eyebrow text={content.eyebrow} />
            <RevealHeading id="news-heading" text={content.heading} className={cx(H2, 'mt-3')} />
          </div>
          {filters.length > 1 && (
            <div role="group" aria-label="Filter news and events" className="flex flex-wrap gap-2">
              {[{ id: 'all' as const, label: 'All' }, ...filters].map((f) => {
                const selected = f.id === filter;
                return (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setFilter(f.id);
                      scroller.current?.scrollTo({ left: 0 });
                    }}
                    className={cx(CHIP, selected ? 'text-white' : 'bg-white text-bento-ink hover:bg-bento-lime', FOCUS)}
                  >
                    {selected && (
                      <motion.span
                        layoutId="news-chip"
                        className="absolute inset-[-2.5px] -z-10 rounded-full bg-bento-ink"
                        transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 32 }}
                        aria-hidden="true"
                      />
                    )}
                    {f.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <SectionMedia media={content} className="mt-8" />

        {content.nextEvent && <NextEventBanner event={content.nextEvent} />}

        <div className="relative mt-8" role="region" aria-roledescription="carousel" aria-label={content.heading}>
          <button
            type="button"
            onClick={() => scrollByCard(-1)}
            disabled={edges.start}
            className={cx(ICON_BTN, 'absolute -left-5 top-1/2 z-20 hidden -translate-y-1/2 bg-white lg:flex', FOCUS)}
            aria-label="Previous news"
          >
            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => scrollByCard(1)}
            disabled={edges.end}
            className={cx(ICON_BTN, 'absolute -right-5 top-1/2 z-20 hidden -translate-y-1/2 bg-bento-ink text-white lg:flex', FOCUS)}
            aria-label="Next news"
          >
            <ArrowRight className="h-5 w-5" aria-hidden="true" />
          </button>
          <motion.div
              ref={scroller}
              initial={{ opacity: 0, y: 32 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-80px' }}
              transition={{ duration: reduce ? 0 : 0.7, ease: EASE }}
              onScroll={updateEdges}
              className="scrollbar-none -mx-3 flex snap-x snap-mandatory gap-5 overflow-x-auto px-3 pb-5 pt-2"
            >
              <AnimatePresence mode="popLayout" initial={false}>
                {shown.map((item, i) => (
                  <motion.div
                    key={item.id}
                    layout
                    role="group"
                    aria-roledescription="slide"
                    aria-label={`${i + 1} of ${shown.length}`}
                    className="w-[85%] shrink-0 snap-start sm:w-[calc((100%-20px)/2)] lg:w-[calc((100%-40px)/3)]"
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.96 }}
                    transition={{ duration: reduce ? 0 : 0.35, ease: EASE }}
                  >
                    <NewsCard item={item} />
                  </motion.div>
                ))}
              </AnimatePresence>
          </motion.div>
        </div>
      </div>
    </BentoSection>
  );
}

'use client';

import React, { useMemo, useRef, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { ArrowRight, Check, Download, Maximize2, Search, X } from 'lucide-react';
import { useSiteInfo } from '@/components/site/SiteContentProvider';
import type { HomeContent, Programme } from '@/lib/home-content';
import { BentoCard } from './BentoCard';
import { LightSweep, Magnetic, Spotlight } from './Effects';
import { MediaFill, SectionMedia } from './Media';
import { BentoSection, Shape } from './Section';
import { Eyebrow, RevealHeading } from './Text';
import { useReduce } from './hooks';
import { BTN_GHOST_DARK, BTN_LIME, CONTAINER, EASE, FOCUS, FOCUS_DARK, H2, cx } from './tokens';

function matches(p: Programme, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return [p.title, p.summary, ...p.tags].some((t) => t.toLowerCase().includes(q));
}

function FeaturedCard({ programme, categoryLabel, email }: { programme: Programme; categoryLabel: string; email: string }) {
  const d = programme.details;
  const meta = d ? [d.duration, d.award, d.level].filter(Boolean).join(' · ') : programme.tags.join(' · ');
  const syllabus = d?.syllabus ?? [];
  const enquiry = `mailto:${email}?subject=${encodeURIComponent(`Enrolment enquiry: ${programme.title}`)}`;

  return (
    <BentoCard reveal={false} shadow="lime" className="group relative min-h-[340px] overflow-hidden bg-bento-ink text-white">
      <div className="absolute inset-0 opacity-70">
        <MediaFill media={programme} position={programme.imagePosition} sizes="(min-width: 768px) 66vw, 100vw" />
      </div>
      <div className="absolute inset-0 bg-[linear-gradient(90deg,#111_0%,rgba(17,17,17,.88)_50%,rgba(17,17,17,.35)_100%)]" aria-hidden="true" />
      <Spotlight size={420} />
      <LightSweep tone="dark" />
      <div className={cx('relative z-10 grid h-full gap-6 p-6 sm:p-8', syllabus.length > 0 && 'sm:grid-cols-2')}>
        <div className="flex flex-col justify-end">
          <span className="w-fit rounded-md bg-bento-lime px-2.5 py-1 font-mono text-[10px] font-bold uppercase text-bento-ink">{categoryLabel}</span>
          <h3 className="mt-3 text-2xl font-extrabold uppercase">{programme.title}</h3>
          <p className="mt-1 text-sm text-zinc-300">{meta}</p>
          <p className="mt-3 max-w-md text-[14px] leading-relaxed text-zinc-200">{programme.summary}</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Magnetic>
              <a href={enquiry} className={cx(BTN_LIME, FOCUS_DARK)}>
                Enrolment enquiry
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </Magnetic>
            {d?.syllabusUrl && (
              <a href={d.syllabusUrl} target="_blank" rel="noopener noreferrer" className={cx(BTN_GHOST_DARK, FOCUS_DARK)}>
                <Download className="h-4 w-4" aria-hidden="true" />
                Download syllabus
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
          </div>
        </div>
        {syllabus.length > 0 && (
          <div className="self-center rounded-2xl border-2 border-white/10 bg-bento-ink/75 p-5 backdrop-blur">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-bento-lime">Syllabus</p>
            <ul className="mt-3 space-y-2.5 text-[13px] text-zinc-200">
              {syllabus.map((line) => (
                <li key={line} className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-bento-lime" aria-hidden="true" />
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </BentoCard>
  );
}

function ProgrammeCard({ programme, onSelect }: { programme: Programme; onSelect: () => void }) {
  const meta = programme.details ? programme.details.duration : programme.tags.join(' · ');
  return (
    <BentoCard reveal={false} pressable wrapperClassName="h-56" className="group relative overflow-hidden bg-bento-ink text-white">
      <motion.div className="absolute inset-0" whileHover={{ scale: 1.06 }} transition={{ duration: 0.7, ease: EASE }}>
        <MediaFill media={programme} position={programme.imagePosition} sizes="(min-width: 768px) 33vw, 100vw" />
      </motion.div>
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-bento-ink via-bento-ink/55 to-transparent" aria-hidden="true" />
      <button
        type="button"
        onClick={onSelect}
        className={cx('absolute inset-0 z-10 flex flex-col justify-end p-6 text-left', 'focus-visible:outline focus-visible:outline-[3px] focus-visible:-outline-offset-[6px] focus-visible:outline-bento-lime')}
      >
        <span className="text-lg font-extrabold uppercase">{programme.title}</span>
        <span className="mt-1 text-xs text-zinc-300">{meta}</span>
        <span className="sr-only">: show details</span>
      </button>
      <span aria-hidden="true" className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white text-bento-ink transition-transform duration-300 group-hover:scale-110">
        <Maximize2 className="h-4 w-4" />
      </span>
    </BentoCard>
  );
}

export function ProgrammesSection({ content }: { content: HomeContent['programmes'] }) {
  const siteInfo = useSiteInfo();
  const reduce = useReduce();
  const categories = content.categories.filter((c) => c.id === 'all' || content.items.some((p) => p.category === c.id));
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [featuredId, setFeaturedId] = useState<string | null>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: content.items.length };
    for (const p of content.items) c[p.category] = (c[p.category] ?? 0) + 1;
    return c;
  }, [content.items]);

  const filtered = content.items.filter((p) => (category === 'all' || p.category === category) && matches(p, query.trim()));
  const featured = filtered.find((p) => p.id === featuredId) ?? filtered[0];
  const rest = filtered.filter((p) => p !== featured);
  const labelOf = (id: string) => content.categories.find((c) => c.id === id)?.label ?? id;
  const layoutTransition = reduce ? { duration: 0 } : { type: 'spring' as const, stiffness: 300, damping: 32 };

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % categories.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + categories.length) % categories.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = categories.length - 1;
    else return;
    e.preventDefault();
    setCategory(categories[next].id);
    tabRefs.current[next]?.focus();
  };

  if (content.items.length === 0) return null;

  return (
    <BentoSection
      id="programmes"
      labelledBy="programmes-heading"
      backdrop="grid"
      decor={<Shape kind="lime-circle" depth={2.5} className="-left-16 top-16 h-52 w-52" />}
    >
      <div className={cx(CONTAINER, 'py-20')}>
        <div className="text-center">
          <Eyebrow text={content.eyebrow} />
          <RevealHeading id="programmes-heading" text={content.heading} className={cx(H2, 'mt-3')} />
        </div>

        <SectionMedia media={content} className="mt-10" />

        <div className="mt-10 flex flex-col items-stretch justify-between gap-4 border-b-2 border-bento-ink md:flex-row md:items-end">
          <div role="tablist" aria-label="Programme categories" className="scrollbar-none -mb-0.5 flex gap-5 overflow-x-auto">
            {categories.map((c, i) => {
              const selected = c.id === category;
              return (
                <button
                  key={c.id}
                  ref={(el) => {
                    tabRefs.current[i] = el;
                  }}
                  id={`programme-tab-${c.id}`}
                  role="tab"
                  type="button"
                  aria-selected={selected}
                  aria-controls="programme-panel"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => {
                    setCategory(c.id);
                    setFeaturedId(null);
                  }}
                  onKeyDown={(e) => onKeyDown(e, i)}
                  className={cx(
                    'relative flex min-h-[48px] shrink-0 items-center gap-1.5 pb-2 text-sm font-extrabold uppercase tracking-wide transition-colors',
                    selected ? 'text-bento-ink' : 'text-bento-muted hover:text-bento-ink',
                    FOCUS
                  )}
                >
                  {c.label}
                  <span className={cx('rounded-full px-2 py-0.5 text-[10px]', selected ? 'bg-bento-lime text-bento-ink' : 'bg-bento-ink/10')}>{counts[c.id] ?? 0}</span>
                  {selected && (
                    <motion.span
                      layoutId="programme-underline"
                      className="absolute inset-x-0 bottom-0 h-1 rounded-full bg-bento-ink"
                      transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 34 }}
                      aria-hidden="true"
                    />
                  )}
                </button>
              );
            })}
          </div>
          <div className="relative mb-3 w-full md:w-72">
            <label htmlFor="programme-search" className="sr-only">
              Search programmes
            </label>
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-bento-muted" aria-hidden="true" />
            <input
              id="programme-search"
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setFeaturedId(null);
              }}
              placeholder="Search programmes"
              autoComplete="off"
              className="h-12 w-full rounded-full border-[2.5px] border-bento-ink bg-white pl-11 pr-4 text-sm text-bento-ink placeholder:text-bento-muted focus:outline-none focus-visible:shadow-[4px_4px_0_#111]"
            />
          </div>
        </div>

        <div id="programme-panel" role="tabpanel" aria-labelledby={`programme-tab-${category}`} className="mt-10">
          <p className="sr-only" aria-live="polite">
            {filtered.length} {filtered.length === 1 ? 'programme' : 'programmes'} shown
          </p>
          <LayoutGroup>
            <motion.div
              ref={gridRef}
              className="grid gap-5 md:grid-cols-3"
              initial={{ opacity: 0, y: 32 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-80px' }}
              transition={{ duration: 0.7, ease: EASE }}
            >
              <AnimatePresence mode="popLayout" initial={false}>
                {featured && (
                  <motion.div
                    key={`featured-${featured.id}`}
                    layout
                    className="md:col-span-2"
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.96 }}
                    transition={layoutTransition}
                  >
                    <FeaturedCard programme={featured} categoryLabel={labelOf(featured.category)} email={siteInfo.email} />
                  </motion.div>
                )}
                {rest.map((p) => (
                  <motion.div
                    key={p.id}
                    layout
                    initial={{ opacity: 0, y: 24 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.94 }}
                    transition={layoutTransition}
                  >
                    <ProgrammeCard
                      programme={p}
                      onSelect={() => {
                        setFeaturedId(p.id);
                        gridRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
                      }}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>
          </LayoutGroup>
          {filtered.length === 0 && (
            <div className="mx-auto max-w-md rounded-2xl border-[2.5px] border-dashed border-bento-ink bg-white p-8 text-center">
              <p className="font-extrabold">No programme matches the search.</p>
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setCategory('all');
                }}
                className={cx('mt-3 inline-flex min-h-[44px] items-center gap-2 text-xs font-extrabold uppercase underline underline-offset-4', FOCUS)}
              >
                <X className="h-4 w-4" aria-hidden="true" />
                Clear the search
              </button>
            </div>
          )}
        </div>
      </div>
    </BentoSection>
  );
}

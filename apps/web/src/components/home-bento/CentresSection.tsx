'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { animate, motion, useInView, useMotionValue, type PanInfo } from 'framer-motion';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { HomeContent } from '@/lib/home-content';
import { BentoCard } from './BentoCard';
import { Parallax } from './Effects';
import { MediaFill, SectionMedia } from './Media';
import { BentoSection } from './Section';
import { Eyebrow, RevealHeading } from './Text';
import { useReduce } from './hooks';
import { CHIP, CONTAINER, EASE, FOCUS, H2, ICON_BTN, SPRING_SLIDE, cx } from './tokens';

const AUTO_ADVANCE_MS = 5000;
const GAP = 20;

export function CentresSection({ content }: { content: HomeContent['centres'] }) {
  const [filter, setFilter] = useState('all');
  const items = useMemo(() => content.items.filter((c) => filter === 'all' || c.category === filter), [content.items, filter]);
  const filters = content.filters.filter((f) => f.id === 'all' || content.items.some((c) => c.category === f.id));

  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const [index, setIndex] = useState(0);
  const [stepPx, setStepPx] = useState(0);
  const [perView, setPerView] = useState(1);
  const [paused, setPaused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inView = useInView(viewport, { margin: '-120px' });
  const reduce = useReduce();

  const maxIndex = Math.max(0, items.length - perView);

  // Measure the card step (card width + gap) and how many cards fit.
  useEffect(() => {
    const vp = viewport.current;
    const tr = track.current;
    if (!vp || !tr) return;
    const measure = () => {
      const card = tr.firstElementChild as HTMLElement | null;
      if (!card) return;
      const step = card.offsetWidth + GAP;
      setStepPx(step);
      setPerView(Math.max(1, Math.round((vp.clientWidth + GAP) / step)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(vp);
    return () => ro.disconnect();
  }, [items.length]);

  const goTo = useCallback(
    (i: number) => {
      const next = Math.max(0, Math.min(maxIndex, i));
      setIndex(next);
    },
    [maxIndex]
  );

  // Animate the track to the current index.
  useEffect(() => {
    const controls = animate(x, -index * stepPx, reduce ? { duration: 0 } : SPRING_SLIDE);
    return () => controls.stop();
  }, [index, stepPx, reduce, x]);

  // Reset when the filter changes or the layout shrinks.
  useEffect(() => setIndex(0), [filter]);
  useEffect(() => {
    if (index > maxIndex) setIndex(maxIndex);
  }, [index, maxIndex]);

  // Auto-advance, paused on hover / focus / drag, off screen, and with reduced motion.
  useEffect(() => {
    if (reduce || paused || dragging || !inView || maxIndex === 0) return;
    const t = window.setTimeout(() => setIndex((i) => (i >= maxIndex ? 0 : i + 1)), AUTO_ADVANCE_MS);
    return () => window.clearTimeout(t);
  }, [index, reduce, paused, dragging, inView, maxIndex]);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    setDragging(false);
    if (stepPx <= 0) return;
    const projected = -x.get() - info.velocity.x * 0.2;
    goTo(Math.round(projected / stepPx));
  };

  const visibleEnd = Math.min(items.length, index + perView);
  const progress = items.length > 0 ? visibleEnd / items.length : 0;

  return (
    <BentoSection
      id="centres"
      labelledBy="centres-heading"
      backdrop="dots"
      decor={<Parallax depth={1.5} className="absolute -left-10 bottom-16 h-24 w-24 rounded-full border-[10px] border-bento-lime/70" />}
    >
      <div className={cx(CONTAINER, 'py-20')}>
        <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
          <div>
            <Eyebrow text={content.eyebrow} />
            <RevealHeading id="centres-heading" text={content.heading} className={cx(H2, 'mt-3')} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filter centres">
              {filters.map((f) => {
                const selected = f.id === filter;
                return (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setFilter(f.id)}
                    className={cx(CHIP, selected ? 'text-white' : 'bg-white text-bento-ink hover:bg-bento-lime', FOCUS)}
                  >
                    {selected && (
                      <motion.span
                        layoutId="centres-chip"
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
            <div className="ml-1 flex gap-2">
              <button type="button" onClick={() => goTo(index - 1)} disabled={index === 0} className={cx(ICON_BTN, 'bg-white', FOCUS)} aria-label="Previous centres" aria-controls="centres-track">
                <ArrowLeft className="h-5 w-5" aria-hidden="true" />
              </button>
              <button type="button" onClick={() => goTo(index + 1)} disabled={index >= maxIndex} className={cx(ICON_BTN, 'bg-bento-ink text-white', FOCUS)} aria-label="Next centres" aria-controls="centres-track">
                <ArrowRight className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        <SectionMedia media={content} className="mt-10" />

        <div
          ref={viewport}
          role="region"
          aria-roledescription="carousel"
          aria-label={content.heading}
          className="-mx-3 mt-10 overflow-hidden px-3 pb-4 pt-2"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocusCapture={() => setPaused(true)}
          onBlurCapture={() => setPaused(false)}
        >
          <motion.div
            ref={track}
            id="centres-track"
            className="flex cursor-grab touch-pan-y active:cursor-grabbing"
            style={{ x, gap: GAP }}
            drag={maxIndex > 0 ? 'x' : false}
            dragConstraints={{ left: -maxIndex * stepPx, right: 0 }}
            dragElastic={0.12}
            dragMomentum={false}
            onDragStart={() => setDragging(true)}
            onDragEnd={onDragEnd}
            aria-live={paused ? 'polite' : 'off'}
          >
            {items.map((centre, i) => {
              const accent = i % 2 === 0 ? 'border-bento-lime' : 'border-bento-orange';
              return (
                <motion.div
                  key={centre.id}
                  initial={{ opacity: 0, y: 28 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, amount: 0.3 }}
                  transition={{ duration: reduce ? 0 : 0.6, ease: EASE, delay: reduce ? 0 : Math.min(i, 3) * 0.08 }}
                  role="group"
                  aria-roledescription="slide"
                  aria-label={`${i + 1} of ${items.length}: ${centre.title}`}
                  className="w-[82%] shrink-0 sm:w-[calc((100%-20px)/2)] lg:w-[calc((100%-60px)/4)]"
                >
                  <BentoCard reveal={false} wrapperClassName="h-full" className="group flex flex-col overflow-hidden bg-white">
                    <div className="relative h-48 shrink-0 overflow-hidden">
                      <motion.div className="absolute inset-0" whileHover={{ scale: 1.05 }} transition={{ duration: 0.6, ease: EASE }}>
                        <MediaFill media={centre} position={centre.imagePosition} sizes="(min-width: 1024px) 300px, (min-width: 640px) 45vw, 82vw" />
                      </motion.div>
                      <span className="absolute left-4 top-4 rounded-md bg-bento-ink px-2.5 py-1 font-mono text-[10px] font-bold text-bento-lime">{centre.code}</span>
                    </div>
                    <div className={cx('relative min-h-[150px] flex-1 border-t-4 p-5 transition-colors duration-300 group-hover:bg-bento-ink group-hover:text-white group-focus-within:bg-bento-ink group-focus-within:text-white', accent)}>
                      <h3 className="font-extrabold uppercase leading-tight">{centre.title}</h3>
                      <p className="mt-1 text-xs text-bento-muted transition-colors group-hover:text-zinc-300 group-focus-within:text-zinc-300">{centre.focus.join(' · ')}</p>
                      <a
                        href="#contact"
                        draggable={false}
                        className={cx(
                          'mt-4 inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-bento-lime px-4 text-[11px] font-extrabold uppercase text-bento-ink opacity-0 transition-[opacity,transform] duration-300 group-hover:translate-y-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
                          'translate-y-2 [@media(hover:none)]:translate-y-0',
                          'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-bento-lime'
                        )}
                      >
                        {content.enquiryLabel}
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                        <span className="sr-only">: {centre.title}</span>
                      </a>
                    </div>
                  </BentoCard>
                </motion.div>
              );
            })}
          </motion.div>
        </div>

        <div className="mt-6 flex items-center justify-center gap-3" aria-hidden="true">
          <span className="font-mono text-[11px] font-bold">{String(visibleEnd).padStart(2, '0')}</span>
          <div className="h-1 w-48 overflow-hidden rounded-full bg-bento-ink/15">
            <motion.div
              className="h-full origin-left rounded-full bg-bento-ink"
              initial={false}
              animate={{ scaleX: progress }}
              transition={reduce ? { duration: 0 } : { duration: 0.6, ease: EASE }}
            />
          </div>
          <span className="font-mono text-[11px] font-bold text-bento-muted">{String(items.length).padStart(2, '0')}</span>
        </div>
      </div>
    </BentoSection>
  );
}

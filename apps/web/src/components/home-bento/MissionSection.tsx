'use client';

import React, { useId, useRef, useState } from 'react';
import { AnimatePresence, motion, useInView } from 'framer-motion';
import { ArrowRight, Minus, Plus } from 'lucide-react';
import type { HomeContent, MissionTab, Roadmap } from '@/lib/home-content';
import { BentoCard } from './BentoCard';
import { HomeIcon } from './icons';
import { MediaFill, SectionMedia, hasMedia } from './Media';
import { BentoSection, Stagger } from './Section';
import { useReduce } from './hooks';
import { CONTAINER, EASE, FOCUS, FOCUS_DARK, cx } from './tokens';

function RoadmapBar({ roadmap }: { roadmap: Roadmap }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true });
  const reduce = useReduce();
  return (
    <div ref={ref} className="mt-6 flex items-center gap-3">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
        <motion.div
          className="h-full origin-left rounded-full bg-bento-lime"
          style={{ width: '100%' }}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: inView ? roadmap.progress / 100 : 0 }}
          transition={reduce ? { duration: 0 } : { duration: 1.2, ease: EASE, delay: 0.2 }}
        />
      </div>
      <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">{roadmap.label}</span>
    </div>
  );
}

function Accordion({ tab }: { tab: MissionTab }) {
  const [open, setOpen] = useState<number | null>(0);
  const reduce = useReduce();
  const baseId = useId();

  return (
    <ul className="mt-6 divide-y-2 divide-bento-ink/10 overflow-hidden rounded-2xl border-[2.5px] border-bento-ink bg-white shadow-[4px_4px_0_#111]">
      {tab.points.map((point, i) => {
        const isOpen = open === i;
        const panelId = `${baseId}-panel-${i}`;
        const buttonId = `${baseId}-button-${i}`;
        return (
          <li key={point.title}>
            <h4 className="m-0">
              <button
                id={buttonId}
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpen(isOpen ? null : i)}
                className={cx('flex min-h-[56px] w-full items-center justify-between gap-4 px-5 py-4 text-left font-extrabold', FOCUS, 'focus-visible:-outline-offset-4')}
              >
                <span>
                  {String(i + 1).padStart(2, '0')} · {point.title}
                </span>
                <motion.span
                  aria-hidden="true"
                  className={cx(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-bento-ink transition-colors duration-200',
                    isOpen ? 'bg-bento-ink text-white' : 'bg-white text-bento-ink'
                  )}
                  animate={{ rotate: isOpen ? 180 : 0 }}
                  transition={{ duration: reduce ? 0 : 0.35, ease: EASE }}
                >
                  {isOpen ? <Minus className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                </motion.span>
              </button>
            </h4>
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  id={panelId}
                  role="region"
                  aria-labelledby={buttonId}
                  key="panel"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: reduce ? 0 : 0.4, ease: EASE }}
                  className="overflow-hidden"
                >
                  <p className="px-5 pb-5 text-[14px] leading-relaxed text-bento-muted">{point.body}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </li>
        );
      })}
    </ul>
  );
}

export function MissionSection({ content }: { content: HomeContent['mission'] }) {
  const tabs = content.tabs;
  const [active, setActive] = useState(tabs[0]?.id ?? 'mission');
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const reduce = useReduce();
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  if (!current) return null;
  const others = tabs.filter((t) => t.id !== current.id);
  const fade = { duration: reduce ? 0 : 0.35, ease: EASE };

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    setActive(tabs[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <BentoSection id="mission" labelledBy="mission-heading" backdrop="grid">
      <div className={cx(CONTAINER, 'py-20')}>
        <h2 id="mission-heading" className="sr-only">
          Mission, vision and values
        </h2>
        <div className="flex justify-center">
          <div role="tablist" aria-label="Mission, vision and values" className="inline-flex rounded-full border-[2.5px] border-bento-ink bg-white p-1.5 shadow-[4px_4px_0_#111]">
            {tabs.map((tab, i) => {
              const selected = tab.id === current.id;
              return (
                <button
                  key={tab.id}
                  ref={(el) => {
                    tabRefs.current[i] = el;
                  }}
                  id={`mission-tab-${tab.id}`}
                  role="tab"
                  type="button"
                  aria-selected={selected}
                  aria-controls="mission-panel"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActive(tab.id)}
                  onKeyDown={(e) => onKeyDown(e, i)}
                  className={cx(
                    'relative min-h-[44px] rounded-full px-5 text-xs font-extrabold uppercase tracking-wider transition-colors duration-200 sm:px-7',
                    selected ? 'text-white' : 'text-bento-muted hover:text-bento-ink',
                    FOCUS
                  )}
                >
                  {selected && (
                    <motion.span
                      layoutId="mission-pill"
                      className="absolute inset-0 rounded-full bg-bento-ink"
                      transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 32 }}
                      aria-hidden="true"
                    />
                  )}
                  <span className="relative">{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <SectionMedia media={content} className="mt-10" />

        <Stagger className="mt-10 grid gap-6 md:grid-cols-5">
          <BentoCard wrapperClassName="md:col-span-3" className="bg-white p-6 sm:p-10">
            <div id="mission-panel" role="tabpanel" aria-labelledby={`mission-tab-${current.id}`}>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={current.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={fade}>
                  <div className="flex items-center gap-4">
                    <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-4 border-bento-lime bg-bento-ink text-white">
                      <HomeIcon name={current.icon} className="h-6 w-6" />
                    </span>
                    <h3 className="text-2xl font-extrabold uppercase tracking-tight">{current.heading}</h3>
                  </div>
                  {hasMedia(current) && (
                    <div data-item-media="" className="relative mt-5 aspect-video overflow-hidden rounded-xl border-[2.5px] border-bento-ink">
                      <MediaFill media={current} sizes="(min-width: 768px) 55vw, 100vw" />
                    </div>
                  )}
                  <p className="mt-5 text-[15px] font-semibold leading-relaxed">{current.statement}</p>
                  <Accordion tab={current} />
                  {current.showRoadmap && content.roadmap && (
                    <div className="mt-6 rounded-xl bg-bento-ink p-4">
                      <RoadmapBar roadmap={content.roadmap} />
                    </div>
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </BentoCard>

          <BentoCard wrapperClassName="md:col-span-2" shadow="lime" className="overflow-hidden bg-bento-ink p-6 text-white sm:p-10">
            <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-bento-orange/30 blur-2xl" />
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={current.id} className="relative space-y-8" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
                {others.map((tab) => (
                  <div key={tab.id}>
                    <div className="flex items-center gap-4">
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-4 border-white/15 bg-bento-orange text-bento-ink">
                        <HomeIcon name={tab.icon} className="h-5 w-5" />
                      </span>
                      <h3 className="text-xl font-extrabold uppercase tracking-tight">{tab.heading}</h3>
                    </div>
                    <p className="mt-4 text-[16px] font-semibold leading-relaxed text-zinc-200">{tab.statement}</p>
                    {tab.showRoadmap && content.roadmap && <RoadmapBar roadmap={content.roadmap} />}
                    <button
                      type="button"
                      onClick={() => setActive(tab.id)}
                      className={cx('group mt-3 inline-flex min-h-[44px] items-center gap-2 text-xs font-extrabold uppercase tracking-wider text-bento-lime', FOCUS_DARK)}
                    >
                      Read {tab.heading.toLowerCase()}
                      <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </motion.div>
            </AnimatePresence>
          </BentoCard>
        </Stagger>
      </div>
    </BentoSection>
  );
}

'use client';

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FileDown } from 'lucide-react';
import type { HomeContent, Mou } from '@/lib/home-content';
import { BentoCard } from './BentoCard';
import { ItemMedia, SectionMedia, hasMedia } from './Media';
import { BentoSection, Stagger } from './Section';
import { useReduce } from './hooks';
import { CONTAINER, EASE, FOCUS, cx } from './tokens';

function MouCard({ mou }: { mou: Mou }) {
  const [open, setOpen] = useState(false);
  const reduce = useReduce();
  return (
    <BentoCard as="li" className="h-full bg-white p-4">
      <div
        className="h-full"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
        }}
      >
        {hasMedia(mou) ? (
          <ItemMedia media={mou} className="rounded-md" sizes="(min-width: 1024px) 220px, 50vw" />
        ) : (
          <div className={cx('h-8 rounded-md transition-colors duration-300', open ? 'bg-bento-lime' : 'bg-bento-ink/10')} aria-hidden="true" />
        )}
        <h3 className="mt-3 text-sm font-extrabold">{mou.organisation}</h3>
        <p className="font-mono text-[10px] text-bento-muted">MoU · {mou.year}</p>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={cx('mt-1 min-h-[32px] text-[11px] font-bold underline underline-offset-2 [@media(hover:hover)]:sr-only [@media(hover:hover)]:focus:not-sr-only', FOCUS)}
        >
          {open ? 'Hide scope' : 'Show scope'}
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: reduce ? 0 : 0.35, ease: EASE }}
              className="overflow-hidden"
            >
              <p className="mt-2 text-[12px] leading-snug text-bento-muted">{mou.summary}</p>
              {mou.documentUrl && (
                <a href={mou.documentUrl} target="_blank" rel="noopener noreferrer" className={cx('mt-2 inline-flex items-center gap-1 text-[11px] font-extrabold', FOCUS)}>
                  Read the MoU (PDF) <FileDown className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </BentoCard>
  );
}

export function MouStrip({ content }: { content: HomeContent['mous'] }) {
  if (content.items.length === 0) return null;
  return (
    <BentoSection id="mous" labelledBy="mous-heading" className="border-y-[2.5px] border-bento-ink">
      <div className={cx(CONTAINER, 'grid items-start gap-6 py-12 md:grid-cols-[220px_1fr] md:items-center')}>
        <SectionMedia media={content} className="md:col-span-2" />
        <div>
          <h2 id="mous-heading" className="text-lg font-extrabold uppercase leading-tight">
            {content.heading}
          </h2>
          <p className="mt-1 text-xs text-bento-muted">{content.subheading}</p>
        </div>
        <Stagger as="ul" className="grid grid-cols-1 gap-5 min-[420px]:grid-cols-2 lg:grid-cols-4">
          {content.items.map((mou) => (
            <MouCard key={mou.id} mou={mou} />
          ))}
        </Stagger>
      </div>
    </BentoSection>
  );
}

'use client';

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Play, Quote } from 'lucide-react';
import type { HomeContent, MediaFields, Testimonial } from '@/lib/home-content';
import { Spotlight } from './Effects';
import { MediaFill, SectionMedia, hasMedia } from './Media';
import { BentoSection, Shape } from './Section';
import { RevealHeading } from './Text';
import { useReduce } from './hooks';
import { EASE, CONTAINER, FOCUS_DARK, cx } from './tokens';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

/** Avatar (the person's photograph or video when set, otherwise initials) inside a slowly rotating dashed lime ring. */
function Avatar({ name, size = 'lg', tone = 'dark', media }: { name: string; size?: 'lg' | 'md'; tone?: 'dark' | 'light'; media?: MediaFields }) {
  const dim = size === 'lg' ? 'h-20 w-20' : 'h-16 w-16';
  return (
    <div className={cx('relative shrink-0', dim)} aria-hidden="true">
      <span className="absolute inset-0 animate-[spin_14s_linear_infinite] rounded-full border-[3px] border-dashed border-bento-lime motion-reduce:animate-none" />
      <span
        className={cx(
          'absolute inset-[6px] flex items-center justify-center rounded-full text-sm font-extrabold',
          tone === 'dark' ? 'bg-bento-panel text-bento-lime' : 'bg-bento-ink text-bento-lime'
        )}
      >
        {hasMedia(media) ? (
          <span className="absolute inset-0 overflow-hidden rounded-full">
            <MediaFill media={media} sizes="80px" alt="" />
          </span>
        ) : (
          initials(name)
        )}
      </span>
      <span className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border-2 border-bento-ink bg-bento-lime text-bento-ink">
        <Quote className="h-3.5 w-3.5 fill-current" />
      </span>
    </div>
  );
}

const SLIDE = {
  enter: (dir: number) => ({ x: dir * 64, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir * -64, opacity: 0 })
};

/** Testimonial slider: direction-aware slides, arrows, dots and arrow-key support. */
function Slider({
  items,
  label,
  tone,
  headingId,
  heading,
  extra
}: {
  items: Testimonial[];
  label: string;
  tone: 'dark' | 'light';
  headingId: string;
  heading: string;
  extra?: React.ReactNode;
}) {
  const [[index, dir], setState] = useState<[number, number]>([0, 1]);
  const reduce = useReduce();
  const count = items.length;
  const go = (delta: number) => setState(([i]) => [(i + delta + count) % count, delta]);
  const goTo = (i: number) => setState(([cur]) => [i, i >= cur ? 1 : -1]);
  const current = items[index];
  const next = count > 1 ? items[(index + 1) % count] : null;
  const transition = reduce ? { duration: 0 } : { duration: 0.45, ease: EASE };

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <RevealHeading as="h2" id={headingId} text={heading} className="text-2xl font-extrabold uppercase tracking-tight sm:text-3xl" />
          <motion.div
            aria-hidden="true"
            className="mt-3 h-1.5 w-14 origin-left rounded-full bg-bento-lime"
            initial={{ scaleX: 0 }}
            whileInView={{ scaleX: 1 }}
            viewport={{ once: true }}
            transition={reduce ? { duration: 0 } : { duration: 0.8, delay: 0.3, ease: EASE }}
          />
        </div>
        {count > 1 ? (
          <div className="flex gap-2">
            <button type="button" onClick={() => go(-1)} aria-label={`Previous: ${label}`} aria-controls={`${headingId}-slides`} className={cx('flex h-11 w-11 items-center justify-center rounded-full border-2 border-white/25 text-white transition-colors hover:border-bento-lime hover:text-bento-lime', FOCUS_DARK)}>
              <ArrowLeft className="h-5 w-5" aria-hidden="true" />
            </button>
            <button type="button" onClick={() => go(1)} aria-label={`Next: ${label}`} aria-controls={`${headingId}-slides`} className={cx('flex h-11 w-11 items-center justify-center rounded-full border-2 border-bento-ink bg-bento-lime text-bento-ink transition-transform hover:-translate-y-0.5', FOCUS_DARK)}>
              <ArrowRight className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>

      {extra}

      <div
        id={`${headingId}-slides`}
        role="region"
        aria-roledescription="carousel"
        aria-labelledby={headingId}
        tabIndex={0}
        onKeyDown={(e) => {
          if (count < 2) return;
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            go(1);
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            go(-1);
          }
        }}
        className={cx('relative mt-6 rounded-2xl', FOCUS_DARK)}
      >
        <div className="relative overflow-hidden rounded-2xl p-1">
          <AnimatePresence mode="popLayout" initial={false} custom={dir}>
            <motion.figure
              key={current.id}
              custom={dir}
              variants={SLIDE}
              initial="enter"
              animate="center"
              exit="exit"
              transition={transition}
              role="group"
              aria-roledescription="slide"
              aria-label={`${index + 1} of ${count}`}
              className={cx(
                'm-0 rounded-2xl p-6',
                tone === 'dark'
                  ? 'border-2 border-bento-lime bg-bento-panel shadow-[0_0_0_4px_rgba(198,244,50,0.15),0_0_40px_rgba(198,244,50,0.18)]'
                  : 'border-[2.5px] border-bento-ink bg-white text-bento-ink shadow-[6px_6px_0_#C6F432]'
              )}
            >
              <div className="flex flex-col gap-5 sm:flex-row">
                <Avatar name={current.name} tone={tone} media={current} />
                <div>
                  <blockquote className={cx('m-0 text-[15px] leading-relaxed', tone === 'dark' ? 'italic text-zinc-200' : 'text-zinc-700')}>
                    <p>“{current.quote}”</p>
                  </blockquote>
                  <figcaption className="mt-4">
                    <span className={cx('block text-sm font-extrabold', tone === 'dark' ? 'text-bento-lime' : 'text-bento-ink')}>{current.name}</span>
                    <span className={cx('block text-[12px]', tone === 'dark' ? 'text-zinc-400' : 'text-bento-muted')}>{current.role}</span>
                  </figcaption>
                </div>
              </div>
            </motion.figure>
          </AnimatePresence>
        </div>
        <p className="sr-only" aria-live="polite">
          {label} {index + 1} of {count}
        </p>
      </div>

      {next && (
        <button
          type="button"
          onClick={() => go(1)}
          className={cx('mt-4 flex w-full items-center gap-4 rounded-2xl border-2 border-white/10 bg-white/5 p-4 text-left opacity-60 transition-opacity hover:opacity-100', FOCUS_DARK)}
        >
          <span className="sr-only">Next: </span>
          <span className="line-clamp-1 text-[13px] italic text-zinc-300">“{next.quote}”</span>
          <span className="ml-auto shrink-0 text-xs font-extrabold text-white">{next.name}</span>
        </button>
      )}

      {count > 1 && (
        <div className="mt-5 flex gap-1.5">
          {items.map((t, i) => (
            <button
              key={t.id}
              type="button"
              onClick={() => goTo(i)}
              aria-label={`Show ${label.toLowerCase()} ${i + 1}`}
              aria-current={i === index ? 'true' : undefined}
              className={cx('relative flex h-11 items-center', FOCUS_DARK, 'rounded')}
            >
              <span className={cx('block h-1.5 rounded-full transition-[width,background-color] duration-300', i === index ? 'w-8 bg-bento-lime' : 'w-3 bg-white/25')} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StoryVideo({ video }: { video: NonNullable<HomeContent['testimonials']['storyVideo']> }) {
  const body = (
    <>
      <div className="relative h-48">
        <MediaFill media={video} position="50% 40%" sizes="(min-width: 1024px) 600px, 100vw" />
      </div>
      <div className="absolute inset-0 bg-gradient-to-t from-bento-ink via-bento-ink/40 to-transparent" aria-hidden="true" />
      <span className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-[2.5px] border-bento-ink bg-white text-bento-ink shadow-[0_0_0_10px_rgba(255,255,255,0.2)] transition-transform duration-300 group-hover:scale-110" aria-hidden="true">
        <Play className="h-6 w-6 fill-current" />
      </span>
      <div className="absolute bottom-0 flex w-full items-end justify-between gap-3 p-5">
        <div>
          <p className="text-sm font-extrabold">{video.title}</p>
          <p className="text-[11px] text-zinc-300">{video.meta}</p>
        </div>
        <span className="rounded bg-bento-lime px-2 py-1 font-mono text-[10px] font-bold text-bento-ink">ALUMNI</span>
      </div>
    </>
  );
  const shell = 'group relative mt-6 block overflow-hidden rounded-2xl border-2 border-bento-line';
  return video.url ? (
    <a href={video.url} target="_blank" rel="noopener noreferrer" className={cx(shell, FOCUS_DARK)}>
      {body}
      <span className="sr-only"> (video, opens in a new tab)</span>
    </a>
  ) : (
    <div className={shell}>{body}</div>
  );
}

export function TestimonialsSection({ content }: { content: HomeContent['testimonials'] }) {
  const hasVisitors = content.visitors.length > 0;
  const hasStories = content.stories.length > 0 || Boolean(content.storyVideo);
  if (!hasVisitors && !hasStories) return null;

  return (
    <BentoSection
      id="testimonials"
      ariaLabel="Visitors and success stories"
      tone="dark"
      wipe
      backdrop="dark-dots"
      decor={<Shape kind="lime-circle" depth={2.5} className="-bottom-24 -left-24 hidden h-72 w-72 opacity-90 lg:block" />}
    >
      <Spotlight />
      <div className={cx(CONTAINER, 'relative z-10 grid gap-12 py-20 lg:grid-cols-2')}>
        <SectionMedia media={content} tone="dark" className="lg:col-span-2" />
        {hasVisitors && <Slider items={content.visitors} label="Visitor comment" tone="dark" headingId="visitors-heading" heading={content.visitorsHeading} />}
        {hasStories &&
          (content.stories.length > 0 ? (
            <Slider
              items={content.stories}
              label="Success story"
              tone="light"
              headingId="stories-heading"
              heading={content.storiesHeading}
              extra={content.storyVideo ? <StoryVideo video={content.storyVideo} /> : null}
            />
          ) : (
            <div>
              <RevealHeading as="h2" id="stories-heading" text={content.storiesHeading} className="text-2xl font-extrabold uppercase tracking-tight sm:text-3xl" />
              {content.storyVideo && <StoryVideo video={content.storyVideo} />}
            </div>
          ))}
      </div>
    </BentoSection>
  );
}


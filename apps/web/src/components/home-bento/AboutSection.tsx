'use client';

import React, { useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { ArrowRight, Play } from 'lucide-react';
import { useSiteInfo } from '@/components/site/SiteContentProvider';
import type { HomeContent, StatItem } from '@/lib/home-content';
import { BentoCard } from './BentoCard';
import { FlightPath, Magnetic, Spotlight } from './Effects';
import { MediaFill } from './Media';
import { HomeIcon } from './icons';
import { BentoSection, Shape, Stagger } from './Section';
import { CountUp, Eyebrow, RevealHeading, Scramble } from './Text';
import { useReduce } from './hooks';
import { BTN_OUTLINE_LIME, CONTAINER, FOCUS_DARK, H2, cx } from './tokens';

const formatPadded = (n: number) => String(Math.round(n)).padStart(2, '0');
const formatPlain = (n: number) => String(Math.round(n));
const formatInr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

function Ring({ value, children }: { value: number; children: React.ReactNode }) {
  const ref = useRef<SVGSVGElement>(null);
  const inView = useInView(ref, { once: true, margin: '-60px' });
  const reduce = useReduce();
  return (
    <div className="relative flex h-14 w-14 shrink-0 items-center justify-center">
      <svg ref={ref} viewBox="0 0 56 56" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="28" cy="28" r="24" fill="none" stroke="#333333" strokeWidth="5" />
        <motion.circle
          cx="28"
          cy="28"
          r="24"
          fill="none"
          stroke="#C6F432"
          strokeWidth="5"
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: inView ? Math.max(0.001, value / 100) : 0 }}
          transition={reduce ? { duration: 0 } : { duration: 1.4, ease: [0.22, 1, 0.36, 1], delay: 0.15 }}
        />
      </svg>
      <span className="relative text-sm font-extrabold">{children}</span>
    </div>
  );
}

function StatTile({ stat }: { stat: StatItem }) {
  const short = stat.value !== null && !stat.text && stat.format !== 'inr';
  const format = stat.format === 'inr' ? formatInr : stat.pad ? formatPadded : formatPlain;
  return (
    <BentoCard as="li" border="dark" shadow="lime" shadowOnHover className="bg-bento-panel p-5 text-white">
      <Ring value={stat.ring}>
        {short && stat.value !== null ? <CountUp value={stat.value} format={format} /> : <HomeIcon name={stat.icon} className="h-5 w-5 text-bento-lime" />}
      </Ring>
      {!short && (
        <p className="mt-3 text-xl font-extrabold tracking-tight [overflow-wrap:anywhere]">
          {stat.text ? <Scramble text={stat.text} /> : stat.value !== null ? <CountUp value={stat.value} format={format} /> : null}
        </p>
      )}
      <p className={cx('text-[13px] leading-snug text-zinc-300', short ? 'mt-3' : 'mt-1')}>{stat.label}</p>
    </BentoCard>
  );
}

export function AboutSection({ content }: { content: HomeContent['about'] }) {
  const siteInfo = useSiteInfo();
  const reduce = useReduce();

  return (
    <BentoSection
      id="about"
      labelledBy="about-heading"
      tone="dark"
      wipe
      backdrop="dark-dots"
      decor={
        <>
          <Shape kind="lime-circle" depth={3} className="-right-16 top-10 h-80 w-80 opacity-90" />
          <Shape kind="orange-square" depth={2} className="-bottom-20 right-[18%] h-44 w-44" />
          <div className="absolute inset-0 opacity-25">
            <MediaFill media={content} position="50% 60%" sizes="100vw" alt="" />
          </div>
          <div className="absolute inset-0 bg-[linear-gradient(90deg,#111_0%,rgba(17,17,17,.92)_50%,rgba(17,17,17,.74)_100%)]" />
          <FlightPath className="absolute inset-0 h-full w-full" />
        </>
      }
    >
      <Spotlight />
      <div className={cx(CONTAINER, 'relative z-10 grid items-center gap-12 py-20 lg:grid-cols-2 lg:py-24')}>
        <div>
          <Eyebrow text={content.eyebrow} />
          <RevealHeading id="about-heading" text={siteInfo.organisationName} className={cx(H2, 'mt-4 text-white')} />
          <motion.div
            aria-hidden="true"
            className="mt-6 h-1.5 w-14 origin-left rounded-full bg-bento-lime"
            initial={{ scaleX: 0 }}
            whileInView={{ scaleX: 1 }}
            viewport={{ once: true }}
            transition={reduce ? { duration: 0 } : { duration: 0.8, delay: 0.4, ease: [0.22, 1, 0.36, 1] }}
          />
          <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-zinc-300 sm:text-base">{content.intro}</p>

          {content.video && (
            <BentoCard border="dark" shadow="lime" shadowOnHover className="mt-8 bg-bento-panel p-3 pr-6">
              <div className="flex items-center gap-5">
                <div className="relative h-20 w-32 shrink-0 overflow-hidden rounded-xl">
                  <MediaFill
                    media={{ imageUrl: content.video.imageUrl || content.imageUrl, videoUrl: content.video.videoUrl, imageAlt: content.video.imageAlt }}
                    position="50% 60%"
                    sizes="128px"
                  />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/35">
                    <span className="relative flex h-10 w-10 items-center justify-center rounded-full bg-bento-lime text-bento-ink">
                      <span className="absolute inset-0 animate-ping rounded-full bg-bento-lime/50 motion-reduce:animate-none" aria-hidden="true" />
                      <Play className="relative h-4 w-4 fill-current" aria-hidden="true" />
                    </span>
                  </span>
                </div>
                <div className="min-w-0">
                  {content.video.url ? (
                    <a href={content.video.url} target="_blank" rel="noopener noreferrer" className={cx('text-sm font-extrabold hover:underline', FOCUS_DARK)}>
                      {content.video.title}
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  ) : (
                    <p className="text-sm font-extrabold">{content.video.title}</p>
                  )}
                  <p className="mt-1 font-mono text-[11px] uppercase text-zinc-400">{content.video.meta}</p>
                </div>
              </div>
            </BentoCard>
          )}

          {content.cta && (
          <div className="mt-8">
            <Magnetic>
              <a href={content.cta.href} className={cx(BTN_OUTLINE_LIME, FOCUS_DARK, 'group')}>
                {content.cta.label}
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" aria-hidden="true" />
              </a>
            </Magnetic>
          </div>
          )}
        </div>

        {content.stats.length > 0 && (
          <Stagger as="ul" className="grid grid-cols-2 gap-4 self-center sm:grid-cols-3" aria-label="The Centre in figures">
            {content.stats.map((stat) => (
              <StatTile key={stat.id} stat={stat} />
            ))}
          </Stagger>
        )}
      </div>
    </BentoSection>
  );
}

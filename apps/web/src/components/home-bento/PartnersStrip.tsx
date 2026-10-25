'use client';

import React, { useRef } from 'react';
import { ArrowUpRight, Building2, ChevronLeft, ChevronRight, Handshake, Mail } from 'lucide-react';
import { CmsImage } from '@/components/site/CmsImage';
import type { Sponsor } from '@/lib/site-content';
import type { HomeContent } from '@/lib/home-content';
import { Marquee, type MarqueeHandle } from './Marquee';
import { SectionMedia, hasMedia } from './Media';
import { CONTAINER, FOCUS, ICON_BTN, cx } from './tokens';

const SPONSOR_LINK_REL = 'noopener noreferrer sponsored';

function PartnerChip({ sponsor }: { sponsor: Sponsor }) {
  const body = (
    <>
      <span className="relative block h-8 w-28">
        {sponsor.logoUrl ? (
          <CmsImage src={sponsor.logoUrl} alt="" sizes="112px" className="object-contain" />
        ) : (
          <span className="flex h-full items-center justify-center font-mono text-[11px] font-bold uppercase tracking-[0.15em]">{sponsor.name}</span>
        )}
      </span>
      <span className="sr-only">{sponsor.name}</span>
    </>
  );
  const chip =
    'group relative flex h-14 w-40 items-center justify-center rounded-xl border-[2.5px] border-bento-ink bg-white px-4 transition-[transform,box-shadow] duration-200 ease-out';
  if (!sponsor.websiteUrl) {
    return (
      <div className={chip} title={sponsor.name}>
        {body}
      </div>
    );
  }
  return (
    <a
      href={sponsor.websiteUrl}
      target="_blank"
      rel={SPONSOR_LINK_REL}
      className={cx(chip, 'hover:-translate-x-1 hover:-translate-y-1 hover:shadow-[6px_6px_0_#111] focus-visible:-translate-x-1 focus-visible:-translate-y-1 focus-visible:shadow-[6px_6px_0_#111] motion-reduce:transform-none', FOCUS)}
    >
      {body}
      <span className="sr-only"> (opens in a new tab)</span>
      {/* Hover / focus tooltip */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-full z-10 mt-2 -translate-x-1/2 translate-y-1 whitespace-nowrap rounded-md bg-bento-ink px-2.5 py-1.5 font-mono text-[10px] font-bold text-white opacity-0 transition-[opacity,transform] duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100"
      >
        Visit website <ArrowUpRight className="inline h-3 w-3" />
      </span>
    </a>
  );
}

/** Industry partners: HOME-placement sponsors in a marquee with arrows, or the sponsorship note. */
export function PartnersStrip({ sponsors, content, email }: { sponsors: Sponsor[]; content: HomeContent['partners']; email: string }) {
  const marquee = useRef<MarqueeHandle>(null);

  return (
    <section id="partners" aria-labelledby="partners-heading" className="relative border-b-[2.5px] border-bento-ink bg-bento-paper text-bento-ink">
      <div className={cx(CONTAINER, 'flex flex-col items-stretch gap-5 py-7 md:flex-row md:items-center')}>
        <div className="flex shrink-0 items-center gap-3 md:border-r-2 md:border-bento-ink/15 md:pr-8">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg border-2 border-bento-ink bg-bento-lime" aria-hidden="true">
            <Building2 className="h-5 w-5" />
          </span>
          <h2 id="partners-heading" className="text-sm font-extrabold uppercase tracking-wide">
            {content.title}
          </h2>
        </div>

        {sponsors.length > 0 ? (
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <button type="button" onClick={() => marquee.current?.nudge(-1)} className={cx(ICON_BTN, 'hidden bg-white md:flex', FOCUS)} aria-label="Previous partners">
              <ChevronLeft className="h-5 w-5" aria-hidden="true" />
            </button>
            <Marquee ref={marquee} label="Industry partners" className="min-w-0 flex-1 py-3 pb-10 -mb-7" trackClassName="gap-4 pr-4" speed={36} step={176}>
              {sponsors.map((s) => (
                <PartnerChip key={s.id} sponsor={s} />
              ))}
            </Marquee>
            <button type="button" onClick={() => marquee.current?.nudge(1)} className={cx(ICON_BTN, 'hidden bg-bento-ink text-white md:flex', FOCUS)} aria-label="Next partners">
              <ChevronRight className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col gap-3 rounded-xl border-[2.5px] border-dashed border-bento-ink bg-white p-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-3">
              <Handshake className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <div>
                <h3 className="text-xs font-extrabold uppercase tracking-wider">{content.fallbackTitle}</h3>
                <p className="mt-1 max-w-2xl text-xs leading-relaxed text-bento-muted">{content.fallbackBody}</p>
              </div>
            </div>
            <a
              href={`mailto:${email}`}
              className={cx('inline-flex min-h-[44px] shrink-0 items-center gap-2 break-all rounded-lg px-2 text-xs font-extrabold underline decoration-2 underline-offset-4 hover:decoration-bento-orange', FOCUS)}
            >
              <Mail className="h-4 w-4 shrink-0" aria-hidden="true" />
              {email}
            </a>
          </div>
        )}
      </div>
      {hasMedia(content) && (
        <div className={cx(CONTAINER, 'pb-7')}>
          <SectionMedia media={content} />
        </div>
      )}
    </section>
  );
}

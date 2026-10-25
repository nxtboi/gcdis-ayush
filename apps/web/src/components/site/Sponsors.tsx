'use client';

import React from 'react';
import { Building2, ExternalLink, Handshake, Mail } from 'lucide-react';
import { Reveal } from '@/components/motion/Reveal';
import { Stagger, StaggerItem } from '@/components/motion/Stagger';
import { CmsImage } from '@/components/site/CmsImage';
import { useSiteInfo } from '@/components/site/SiteContentProvider';
import { groupSponsorsByTier, type Sponsor, type SponsorTier } from '@/lib/site-content';

/* ------------------------------------------------------------------ */
/* Tier presentation                                                   */
/* ------------------------------------------------------------------ */

/**
 * Centred, wrapping rows: higher tiers get wider cards and taller logo boxes. Item widths account for the
 * row gap (0.75rem below sm, 1rem from sm) so rows fill exactly; a short last row stays centred.
 */
const SMALL_ITEM = 'w-[calc(50%-0.375rem)] sm:w-[calc(33.333%-0.667rem)] lg:w-[calc(20%-0.8rem)]';
const SMALL_SIZES = '(min-width: 1024px) 180px, (min-width: 640px) 30vw, 45vw';
const TIER_LAYOUT: Record<SponsorTier, { item: string; logo: string; sizes: string; showDescription: boolean }> = {
  TITLE: { item: 'w-full max-w-xl', logo: 'h-28 sm:h-36', sizes: '(min-width: 640px) 520px, 90vw', showDescription: true },
  PLATINUM: { item: 'w-full sm:w-[calc(50%-0.5rem)] sm:max-w-sm', logo: 'h-24 sm:h-28', sizes: '(min-width: 640px) 360px, 90vw', showDescription: true },
  GOLD: { item: 'w-[calc(50%-0.375rem)] sm:w-[calc(33.333%-0.667rem)] sm:max-w-xs', logo: 'h-20 sm:h-24', sizes: '(min-width: 640px) 300px, 45vw', showDescription: false },
  SILVER: { item: 'w-[calc(50%-0.375rem)] sm:w-[calc(33.333%-0.667rem)] lg:w-[calc(25%-0.75rem)]', logo: 'h-16 sm:h-20', sizes: '(min-width: 1024px) 220px, (min-width: 640px) 30vw, 45vw', showDescription: false },
  PARTNER: { item: SMALL_ITEM, logo: 'h-14 sm:h-16', sizes: SMALL_SIZES, showDescription: false },
  ACADEMIC: { item: SMALL_ITEM, logo: 'h-14 sm:h-16', sizes: SMALL_SIZES, showDescription: false },
  MEDIA: { item: SMALL_ITEM, logo: 'h-14 sm:h-16', sizes: SMALL_SIZES, showDescription: false }
};

const SPONSOR_LINK_REL = 'noopener noreferrer sponsored';

function SponsorCard({ sponsor, tier }: { sponsor: Sponsor; tier: SponsorTier }) {
  const layout = TIER_LAYOUT[tier];
  const body = (
    <>
      <span className={`relative block w-full ${layout.logo}`}>
        {sponsor.logoUrl ? (
          <CmsImage
            src={sponsor.logoUrl}
            alt=""
            sizes={layout.sizes}
            className="object-contain grayscale opacity-80 transition-[filter,opacity] duration-500 ease-out group-hover:grayscale-0 group-hover:opacity-100 group-focus-visible:grayscale-0 group-focus-visible:opacity-100 motion-reduce:transition-none"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center px-2 text-center text-sm font-black uppercase tracking-tight text-slate-700 [overflow-wrap:anywhere] group-hover:text-[#15803D] sm:text-base">
            {sponsor.name}
          </span>
        )}
      </span>
      {sponsor.logoUrl && (
        <span className="mt-3 block text-center text-[11px] font-bold text-slate-700 [overflow-wrap:anywhere]">{sponsor.name}</span>
      )}
      {layout.showDescription && sponsor.description && (
        <span className="mt-1 block text-center text-[11px] leading-relaxed text-slate-600">{sponsor.description}</span>
      )}
      {sponsor.websiteUrl && (
        <span className="mt-2 inline-flex items-center justify-center gap-1 font-mono text-[10px] font-bold uppercase tracking-wider text-[#15803D] opacity-80 group-hover:opacity-100">
          Visit website <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </span>
      )}
    </>
  );

  const cardClass =
    'group flex h-full flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-[border-color,box-shadow] duration-300 sm:p-5';

  return (
    <StaggerItem as="li" lift={Boolean(sponsor.websiteUrl)} className={layout.item}>
      {sponsor.websiteUrl ? (
        <a
          href={sponsor.websiteUrl}
          target="_blank"
          rel={SPONSOR_LINK_REL}
          title={sponsor.description ?? undefined}
          className={`${cardClass} hover:border-[#86EFAC] hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#15803D]`}
        >
          {body}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <div className={cardClass} title={sponsor.description ?? undefined}>
          {body}
        </div>
      )}
    </StaggerItem>
  );
}

function SponsorshipNote({ email, compact = false }: { email: string; compact?: boolean }) {
  return (
    <div className={`mx-auto max-w-2xl rounded-2xl border border-dashed border-slate-300 bg-white text-center ${compact ? 'p-5' : 'p-6 sm:p-8'}`}>
      <Handshake className="mx-auto h-6 w-6 text-[#15803D]" aria-hidden="true" />
      <h3 className="mt-3 text-sm font-black uppercase tracking-wider text-slate-900">Sponsorship Opportunities</h3>
      <p className="mt-2 text-xs font-medium leading-relaxed text-slate-600">
        The Centre welcomes enquiries from organisations interested in supporting its programmes and the national championship. Details
        of sponsorship and partnership arrangements are available from the Secretariat.
      </p>
      <p className="mt-3 inline-flex items-center gap-2 text-xs">
        <Mail className="h-3.5 w-3.5 shrink-0 text-[#15803D]" aria-hidden="true" />
        <a href={`mailto:${email}`} className="break-all font-semibold text-[#15803D] hover:underline">
          {email}
        </a>
      </p>
    </div>
  );
}

function TierGroups({ sponsors, trigger, headingLevel }: { sponsors: Sponsor[]; trigger: 'inView' | 'mount'; headingLevel: 'h3' }) {
  const groups = groupSponsorsByTier(sponsors);
  const Heading = headingLevel;
  return (
    <div className="space-y-10">
      {groups.map((group) => (
        <div key={group.tier} className="space-y-4">
          <Heading className="flex items-center justify-center gap-3 text-center font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-[#15803D]">
            <span aria-hidden="true" className="h-px w-8 bg-[#86EFAC]" />
            {group.sponsors.length === 1 ? group.label : group.heading}
            <span aria-hidden="true" className="h-px w-8 bg-[#86EFAC]" />
          </Heading>
          <Stagger as="ul" trigger={trigger} stagger={0.07} className="flex flex-wrap items-stretch justify-center gap-3 sm:gap-4">
            {group.sponsors.map((s) => (
              <SponsorCard key={s.id} sponsor={s} tier={group.tier} />
            ))}
          </Stagger>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Section (home page) and panel (championship tab)                    */
/* ------------------------------------------------------------------ */

interface SponsorsSectionProps {
  sponsors: Sponsor[];
  title: string;
  subtitle?: string;
  /**
   * `section`: full-width page section with its own landmark (home page).
   * `panel`: card for the championship "Sponsors & Partners" tab.
   */
  variant?: 'section' | 'panel';
  /** Shown above the tiers in the panel variant (the host institution). */
  hostInstitution?: string;
}

export function SponsorsSection({ sponsors, title, subtitle, variant = 'section', hostInstitution }: SponsorsSectionProps) {
  const { email } = useSiteInfo();
  const hasSponsors = sponsors.length > 0;

  if (variant === 'panel') {
    return (
      <div className="space-y-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="space-y-1">
          <h2 className="text-base font-black uppercase text-slate-900">{title}</h2>
          <p className="text-xs font-medium text-slate-600">
            {subtitle || (hasSponsors
              ? 'The organising committee gratefully acknowledges the support of the following organisations.'
              : 'Sponsors and partners for the 2026 edition will be announced by the organising committee.')}
          </p>
        </div>

        {hostInstitution && (
          <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <Building2 className="h-5 w-5 shrink-0 text-[#15803D]" aria-hidden="true" />
            <p className="text-xs">
              <span className="block font-mono text-[10px] font-bold uppercase text-[#15803D]">Host Institution</span>
              <span className="font-black text-slate-900">{hostInstitution}</span>
            </p>
          </div>
        )}

        {hasSponsors ? <TierGroups sponsors={sponsors} trigger="mount" headingLevel="h3" /> : <SponsorshipNote email={email} compact />}

        {hasSponsors && (
          <p className="flex items-center gap-2 text-[11px] text-slate-600">
            <Mail className="h-3.5 w-3.5 shrink-0 text-[#15803D]" aria-hidden="true" />
            <span>
              Organisations interested in supporting the championship may write to{' '}
              <a href={`mailto:${email}`} className="break-all font-semibold text-[#15803D] hover:underline">
                {email}
              </a>
              .
            </span>
          </p>
        )}
      </div>
    );
  }

  return (
    <section id="sponsors" aria-labelledby="sponsors-heading" className="scroll-mt-24 border-b border-slate-200 bg-white py-16">
      <div className="mx-auto max-w-6xl space-y-10 px-4 sm:px-6 lg:px-8">
        <Reveal className="mx-auto max-w-2xl space-y-2 text-center">
          <p className="font-mono text-xs font-bold uppercase tracking-wider text-[#15803D]">Support and Collaboration</p>
          <h2 id="sponsors-heading" className="text-2xl font-black uppercase tracking-tight text-slate-950 sm:text-3xl">
            {title}
          </h2>
          {subtitle && <p className="text-xs font-medium text-slate-600">{subtitle}</p>}
        </Reveal>
        {hasSponsors ? (
          <TierGroups sponsors={sponsors} trigger="inView" headingLevel="h3" />
        ) : (
          <Reveal>
            <SponsorshipNote email={email} />
          </Reveal>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Footer strip                                                        */
/* ------------------------------------------------------------------ */

/** Compact row of sponsor logos for the site footer. Renders nothing when the list is empty. */
export function SponsorStrip({ sponsors, title }: { sponsors: Sponsor[]; title: string }) {
  if (sponsors.length === 0) return null;
  return (
    <section aria-labelledby="footer-sponsors" className="border-b border-slate-800 pb-8">
      <h2 id="footer-sponsors" className="mb-4 text-center font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">
        {title}
      </h2>
      <ul className="flex flex-wrap items-center justify-center gap-3">
        {sponsors.map((s) => {
          const chip = (
            <span className="relative flex h-12 w-28 items-center justify-center rounded-lg bg-white/95 px-2 sm:w-32">
              {s.logoUrl ? (
                <span className="relative block h-8 w-full">
                  <CmsImage
                    src={s.logoUrl}
                    alt={s.websiteUrl ? '' : `${s.name} logo`}
                    sizes="128px"
                    className="object-contain grayscale transition-[filter] duration-500 group-hover:grayscale-0 group-focus-visible:grayscale-0 motion-reduce:transition-none"
                  />
                </span>
              ) : (
                <span className="line-clamp-2 text-center text-[10px] font-black uppercase leading-tight text-slate-700">{s.name}</span>
              )}
            </span>
          );
          return (
            <li key={s.id}>
              {s.websiteUrl ? (
                <a
                  href={s.websiteUrl}
                  target="_blank"
                  rel={SPONSOR_LINK_REL}
                  title={s.name}
                  className="group block rounded-lg opacity-80 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#22C55E]"
                >
                  {chip}
                  <span className="sr-only">{`${s.name} (opens in a new tab)`}</span>
                </a>
              ) : (
                <span className="group block opacity-80" title={s.name}>
                  {chip}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

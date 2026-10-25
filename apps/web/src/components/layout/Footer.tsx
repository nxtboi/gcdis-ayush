'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Facebook, Instagram, Linkedin, Mail, MapPin, Phone, Twitter, Youtube, type LucideIcon } from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
import { SponsorStrip } from '@/components/site/Sponsors';
import { usePlacementSponsors, useSiteContent } from '@/components/site/SiteContentProvider';
import { SOCIAL_KEYS, type SocialKey } from '@/lib/site-content';
import { CHAMPIONSHIP_NAME, CHAMPIONSHIP_PATH } from '@/lib/championship';
import { useHiddenHomeSections } from '@/components/site/HomeSectionsProvider';
import { linksToHiddenSection } from '@/lib/home-sections';

/**
 * Link that also works for fragment links to the page currently open. Next.js updates the URL of a
 * same-page fragment link with `history.pushState`, which does not fire `hashchange`, so the
 * championship page would not switch tabs. A plain anchor is used in that case.
 */
function FooterLink({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const [path, hash] = href.split('#');
  if (hash !== undefined && path === pathname) {
    return (
      <a href={`#${hash}`} className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

const linkClass = 'transition-colors hover:text-white';

/** Links to home page sections ("The Centre"); links to sections hidden in the console are dropped. */
const CENTRE_LINKS = [
  { href: '/#about', label: 'About GCDIS' },
  { href: '/#programmes', label: 'Training Programmes' },
  { href: '/#news', label: 'News and Events' },
  { href: '/#contact', label: 'Contact the Secretariat' }
];

const SOCIAL: Record<SocialKey, { label: string; icon: LucideIcon }> = {
  linkedin: { label: 'LinkedIn', icon: Linkedin },
  instagram: { label: 'Instagram', icon: Instagram },
  youtube: { label: 'YouTube', icon: Youtube },
  x: { label: 'X (formerly Twitter)', icon: Twitter },
  facebook: { label: 'Facebook', icon: Facebook }
};

export const Footer: React.FC = () => {
  const { siteInfo, sponsorsSection } = useSiteContent();
  const footerSponsors = usePlacementSponsors('FOOTER');
  const hiddenSections = useHiddenHomeSections();
  const centreLinks = CENTRE_LINKS.filter((l) => !linksToHiddenSection(l.href, hiddenSections));
  const showSponsors = sponsorsSection.enabled && sponsorsSection.showOn.footer && footerSponsors.length > 0;
  const socialLinks = SOCIAL_KEYS.filter((key) => Boolean(siteInfo.social[key])).map((key) => ({ key, url: siteInfo.social[key] as string, ...SOCIAL[key] }));
  const orgFullName = `${siteInfo.organisationName} (${siteInfo.shortName}), ${siteInfo.universityName}`;

  return (
    <footer className="border-t border-slate-800 bg-slate-950 text-xs text-slate-400">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        {showSponsors && (
          <div className="mb-10">
            <SponsorStrip sponsors={footerSponsors} title={sponsorsSection.title} />
          </div>
        )}
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-5">
          {/* Institutional information */}
          <div className="space-y-3 sm:col-span-2">
            <Link href="/" aria-label={`${siteInfo.shortName} home`} className="inline-flex w-fit">
              <Logo size={52} withWordmark />
            </Link>
            <p className="max-w-sm text-xs font-medium leading-relaxed text-slate-400">
              The {orgFullName}, supports education and research in aerial robotics and flight simulation, and organises the{' '}
              {CHAMPIONSHIP_NAME}.
            </p>
            <p className="w-fit rounded-full border border-slate-800 bg-slate-900 px-3 py-1.5 font-mono text-[11px] font-semibold text-[#22C55E]">
              Organiser, {CHAMPIONSHIP_NAME}
            </p>
          </div>

          <nav aria-labelledby="footer-centre">
            <h2 id="footer-centre" className="mb-3 text-xs font-bold uppercase tracking-wider text-white">
              The Centre
            </h2>
            <ul className="space-y-2 text-xs">
              {centreLinks.map((l) => (
                <li key={l.href}>
                  <FooterLink href={l.href} className={linkClass}>
                    {l.label}
                  </FooterLink>
                </li>
              ))}
              <li>
                <Link href="/verify" className={linkClass}>
                  Verify a Certificate
                </Link>
              </li>
            </ul>
          </nav>

          <nav aria-labelledby="footer-championship">
            <h2 id="footer-championship" className="mb-3 text-xs font-bold uppercase tracking-wider text-white">
              Championship 2026
            </h2>
            <ul className="space-y-2 text-xs">
              <li>
                <FooterLink href={`${CHAMPIONSHIP_PATH}#overview`} className="font-semibold text-[#22C55E] hover:underline">
                  Championship Overview
                </FooterLink>
              </li>
              <li>
                <FooterLink href={`${CHAMPIONSHIP_PATH}#d20`} className={linkClass}>
                  Class 20 (D20) Specifications
                </FooterLink>
              </li>
              <li>
                <FooterLink href={`${CHAMPIONSHIP_PATH}#d40`} className={linkClass}>
                  Class 40 (D40) Specifications
                </FooterLink>
              </li>
              <li>
                <FooterLink href={`${CHAMPIONSHIP_PATH}#rules`} className={linkClass}>
                  Rules and Safety
                </FooterLink>
              </li>
              <li>
                <FooterLink href={`${CHAMPIONSHIP_PATH}#scoring`} className={linkClass}>
                  Live Scores
                </FooterLink>
              </li>
            </ul>
          </nav>

          <div>
            <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-white">Secretariat</h2>
            <ul className="space-y-2.5 text-xs">
              <li className="flex items-start gap-2">
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#22C55E]" aria-hidden="true" />
                <address className="not-italic leading-relaxed">
                  {siteInfo.addressLines.map((line, i) => (
                    <span key={`${i}-${line}`} className="block">
                      {line}
                    </span>
                  ))}
                  {siteInfo.mapUrl && (
                    <a href={siteInfo.mapUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block font-semibold text-[#22C55E] hover:underline">
                      View on map<span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  )}
                </address>
              </li>
              <li className="flex items-center gap-2">
                <Mail className="h-3.5 w-3.5 shrink-0 text-[#22C55E]" aria-hidden="true" />
                <a href={`mailto:${siteInfo.email}`} className="break-all hover:text-white">
                  {siteInfo.email}
                </a>
              </li>
              <li className="flex items-start gap-2">
                <Phone className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#22C55E]" aria-hidden="true" />
                <span className="flex flex-col gap-1">
                  {siteInfo.phones.map((phone, i) => (
                    <a key={`${i}-${phone.tel}`} href={`tel:${phone.tel}`} className="hover:text-white">
                      {phone.display}
                    </a>
                  ))}
                </span>
              </li>
            </ul>
            {socialLinks.length > 0 && (
              <ul aria-label="Official social media" className="mt-4 flex flex-wrap items-center gap-2">
                {socialLinks.map((item) => (
                  <li key={item.key}>
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={item.label}
                      className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-800 bg-slate-900 text-slate-400 transition-colors hover:border-[#22C55E] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#22C55E]"
                    >
                      <item.icon className="h-3.5 w-3.5" aria-hidden="true" />
                      <span className="sr-only">{`${item.label} (opens in a new tab)`}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="mt-10 flex flex-col items-center justify-between gap-3 border-t border-slate-800 pt-6 text-center text-xs text-slate-500 sm:flex-row sm:text-left">
          <p>© 2026 {orgFullName}. All rights reserved.</p>
          <div className="flex items-center gap-5 font-mono">
            <Link href={CHAMPIONSHIP_PATH} className="hover:text-slate-300">
              Championship 2026
            </Link>
            <Link href="/portal" className="hover:text-slate-300">
              Team Sign In
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
};

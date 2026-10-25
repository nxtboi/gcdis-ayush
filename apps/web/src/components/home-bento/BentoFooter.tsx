'use client';

import React, { useRef, useState } from 'react';
import Link from 'next/link';
import { motion, useInView } from 'framer-motion';
import { ArrowRight, Facebook, Instagram, Linkedin, Mail, MapPin, Phone, Twitter, Youtube, type LucideIcon } from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
import { useSiteInfo } from '@/components/site/SiteContentProvider';
import { SOCIAL_KEYS, type SocialKey } from '@/lib/site-content';
import type { FooterLink, HomeContent } from '@/lib/home-content';
import { linksToHiddenSection } from '@/lib/home-sections';
import { Magnetic } from './Effects';
import { SectionMedia } from './Media';
import { useReduce } from './hooks';
import { BTN_LIME, CONTAINER, FOCUS_DARK, cx } from './tokens';

const SOCIAL: Record<SocialKey, { label: string; icon: LucideIcon; colour: string; glow: string }> = {
  linkedin: { label: 'LinkedIn', icon: Linkedin, colour: 'bg-[#0A66C2]', glow: 'hover:shadow-[0_10px_24px_-6px_#0A66C2]' },
  instagram: { label: 'Instagram', icon: Instagram, colour: 'bg-[#C13584]', glow: 'hover:shadow-[0_10px_24px_-6px_#C13584]' },
  youtube: { label: 'YouTube', icon: Youtube, colour: 'bg-[#DC2626]', glow: 'hover:shadow-[0_10px_24px_-6px_#DC2626]' },
  x: { label: 'X (formerly Twitter)', icon: Twitter, colour: 'bg-white/10', glow: 'hover:shadow-[0_10px_24px_-6px_#ffffff55]' },
  facebook: { label: 'Facebook', icon: Facebook, colour: 'bg-[#1877F2]', glow: 'hover:shadow-[0_10px_24px_-6px_#1877F2]' }
};

const WATERMARK = 'GCDIS';

/** Huge outlined "GCDIS" whose letters flip up into place (rotateX) when the footer scrolls into view. */
function Watermark() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '-40px' });
  const reduce = useReduce();
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 bottom-[-0.18em] flex select-none justify-center text-[clamp(7rem,24vw,21rem)] font-extrabold leading-none tracking-[-0.06em] [perspective:900px]"
    >
      {WATERMARK.split('').map((letter, i) => (
        <motion.span
          key={i}
          className="inline-block text-transparent [-webkit-text-stroke:2px_#2E2E2E] [transform-origin:50%_100%]"
          initial={{ rotateX: -90, opacity: 0, y: '12%' }}
          animate={inView ? { rotateX: 0, opacity: 1, y: '0%' } : { rotateX: -90, opacity: 0, y: '12%' }}
          transition={reduce ? { duration: 0 } : { duration: 0.9, ease: [0.22, 1, 0.36, 1], delay: 0.1 + i * 0.09 }}
        >
          {letter}
        </motion.span>
      ))}
    </div>
  );
}

function FooterNav({ id, title, links }: { id: string; title: string; links: FooterLink[] }) {
  return (
    <nav aria-labelledby={id}>
      <h2 id={id} className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-zinc-400">
        {title}
      </h2>
      <ul className="mt-4 space-y-1 text-[13px]">
        {links.map((l) => {
          const cls = cx(
            'group inline-flex min-h-[32px] items-center gap-1.5 transition-colors',
            l.highlight ? 'font-bold text-bento-lime' : 'text-zinc-300 hover:text-white',
            FOCUS_DARK
          );
          const inner = (
            <>
              <ArrowRight className="h-3.5 w-3.5 -translate-x-1 opacity-0 transition-[opacity,transform] duration-200 group-hover:translate-x-0 group-hover:opacity-100" aria-hidden="true" />
              <span className="-ml-5 transition-[margin] duration-200 group-hover:ml-0">{l.label}</span>
            </>
          );
          return (
            <li key={`${l.href}-${l.label}`}>
              {l.href.startsWith('/') ? (
                <Link href={l.href} className={cls}>
                  {inner}
                </Link>
              ) : (
                <a href={l.href} className={cls}>
                  {inner}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function BentoFooter({ content, hiddenAnchors = [] }: { content: HomeContent['footer']; hiddenAnchors?: readonly string[] }) {
  const siteInfo = useSiteInfo();
  // Links to sections hidden in the staff console are not shown.
  const visible = (links: FooterLink[]) => links.filter((l) => !linksToHiddenSection(l.href, hiddenAnchors));
  const [email, setEmail] = useState('');
  const socialLinks = SOCIAL_KEYS.filter((key) => Boolean(siteInfo.social[key])).map((key) => ({ key, url: siteInfo.social[key] as string, ...SOCIAL[key] }));
  const orgFullName = `${siteInfo.organisationName}, ${siteInfo.universityName}`;

  const onSubscribe = (e: React.FormEvent) => {
    e.preventDefault();
    // There is no mailing-list API: the request is composed in the visitor's email application.
    const body = `Please add ${email} to the GCDIS mailing list for news, events and programme announcements.`;
    window.location.href = `mailto:${siteInfo.email}?subject=${encodeURIComponent(content.subscribeSubject)}&body=${encodeURIComponent(body)}`;
  };

  return (
    <footer id="contact" className="relative isolate scroll-mt-24 overflow-hidden bg-bento-ink text-zinc-300">
      <Watermark />

      <div className={cx(CONTAINER, 'pt-14')}>
        <SectionMedia media={content} tone="dark" className="mb-8" />
        <div className="flex flex-col items-stretch justify-between gap-6 rounded-[18px] border-2 border-bento-line bg-bento-panel p-6 md:flex-row md:items-center">
          <div>
            <h2 className="text-lg font-extrabold text-white">{content.subscribeTitle}</h2>
            <p className="text-[13px] text-zinc-400">{content.subscribeBody}</p>
          </div>
          <form onSubmit={onSubscribe} className="flex w-full max-w-md flex-col gap-2 sm:flex-row">
            <label htmlFor="subscribe-email" className="sr-only">
              Email address
            </label>
            <input
              id="subscribe-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@university.edu"
              className="h-12 w-full min-w-0 rounded-lg border-2 border-bento-lime sm:flex-1 bg-bento-ink px-4 text-[13px] text-white placeholder:text-zinc-500 focus:outline-none focus-visible:shadow-[0_0_0_3px_rgba(198,244,50,0.35)]"
            />
            <Magnetic>
              <button type="submit" className={cx(BTN_LIME, FOCUS_DARK, 'h-12 w-full sm:w-auto')}>
                Subscribe
              </button>
            </Magnetic>
          </form>
        </div>
        <p className="mt-2 text-[11px] text-zinc-500">Subscribing opens your email application with a request addressed to the Centre.</p>
      </div>

      <div className={cx(CONTAINER, 'grid gap-10 py-14 md:grid-cols-4')}>
        <div className="md:col-span-2">
          <Link href="/" aria-label={`${siteInfo.shortName} home`} className={cx('inline-flex w-fit rounded-full', FOCUS_DARK)}>
            <Logo size={44} withWordmark />
          </Link>
          <h2 className="sr-only">Contact</h2>
          <ul className="mt-6 space-y-3 text-[13px]">
            <li className="flex gap-3">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-bento-lime" aria-hidden="true" />
              <address className="not-italic leading-relaxed">
                {siteInfo.addressLines.join(', ')}
                {siteInfo.mapUrl && (
                  <a href={siteInfo.mapUrl} target="_blank" rel="noopener noreferrer" className={cx('ml-2 font-semibold text-bento-lime hover:underline', FOCUS_DARK)}>
                    View on map<span className="sr-only"> (opens in a new tab)</span>
                  </a>
                )}
              </address>
            </li>
            <li className="flex gap-3">
              <Phone className="mt-0.5 h-4 w-4 shrink-0 text-bento-lime" aria-hidden="true" />
              <span className="flex flex-wrap gap-x-2">
                {siteInfo.phones.map((phone, i) => (
                  <React.Fragment key={`${i}-${phone.tel}`}>
                    {i > 0 && <span aria-hidden="true">·</span>}
                    <a href={`tel:${phone.tel}`} className={cx('hover:text-white', FOCUS_DARK)}>
                      {phone.display}
                    </a>
                  </React.Fragment>
                ))}
              </span>
            </li>
            <li className="flex gap-3">
              <Mail className="mt-0.5 h-4 w-4 shrink-0 text-bento-lime" aria-hidden="true" />
              <a href={`mailto:${siteInfo.email}`} className={cx('break-all hover:text-white', FOCUS_DARK)}>
                {siteInfo.email}
              </a>
            </li>
          </ul>
        </div>
        <FooterNav id="footer-quick-links" title={content.quickLinksTitle} links={visible(content.quickLinks)} />
        <FooterNav id="footer-programmes" title={content.programmeLinksTitle} links={visible(content.programmeLinks)} />
      </div>

      <div className="border-t-2 border-bento-line">
        <div className={cx(CONTAINER, 'flex flex-col items-center gap-5 py-8 text-center')}>
          {socialLinks.length > 0 && (
            <>
              <h2 className="text-base font-extrabold uppercase tracking-wide text-white">Follow us</h2>
              <ul aria-label="Official social media" className="flex flex-wrap justify-center gap-3">
                {socialLinks.map((item) => (
                  <li key={item.key}>
                    <motion.a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      whileHover={{ y: -6 }}
                      whileFocus={{ y: -6 }}
                      transition={{ type: 'spring', stiffness: 420, damping: 22 }}
                      className={cx('group relative flex h-11 w-11 items-center justify-center rounded-lg text-white transition-shadow', item.colour, item.glow, FOCUS_DARK)}
                    >
                      <item.icon className="h-5 w-5" aria-hidden="true" />
                      <span className="sr-only">{`${item.label} (opens in a new tab)`}</span>
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute top-full mt-2 whitespace-nowrap rounded-md bg-white px-2 py-1 text-[11px] font-bold text-bento-ink opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                      >
                        {item.label}
                      </span>
                    </motion.a>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="text-[12px] text-zinc-400">
            © 2026 {orgFullName}. All rights reserved.
          </p>
          <div className="flex flex-wrap justify-center gap-5 font-mono text-[12px]">
            <Link href="/verify" className={cx('text-zinc-400 hover:text-white', FOCUS_DARK)}>
              Verify a certificate
            </Link>
            <Link href="/portal" className={cx('text-zinc-400 hover:text-white', FOCUS_DARK)}>
              Team sign in
            </Link>
          </div>
        </div>
      </div>
      <div className="h-[clamp(4rem,14vw,12rem)]" aria-hidden="true" />
    </footer>
  );
}

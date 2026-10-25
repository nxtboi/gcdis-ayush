'use client';

import React, { useRef, useState } from 'react';
import { motion, useSpring } from 'framer-motion';
import { ArrowRight, ChevronDown, Send } from 'lucide-react';
import { useSiteInfo } from '@/components/site/SiteContentProvider';
import type { HomeContent, Service } from '@/lib/home-content';
import { BentoCard, ITEM_REVEAL } from './BentoCard';
import { LightSweep, Magnetic } from './Effects';
import { HomeIcon } from './icons';
import { ItemMedia, SectionMedia } from './Media';
import { BentoSection, Stagger } from './Section';
import { Eyebrow, RevealHeading } from './Text';
import { usePointerEffects, useReduce } from './hooks';
import { BTN_INK, BTN_WHITE, CONTAINER, FOCUS, FOCUS_DARK, H2, cx } from './tokens';

const TONE: Record<Service['tone'], { surface: string; shadow: 'ink' | 'lime'; muted: string; icon: string; button: string; focus: string }> = {
  dark: {
    surface: 'bg-bento-ink text-white',
    shadow: 'lime',
    muted: 'text-zinc-300',
    icon: 'bg-white/10 text-bento-lime',
    button: 'border-white/40 text-white hover:border-bento-lime hover:text-bento-lime',
    focus: FOCUS_DARK
  },
  light: {
    surface: 'bg-white text-bento-ink',
    shadow: 'ink',
    muted: 'text-bento-muted',
    icon: 'bg-bento-ink text-bento-lime',
    button: 'border-bento-ink text-bento-ink hover:bg-bento-ink hover:text-white',
    focus: FOCUS
  },
  lime: {
    surface: 'bg-bento-lime text-bento-ink',
    shadow: 'ink',
    muted: 'text-bento-ink/80',
    icon: 'bg-bento-ink text-bento-lime',
    button: 'border-bento-ink text-bento-ink hover:bg-bento-ink hover:text-bento-lime',
    focus: FOCUS
  },
  featured: {
    surface: 'bg-[linear-gradient(135deg,#15803D,#0F5132)] text-white',
    shadow: 'ink',
    muted: 'text-green-50',
    icon: 'bg-white/15 text-white',
    button: '',
    focus: FOCUS_DARK
  }
};

/** List item with a subtle 3D tilt that follows the pointer (desktop pointers only). */
function Tilt({ children, className }: { children: React.ReactNode; className?: string }) {
  const enabled = usePointerEffects();
  const rx = useSpring(0, { stiffness: 200, damping: 20 });
  const ry = useSpring(0, { stiffness: 200, damping: 20 });
  return (
    <motion.li
      className={className}
      variants={ITEM_REVEAL}
      style={{ rotateX: rx, rotateY: ry, transformPerspective: 900 }}
      onPointerMove={(e) => {
        if (!enabled || e.pointerType !== 'mouse') return;
        const r = e.currentTarget.getBoundingClientRect();
        ry.set(((e.clientX - r.left) / r.width - 0.5) * 8);
        rx.set(-((e.clientY - r.top) / r.height - 0.5) * 8);
      }}
      onPointerLeave={() => {
        rx.set(0);
        ry.set(0);
      }}
    >
      {children}
    </motion.li>
  );
}

function FloatingIcon({ service, index, className }: { service: Service; index: number; className: string }) {
  const reduce = useReduce();
  return (
    <motion.span
      className={cx('flex h-12 w-12 items-center justify-center rounded-xl', className)}
      animate={reduce ? undefined : { y: [0, -5, 0] }}
      transition={{ duration: 3.4, repeat: Infinity, ease: 'easeInOut', delay: index * 0.35 }}
    >
      <HomeIcon name={service.icon} className="h-6 w-6" />
    </motion.span>
  );
}

function ServiceCard({ service, index, onEnquire }: { service: Service; index: number; onEnquire: (id: string) => void }) {
  const tone = TONE[service.tone];

  if (service.tone === 'featured') {
    return (
      <Tilt className="h-full">
        <BentoCard reveal={false} className={cx('group relative h-full overflow-hidden p-7', tone.surface)} wrapperClassName="h-full">
          <div aria-hidden="true" className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10" />
          <LightSweep tone="dark" />
          <div className="relative">
            <ItemMedia media={service} className="mb-5" />
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-mono text-[11px] font-bold uppercase tracking-widest text-green-50">{service.title}</h3>
              <FloatingIcon service={service} index={index} className={tone.icon} />
            </div>
            {service.lead && <p className="mt-3 text-xl font-extrabold leading-snug">{service.lead}</p>}
            {service.highlights && service.highlights.items.length > 0 ? (
              <ul className="mt-5 grid grid-cols-2 gap-2 text-[11px]">
                {service.highlights.items.map((h) => (
                  <li key={h} className="rounded-lg bg-white/15 px-3 py-2 font-bold">
                    {h}
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="mt-4 space-y-1.5 text-[13px] text-green-50">
                {service.bullets.map((b) => (
                  <li key={b}>• {b}</li>
                ))}
              </ul>
            )}
            <div className="mt-6">
              <Magnetic>
                <button type="button" onClick={() => onEnquire(service.id)} className={cx(BTN_WHITE, FOCUS_DARK)}>
                  Request a quote
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </button>
              </Magnetic>
            </div>
          </div>
        </BentoCard>
      </Tilt>
    );
  }

  return (
    <BentoCard as="li" shadow={tone.shadow} className={cx('p-7', tone.surface)} wrapperClassName="h-full">
      <ItemMedia media={service} className="mb-5" />
      <FloatingIcon service={service} index={index} className={tone.icon} />
      <h3 className="mt-5 text-lg font-extrabold uppercase">{service.title}</h3>
      <ul className={cx('mt-3 space-y-1.5 text-[13px]', tone.muted)}>
        {service.bullets.map((b) => (
          <li key={b}>• {b}</li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => onEnquire(service.id)}
        className={cx('mt-6 inline-flex min-h-[44px] items-center gap-2 rounded-lg border-2 px-4 text-[11px] font-extrabold uppercase transition-colors', tone.button, tone.focus)}
      >
        Enquire
        <span className="sr-only">about {service.title}</span>
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </BentoCard>
  );
}

export function ServicesSection({ content }: { content: HomeContent['services'] }) {
  const siteInfo = useSiteInfo();
  const reduce = useReduce();
  const [serviceId, setServiceId] = useState(content.items[0]?.id ?? '');
  const [organisation, setOrganisation] = useState('');
  const selectRef = useRef<HTMLSelectElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  if (content.items.length === 0) return null;

  const onEnquire = (id: string) => {
    setServiceId(id);
    formRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    window.setTimeout(() => selectRef.current?.focus({ preventScroll: true }), reduce ? 0 : 450);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // There is no enquiry API: the visitor's email application composes the message.
    const service = content.items.find((s) => s.id === serviceId)?.title ?? 'Services';
    const body = `Organisation: ${organisation}\nService: ${service}\n\n`;
    window.location.href = `mailto:${siteInfo.email}?subject=${encodeURIComponent(`Service enquiry: ${service}`)}&body=${encodeURIComponent(body)}`;
  };

  return (
    <BentoSection id="services" labelledBy="services-heading" backdrop="dots">
      <div className={cx(CONTAINER, 'py-20')}>
        <div className="text-center">
          <Eyebrow text={content.eyebrow} />
          <RevealHeading id="services-heading" text={content.heading} className={cx(H2, 'mt-3')} />
        </div>

        <SectionMedia media={content} className="mt-10" />

        <Stagger as="ul" className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {content.items.map((s, i) => (
            <ServiceCard key={s.id} service={s} index={i} onEnquire={onEnquire} />
          ))}
        </Stagger>

        <div ref={formRef} className="mt-8 scroll-mt-28">
          <BentoCard reveal={false} className="bg-white p-6 sm:p-8">
            <form onSubmit={onSubmit} className="grid items-end gap-5 lg:grid-cols-[1fr_1.6fr]">
              <div>
                <h3 className="text-lg font-extrabold uppercase">{content.enquiry.title}</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-bento-muted">{content.enquiry.body}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
                <div>
                  <label htmlFor="enquiry-organisation" className="mb-1 block text-[11px] font-bold uppercase tracking-wider">
                    Organisation
                  </label>
                  <input
                    id="enquiry-organisation"
                    type="text"
                    required
                    autoComplete="organization"
                    value={organisation}
                    onChange={(e) => setOrganisation(e.target.value)}
                    placeholder="Organisation name"
                    className="h-12 w-full rounded-lg border-[2.5px] border-bento-ink bg-white px-3 text-sm placeholder:text-bento-muted focus:outline-none focus-visible:shadow-[4px_4px_0_#111]"
                  />
                </div>
                <div>
                  <label htmlFor="enquiry-service" className="mb-1 block text-[11px] font-bold uppercase tracking-wider">
                    Service
                  </label>
                  <div className="relative">
                    <select
                      ref={selectRef}
                      id="enquiry-service"
                      value={serviceId}
                      onChange={(e) => setServiceId(e.target.value)}
                      className="h-12 w-full appearance-none rounded-lg border-[2.5px] border-bento-ink bg-white pl-3 pr-9 text-sm font-semibold focus:outline-none focus-visible:shadow-[4px_4px_0_#111]"
                    >
                      {content.items.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2" aria-hidden="true" />
                  </div>
                </div>
                <button type="submit" className={cx(BTN_INK, FOCUS, 'h-12')}>
                  <Send className="h-4 w-4" aria-hidden="true" />
                  Send enquiry
                </button>
              </div>
            </form>
          </BentoCard>
        </div>
      </div>
    </BentoSection>
  );
}

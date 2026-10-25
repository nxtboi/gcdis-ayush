'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { useReduce } from './hooks';
import { Parallax } from './Effects';
import { cx } from './tokens';

export type Backdrop = 'dots' | 'grid' | 'dark-dots' | 'dark-grid' | 'none';

const BACKDROP: Record<Exclude<Backdrop, 'none'>, string> = {
  dots: '[background-image:radial-gradient(#CFCFC6_1.5px,transparent_1.6px)] [background-size:22px_22px]',
  grid: '[background-image:linear-gradient(#DADAD2_1px,transparent_1px),linear-gradient(90deg,#DADAD2_1px,transparent_1px)] [background-size:48px_48px]',
  'dark-dots': '[background-image:radial-gradient(#2A2A2A_1.5px,transparent_1.6px)] [background-size:20px_20px]',
  'dark-grid':
    '[background-image:linear-gradient(rgba(255,255,255,.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.04)_1px,transparent_1px)] [background-size:48px_48px]'
};

interface BentoSectionProps {
  id?: string;
  labelledBy?: string;
  ariaLabel?: string;
  tone?: 'paper' | 'dark';
  backdrop?: Backdrop;
  /** Decorative layers (shapes) drawn above the backdrop and below the content. */
  decor?: React.ReactNode;
  /** Diagonal clip-path wipe as the section scrolls in (dark sections). */
  wipe?: boolean;
  className?: string;
  children: React.ReactNode;
}

const WIPE_FROM = 'polygon(0% 7%, 100% 0%, 100% 100%, 0% 100%)';
const WIPE_TO = 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)';

/** Full-width home section with its background pattern, decorative layers and optional wipe-in. */
export function BentoSection({ id, labelledBy, ariaLabel, tone = 'paper', backdrop = 'none', decor, wipe = false, className, children }: BentoSectionProps) {
  const reduce = useReduce();
  return (
    <motion.section
      id={id}
      aria-labelledby={labelledBy}
      aria-label={ariaLabel}
      className={cx(
        'relative isolate scroll-mt-24 overflow-hidden',
        tone === 'dark' ? 'bg-bento-ink text-white' : 'bg-bento-paper text-bento-ink',
        className
      )}
      initial={wipe ? { clipPath: WIPE_FROM } : undefined}
      whileInView={wipe ? { clipPath: WIPE_TO } : undefined}
      viewport={{ once: true, amount: 0.04 }}
      transition={reduce ? { duration: 0 } : { duration: 1.1, ease: [0.65, 0, 0.35, 1] }}
    >
      {backdrop !== 'none' && <div aria-hidden="true" className={cx('pointer-events-none absolute inset-0 -z-20', BACKDROP[backdrop])} />}
      {decor && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
          {decor}
        </div>
      )}
      {children}
    </motion.section>
  );
}

/** Decorative lime circle or orange rounded square with depth parallax. */
export function Shape({
  kind,
  className,
  depth = 2,
  style
}: {
  kind: 'lime-circle' | 'orange-square' | 'orange-circle';
  className?: string;
  depth?: number;
  style?: React.CSSProperties;
}) {
  const shape =
    kind === 'lime-circle'
      ? 'rounded-full bg-bento-lime'
      : kind === 'orange-circle'
        ? 'rounded-full bg-bento-orange'
        : 'rounded-[40px] bg-bento-orange rotate-[18deg]';
  return (
    <Parallax depth={depth} className={cx('absolute', className)} style={style}>
      <div className={cx('h-full w-full', shape)} />
    </Parallax>
  );
}

/** Staggers the reveal of `BentoCard` / `ITEM_REVEAL` children as the group scrolls into view. */
export function Stagger({
  children,
  className,
  as = 'div',
  stagger = 0.08,
  role,
  'aria-label': ariaLabel
}: {
  children: React.ReactNode;
  className?: string;
  as?: 'div' | 'ul';
  stagger?: number;
  role?: string;
  'aria-label'?: string;
}) {
  const Comp = as === 'ul' ? motion.ul : motion.div;
  return (
    <Comp
      className={className}
      role={role}
      aria-label={ariaLabel}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: '-80px' }}
      variants={{ hidden: {}, show: { transition: { staggerChildren: stagger } } }}
    >
      {children}
    </Comp>
  );
}

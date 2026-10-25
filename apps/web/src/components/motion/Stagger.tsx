'use client';

import React from 'react';
import { motion, type Variants } from 'framer-motion';
import { DURATION, EASE_FORMAL, VIEWPORT_ONCE } from './tokens';

type StaggerTag = 'div' | 'ul' | 'ol' | 'dl';
type ItemTag = 'div' | 'li' | 'article';

interface StaggerProps {
  children: React.ReactNode;
  className?: string;
  as?: StaggerTag;
  /** Seconds between consecutive children. */
  stagger?: number;
  delay?: number;
  /**
   * `inView` (default) starts when the group scrolls into view; `mount` starts immediately, for content
   * that appears in response to an interaction (for example a tab panel).
   */
  trigger?: 'inView' | 'mount';
  role?: string;
  'aria-label'?: string;
}

const containerVariants = (stagger: number, delay: number): Variants => ({
  hidden: {},
  visible: { transition: { staggerChildren: stagger, delayChildren: delay } }
});

export const staggerItemVariants: Variants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: DURATION.base, ease: EASE_FORMAL } }
};

/** Container that reveals its `StaggerItem` children one after another. */
export function Stagger({ children, className, as = 'div', stagger = 0.08, delay = 0, trigger = 'inView', ...rest }: StaggerProps) {
  const Component = motion[as];
  const play = trigger === 'mount' ? { animate: 'visible' } : { whileInView: 'visible', viewport: VIEWPORT_ONCE };
  return (
    <Component className={className} initial="hidden" variants={containerVariants(stagger, delay)} {...play} {...rest}>
      {children}
    </Component>
  );
}

interface StaggerItemProps {
  children: React.ReactNode;
  className?: string;
  as?: ItemTag;
  /** Subtle hover lift for cards. */
  lift?: boolean;
  id?: string;
}

/** Child of `Stagger`. With `lift`, rises 3 px on hover. */
export function StaggerItem({ children, className, as = 'div', lift = false, id }: StaggerItemProps) {
  const Component = motion[as];
  return (
    <Component
      id={id}
      className={className}
      variants={staggerItemVariants}
      whileHover={lift ? { y: -3, transition: { duration: 0.25, ease: EASE_FORMAL } } : undefined}
    >
      {children}
    </Component>
  );
}

'use client';

import React from 'react';
import { motion, MotionConfig } from 'framer-motion';
import { DURATION, EASE_FORMAL, VIEWPORT_ONCE } from './tokens';

/**
 * Applies the site-wide reduced-motion policy: transform animations are disabled for visitors who
 * request reduced motion, leaving only opacity changes. Use it at the root of server-rendered pages
 * whose sections use the motion helpers below.
 */
export function MotionRoot({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

interface RevealProps {
  children: React.ReactNode;
  className?: string;
  /** Delay in seconds before the reveal starts. */
  delay?: number;
  /** Vertical travel in pixels (12 to 24 recommended). */
  y?: number;
  id?: string;
}

/** Fades a block in with a short upward rise, once, as it scrolls into view. */
export function Reveal({ children, className, delay = 0, y = 18, id }: RevealProps) {
  return (
    <motion.div
      id={id}
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={VIEWPORT_ONCE}
      transition={{ duration: DURATION.slow, delay, ease: EASE_FORMAL }}
    >
      {children}
    </motion.div>
  );
}

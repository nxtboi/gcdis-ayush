'use client';

import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { DURATION, EASE_FORMAL } from './tokens';

interface AnimatedScoreProps {
  value: number | string;
  className?: string;
  /** Accessible label, e.g. "Team A score". */
  label?: string;
}

/**
 * A score that rolls to its new value: the previous figure lifts out while the new one rises in.
 * The box keeps its size so that surrounding layout does not shift.
 */
export function AnimatedScore({ value, className, label }: AnimatedScoreProps) {
  return (
    <span className={`relative inline-flex overflow-hidden tabular-nums ${className ?? ''}`} aria-label={label ? `${label}: ${value}` : undefined}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={String(value)}
          className="inline-block"
          initial={{ y: '60%', opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: '-60%', opacity: 0 }}
          transition={{ duration: DURATION.fast, ease: EASE_FORMAL }}
          aria-hidden={label ? true : undefined}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

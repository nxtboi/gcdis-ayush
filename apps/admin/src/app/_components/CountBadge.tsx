'use client';

import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';

/**
 * Small count pill used on the console menu. Positioning is left to the sidebar (inline after the label,
 * or on the icon corner when the sidebar is collapsed). The number pops in when it changes; reduced motion
 * keeps only the fade (MotionProvider sets reducedMotion="user").
 */
export default function CountBadge({
  count,
  label,
  tone,
  active,
  testId
}: {
  count: number;
  /** Full sentence for screen readers and the tooltip, e.g. "3 pending email verifications". */
  label: string;
  tone: 'amber' | 'lime';
  /** The menu item is selected (the pill switches to the dark variant to stay readable on the lime highlight). */
  active?: boolean;
  testId?: string;
}) {
  const colours = active
    ? tone === 'amber'
      ? 'bg-slate-950 text-amber-300 border-slate-950'
      : 'bg-slate-950 text-bento-lime border-slate-950'
    : tone === 'amber'
      ? 'bg-amber-400 text-slate-950 border-slate-950/40'
      : 'bg-bento-lime text-slate-950 border-slate-950/40';
  return (
    <AnimatePresence initial={false}>
      <motion.span
        key={count}
        data-testid={testId}
        title={label}
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.2 }}
        className={`relative z-10 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full border px-1.5 text-[10px] font-black tabular-nums ${colours}`}
      >
        {count > 99 ? '99+' : count}
        <span className="sr-only"> {label}</span>
      </motion.span>
    </AnimatePresence>
  );
}

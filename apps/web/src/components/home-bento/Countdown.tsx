'use client';

import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { getCountdown, getEventPhase, pad2, type CountdownParts, type EventPhase } from '@/lib/countdown';
import { useReduce } from './hooks';
import { EASE, cx } from './tokens';

/**
 * Current time, ticking every second. `null` on the server and the first client render, so time-based
 * output never causes a hydration mismatch.
 */
export function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

/** Countdown parts and event phase for an event window (both `null` before mount). */
export function useEventCountdown(startsAt: string, endsAt: string): { parts: CountdownParts | null; phase: EventPhase | null } {
  const now = useNow();
  return {
    parts: now === null ? null : getCountdown(startsAt, now),
    phase: now === null ? null : getEventPhase(startsAt, endsAt, now)
  };
}

function Digit({ value, label, size }: { value: string; label: string; size: 'md' | 'lg' }) {
  const reduce = useReduce();
  return (
    <div className={cx('rounded-xl border-2 border-white/15 bg-white/10 px-2 py-2 text-center', size === 'lg' ? 'min-w-[3.6rem]' : 'min-w-[3.25rem]')}>
      <div className={cx('relative overflow-hidden font-bold tabular-nums', size === 'lg' ? 'h-8 text-2xl leading-8' : 'h-7 text-xl leading-7')}>
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={value}
            className="block"
            initial={{ y: reduce ? 0 : '-100%', opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: reduce ? 0 : '100%', opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.35, ease: EASE }}
          >
            {value}
          </motion.span>
        </AnimatePresence>
      </div>
      <p className="text-[9px] uppercase tracking-wider text-zinc-400">{label}</p>
    </div>
  );
}

/** Days / hours / minutes / seconds boxes with a rolling digit transition ("--" until mounted). */
export function CountdownDigits({ parts, size = 'md', className }: { parts: CountdownParts | null; size?: 'md' | 'lg'; className?: string }) {
  const units = [
    { label: 'Days', value: parts ? pad2(parts.days) : '--' },
    { label: 'Hrs', value: parts ? pad2(parts.hours) : '--' },
    { label: 'Min', value: parts ? pad2(parts.minutes) : '--' },
    { label: 'Sec', value: parts ? pad2(parts.seconds) : '--' }
  ];
  return (
    <div
      role="timer"
      aria-label={parts ? `${parts.days} days, ${parts.hours} hours and ${parts.minutes} minutes remaining` : 'Time remaining'}
      className={cx('flex gap-2 font-mono', className)}
    >
      {units.map((u) => (
        <Digit key={u.label} value={u.value} label={u.label} size={size} />
      ))}
    </div>
  );
}

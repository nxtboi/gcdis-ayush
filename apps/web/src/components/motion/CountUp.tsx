'use client';

import React, { useEffect, useRef } from 'react';
import { animate, useInView, useReducedMotion } from 'framer-motion';
import { EASE_FORMAL } from './tokens';

interface CountUpProps {
  value: number;
  /** `inr` renders "₹1,00,000"; `plain` renders Indian digit grouping without a symbol. */
  format?: 'inr' | 'plain';
  suffix?: string;
  duration?: number;
  className?: string;
}

function formatValue(n: number, format: 'inr' | 'plain', suffix: string): string {
  const grouped = Math.round(n).toLocaleString('en-IN');
  return `${format === 'inr' ? '₹' : ''}${grouped}${suffix}`;
}

/**
 * Counts up to `value` once when scrolled into view. The final value is rendered on the server and on
 * the first client render (no hydration mismatch, correct without JavaScript); the count-up is skipped
 * when the visitor prefers reduced motion. Screen readers always receive the final value.
 */
export function CountUp({ value, format = 'plain', suffix = '', duration = 1.4, className }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-80px' });
  const reduceMotion = useReducedMotion();
  const finalText = formatValue(value, format, suffix);
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || reduceMotion || started.current) return;
    if (!inView) {
      el.textContent = formatValue(0, format, suffix);
      return;
    }
    started.current = true;
    const controls = animate(0, value, {
      duration,
      ease: EASE_FORMAL,
      onUpdate: (latest) => {
        el.textContent = formatValue(latest, format, suffix);
      },
      onComplete: () => {
        el.textContent = finalText;
      }
    });
    return () => {
      controls.stop();
      el.textContent = finalText;
    };
  }, [inView, reduceMotion, value, format, suffix, duration, finalText]);

  return (
    <span className={className}>
      <span className="sr-only">{finalText}</span>
      <span ref={ref} aria-hidden="true" className="tabular-nums">
        {finalText}
      </span>
    </span>
  );
}

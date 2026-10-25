'use client';

import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { animate, motion, useAnimationFrame, useInView, useMotionValue } from 'framer-motion';
import { useReduce } from './hooks';
import { cx } from './tokens';

export interface MarqueeHandle {
  /** Shift the strip by one step (`1` = forward, `-1` = back). */
  nudge: (direction: 1 | -1) => void;
}

interface MarqueeProps {
  /** One copy of the strip content (a flat list of items). */
  children: React.ReactNode;
  /** Pixels per second. */
  speed?: number;
  /** Distance of one arrow step, in pixels. */
  step?: number;
  className?: string;
  trackClassName?: string;
  label: string;
}

/**
 * Infinite marquee driven by a motion value: pauses on hover and keyboard focus, stops when off screen,
 * and does not move on its own when reduced motion is requested (arrows still work). The content is
 * repeated after mount until it is wider than the strip; extra copies are inert and hidden from
 * assistive technology, so links are reachable once.
 */
export const Marquee = React.forwardRef<MarqueeHandle, MarqueeProps>(function Marquee(
  { children, speed = 40, step = 220, className, trackClassName, label },
  handle
) {
  const viewport = useRef<HTMLDivElement>(null);
  const firstCopy = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const [reps, setReps] = useState(1);
  const [copyWidth, setCopyWidth] = useState(0);
  const paused = useRef(false);
  const nudging = useRef(false);
  const inView = useInView(viewport, { margin: '100px' });
  const reduce = useReduce();

  // Measure one copy and repeat the content so a copy is at least as wide as the strip.
  useEffect(() => {
    const vp = viewport.current;
    const copy = firstCopy.current;
    if (!vp || !copy) return;
    const measure = () => {
      const unit = copy.scrollWidth / reps;
      if (unit <= 0) return;
      const needed = Math.max(1, Math.ceil(vp.clientWidth / unit));
      if (needed !== reps) setReps(needed);
      setCopyWidth(unit * needed);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(vp);
    return () => ro.disconnect();
  }, [reps]);

  const wrap = useCallback(
    (v: number) => {
      if (copyWidth <= 0) return v;
      return (((v % copyWidth) - copyWidth) % copyWidth);
    },
    [copyWidth]
  );

  useAnimationFrame((_, delta) => {
    if (reduce || paused.current || nudging.current || !inView || copyWidth <= 0) return;
    x.set(wrap(x.get() - (speed * Math.min(delta, 64)) / 1000));
  });

  useImperativeHandle(
    handle,
    () => ({
      nudge: (direction) => {
        if (copyWidth <= 0) return;
        nudging.current = true;
        const from = x.get();
        animate(x, from - direction * step, {
          duration: reduce ? 0 : 0.5,
          ease: [0.22, 1, 0.36, 1],
          onComplete: () => {
            x.set(wrap(x.get()));
            nudging.current = false;
          }
        });
      }
    }),
    [copyWidth, reduce, step, wrap, x]
  );

  // Copy 0 holds the accessible items once; every repetition after it is inert and hidden from assistive technology.
  const copy = (index: number) => (
    <div key={index} ref={index === 0 ? firstCopy : undefined} className="flex shrink-0">
      {Array.from({ length: reps }, (_, r) => {
        const hidden = index > 0 || r > 0;
        return (
          <div key={r} className={cx('flex shrink-0 items-center', trackClassName)} aria-hidden={hidden ? true : undefined} inert={hidden ? true : undefined}>
            {children}
          </div>
        );
      })}
    </div>
  );

  return (
    <div
      ref={viewport}
      role="region"
      aria-label={label}
      className={cx('relative overflow-hidden', className)}
      onMouseEnter={() => (paused.current = true)}
      onMouseLeave={() => (paused.current = false)}
      onFocusCapture={() => (paused.current = true)}
      onBlurCapture={() => (paused.current = false)}
    >
      <motion.div className="flex w-max" style={{ x }}>
        {copy(0)}
        {copy(1)}
      </motion.div>
    </div>
  );
});

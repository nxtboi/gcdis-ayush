'use client';

/**
 * Text motion primitives: kinetic headings, decoding labels and counters. The final text is always
 * rendered on the server and on the first client render; effects run only after mount, once, in view.
 */
import React, { useEffect, useRef } from 'react';
import { animate, motion, useInView, type Variants } from 'framer-motion';
import { useReduce } from './hooks';
import { LightSweep } from './Effects';
import { EASE, cx } from './tokens';

/* ------------------------------------------------------------------ */
/* Kinetic heading                                                     */
/* ------------------------------------------------------------------ */

const WORD: Variants = {
  hidden: { y: '70%', opacity: 0, filter: 'blur(8px)' },
  show: { y: '0%', opacity: 1, filter: 'blur(0px)' }
};

interface RevealHeadingProps {
  text: string;
  as?: 'h2' | 'h3' | 'p';
  id?: string;
  className?: string;
  /** Words (exact match, case-insensitive) drawn in the accent colour class `accentClass`. */
  accent?: string[];
  accentClass?: string;
  delay?: number;
}

/**
 * Section heading revealed word by word: each word rises from behind a mask while sharpening from an
 * 8 px blur. With reduced motion the words appear at once.
 */
export function RevealHeading({ text, as: Tag = 'h2', id, className, accent = [], accentClass = 'text-bento-orange', delay = 0 }: RevealHeadingProps) {
  const ref = useRef<HTMLHeadingElement>(null);
  const inView = useInView(ref, { once: true, margin: '-60px' });
  const reduce = useReduce();
  const words = text.split(' ');
  const accents = accent.map((a) => a.toLowerCase());

  return (
    <Tag ref={ref} id={id} className={className}>
      {words.map((word, i) => (
        <React.Fragment key={`${i}-${word}`}>
          <span className="inline-block overflow-hidden px-[0.04em] py-[0.08em] -mx-[0.04em] -my-[0.08em] align-top">
            <motion.span
              className={cx('inline-block will-change-transform', accents.includes(word.toLowerCase()) && accentClass)}
              variants={WORD}
              initial="hidden"
              animate={inView ? 'show' : 'hidden'}
              transition={reduce ? { duration: 0 } : { duration: 0.75, ease: EASE, delay: delay + i * 0.07 }}
            >
              {word}
            </motion.span>
          </span>
          {i < words.length - 1 ? ' ' : null}
        </React.Fragment>
      ))}
    </Tag>
  );
}

/* ------------------------------------------------------------------ */
/* Scramble / decode                                                   */
/* ------------------------------------------------------------------ */

const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789/#+=';
const KEEP = /[\s·•&×,.:₹-]/;

/** Decodes from random characters into `text` when scrolled into view (screen readers get `text`). */
export function Scramble({ text, className, duration = 0.9, delay = 0 }: { text: string; className?: string; duration?: number; delay?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-40px' });
  const reduce = useReduce();

  useEffect(() => {
    const el = ref.current;
    if (!el || !inView || reduce) return;
    let raf = 0;
    let start = 0;
    const tick = (now: number) => {
      if (!start) start = now + delay * 1000;
      const p = Math.max(0, Math.min(1, (now - start) / (duration * 1000)));
      const settled = Math.floor(p * text.length);
      let out = '';
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        out += i < settled || KEEP.test(c) ? c : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }
      el.textContent = out;
      if (p < 1) raf = requestAnimationFrame(tick);
      else el.textContent = text;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.textContent = text;
    };
  }, [inView, reduce, text, duration, delay]);

  return (
    <span className={className}>
      <span className="sr-only">{text}</span>
      <span ref={ref} aria-hidden="true">
        {text}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Eyebrow label                                                       */
/* ------------------------------------------------------------------ */

/** Lime label above a heading: pops in, decodes its text and catches a light sweep. */
export function Eyebrow({ text, className, tone = 'lime' }: { text: string; className?: string; tone?: 'lime' | 'ink' }) {
  const reduce = useReduce();
  return (
    <motion.p
      className={cx(
        'relative inline-block overflow-hidden rounded-md px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.24em]',
        tone === 'lime' ? 'bg-bento-lime text-bento-ink' : 'bg-bento-ink text-bento-lime',
        className
      )}
      initial={{ opacity: 0, scale: 0.85 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 26 }}
    >
      <Scramble text={text} duration={0.7} delay={0.1} />
      <LightSweep />
    </motion.p>
  );
}

/* ------------------------------------------------------------------ */
/* Count-up with motion blur                                           */
/* ------------------------------------------------------------------ */

/**
 * Counts up to `value` once in view, with a brief vertical motion blur (SVG filter `#bento-vblur`, defined
 * in HomeBento) while the digits move. Renders the final value first; skipped with reduced motion.
 */
export function CountUp({ value, format, duration = 1.5, className }: { value: number; format: (n: number) => string; duration?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-60px' });
  const reduce = useReduce();
  const finalText = format(value);
  // Latest formatter without restarting the animation when the parent re-renders.
  const formatRef = useRef(format);
  formatRef.current = format;

  useEffect(() => {
    const el = ref.current;
    if (!el || !inView || reduce) return;
    const fmt = formatRef.current;
    el.style.filter = 'url(#bento-vblur)';
    const controls = animate(0, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (latest) => {
        el.textContent = fmt(latest);
        if (latest > value * 0.85) el.style.filter = '';
      },
      onComplete: () => {
        el.textContent = finalText;
        el.style.filter = '';
      }
    });
    return () => {
      controls.stop();
      el.textContent = finalText;
      el.style.filter = '';
    };
  }, [inView, reduce, value, duration, finalText]);

  return (
    <span className={className}>
      <span className="sr-only">{finalText}</span>
      <span ref={ref} aria-hidden="true" className="tabular-nums">
        {finalText}
      </span>
    </span>
  );
}

'use client';

/**
 * Cinematic effects of the home page, kept formal and cheap: everything animates transform, opacity,
 * filter or clip-path only, runs once per element where possible, and is switched off when the visitor
 * prefers reduced motion. Pointer effects exist only on hover-capable fine pointers and render nothing on
 * the server or the first client render (no hydration mismatch).
 */
import React, { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import {
  animate,
  motion,
  useInView,
  useMotionValue,
  useScroll,
  useSpring,
  useTransform
} from 'framer-motion';
import { usePointerEffects, useReduce } from './hooks';
import { cx } from './tokens';
import { isApiHostedImage } from '@/lib/site-content';

export const LAB_PHOTO = '/images/gcdis-drone-lab.jpg';

/* ------------------------------------------------------------------ */
/* Light sweep                                                         */
/* ------------------------------------------------------------------ */

/**
 * Soft diagonal glint that crosses its (relative, overflow-hidden) parent once when it scrolls into view,
 * and again whenever a `.group` ancestor is hovered. CSS-only animation (see globals.css `.bento-sweep`).
 */
export function LightSweep({ className, tone = 'light' }: { className?: string; tone?: 'light' | 'dark' }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-60px' });
  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-play={inView ? 'true' : undefined}
      className={cx('bento-sweep', tone === 'dark' && 'bento-sweep-dark', className)}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Depth parallax                                                      */
/* ------------------------------------------------------------------ */

/**
 * Moves its content against the scroll at a speed set by `depth` (1 = near, 3 = far background). The
 * offset starts at zero on the server and fades in on mount, so the first render matches the server.
 */
export function Parallax({
  depth = 1,
  className,
  style,
  children
}: {
  depth?: number;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReduce();
  const factor = useMotionValue(0);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] });
  const range = 40 * depth;
  const y = useTransform<number, number>([scrollYProgress, factor], ([p, f]) => (range - 2 * range * p) * f);

  useEffect(() => {
    factor.set(reduce ? 0 : 1);
  }, [reduce, factor]);

  return (
    <motion.div ref={ref} aria-hidden="true" className={className} style={{ ...style, y }}>
      {children}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Laboratory photograph with a slow scale-in                          */
/* ------------------------------------------------------------------ */

export function LabPhoto({
  position = '50% 50%',
  sizes,
  alt = '',
  className,
  src = LAB_PHOTO,
  unoptimized
}: {
  position?: string;
  sizes: string;
  alt?: string;
  className?: string;
  /** Image uploaded in the staff console; the laboratory photograph when empty. */
  src?: string | null;
  unoptimized?: boolean;
}) {
  const image = src || LAB_PHOTO;
  // Uploaded images on the API host go through the optimiser (like CmsImage); other URLs are shown as-is.
  const skipOptimiser = unoptimized ?? (image !== LAB_PHOTO && !isApiHostedImage(image));
  return (
    <motion.div
      className={cx('absolute inset-0 will-change-transform', className)}
      initial={{ scale: 1.08 }}
      whileInView={{ scale: 1 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
    >
      <Image src={image} alt={alt} fill sizes={sizes} unoptimized={skipOptimiser} className="object-cover" style={{ objectPosition: position }} />
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Cursor-follow spotlight (dark surfaces)                             */
/* ------------------------------------------------------------------ */

/**
 * Soft lime glow that follows the pointer inside its parent (which must be `relative overflow-hidden`).
 * Desktop pointers only; the native cursor is never hidden.
 */
export function Spotlight({ size = 560, colour = 'rgba(198,244,50,0.13)' }: { size?: number; colour?: string }) {
  const enabled = usePointerEffects();
  const anchor = useRef<HTMLSpanElement>(null);
  const x = useSpring(0, { stiffness: 160, damping: 24, mass: 0.6 });
  const y = useSpring(0, { stiffness: 160, damping: 24, mass: 0.6 });
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const host = anchor.current?.parentElement;
    if (!enabled || !host) return;
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const r = host.getBoundingClientRect();
      x.set(e.clientX - r.left - size / 2);
      y.set(e.clientY - r.top - size / 2);
      setVisible(true);
    };
    const leave = () => setVisible(false);
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerleave', leave);
    return () => {
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerleave', leave);
    };
  }, [enabled, size, x, y]);

  return (
    <span ref={anchor} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 z-0 block h-0 w-0">
      {enabled && (
        <motion.span
          className="absolute left-0 top-0 block rounded-full transition-opacity duration-500"
          style={{ x, y, width: size, height: size, opacity: visible ? 1 : 0, background: `radial-gradient(circle, ${colour} 0%, transparent 65%)` }}
        />
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Magnetic wrapper (primary buttons)                                  */
/* ------------------------------------------------------------------ */

/** Pulls its child gently toward the pointer (at most `strength` px) and springs back on leave. */
export function Magnetic({ children, strength = 8, className }: { children: React.ReactNode; strength?: number; className?: string }) {
  const enabled = usePointerEffects();
  const x = useSpring(0, { stiffness: 260, damping: 18, mass: 0.5 });
  const y = useSpring(0, { stiffness: 260, damping: 18, mass: 0.5 });

  return (
    <motion.span
      className={cx('inline-flex', className)}
      style={{ x, y }}
      onPointerMove={(e) => {
        if (!enabled || e.pointerType !== 'mouse') return;
        const r = e.currentTarget.getBoundingClientRect();
        const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
        const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
        x.set(Math.max(-1, Math.min(1, dx)) * strength);
        y.set(Math.max(-1, Math.min(1, dy)) * strength * 0.6);
      }}
      onPointerLeave={() => {
        x.set(0);
        y.set(0);
      }}
    >
      {children}
    </motion.span>
  );
}

/* ------------------------------------------------------------------ */
/* Drone flight path (About)                                           */
/* ------------------------------------------------------------------ */

const FLIGHT_PATH = 'M -20 520 C 180 380, 320 600, 520 470 S 860 160, 1060 300 S 1340 420, 1460 120';

/**
 * Dashed flight path that draws itself across its parent, with a small drone glyph travelling along it.
 * The dashes are revealed through a mask whose stroke animates `pathLength` 0 to 1.
 */
export function FlightPath({ className }: { className?: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const droneRef = useRef<SVGGElement>(null);
  const inView = useInView(svgRef, { once: true, margin: '-120px' });
  const reduce = useReduce();
  const progress = useMotionValue(0);
  const maskId = 'bento-flight-mask';

  useEffect(() => {
    const path = pathRef.current;
    const drone = droneRef.current;
    if (!path || !drone) return;
    const total = path.getTotalLength();
    const place = (p: number) => {
      const len = Math.max(0.001, Math.min(total, p * total));
      const pt = path.getPointAtLength(len);
      const ahead = path.getPointAtLength(Math.min(total, len + 1));
      const angle = (Math.atan2(ahead.y - pt.y, ahead.x - pt.x) * 180) / Math.PI;
      drone.setAttribute('transform', `translate(${pt.x} ${pt.y}) rotate(${angle})`);
      drone.style.opacity = p <= 0.001 ? '0' : '1';
    };
    place(progress.get());
    return progress.on('change', place);
  }, [progress]);

  useEffect(() => {
    if (!inView) return;
    if (reduce) {
      progress.set(1);
      return;
    }
    const controls = animate(progress, 1, { duration: 3.2, ease: [0.45, 0, 0.2, 1] });
    return () => controls.stop();
  }, [inView, reduce, progress]);

  return (
    <svg ref={svgRef} aria-hidden="true" viewBox="0 0 1440 640" preserveAspectRatio="xMidYMid slice" className={cx('pointer-events-none', className)}>
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="-100" y="-100" width="1640" height="840">
          <motion.path d={FLIGHT_PATH} fill="none" stroke="#fff" strokeWidth="8" style={{ pathLength: progress }} />
        </mask>
      </defs>
      <path ref={pathRef} d={FLIGHT_PATH} fill="none" stroke="#C6F432" strokeOpacity="0.5" strokeWidth="2" strokeDasharray="6 10" strokeLinecap="round" mask={`url(#${maskId})`} />
      <g ref={droneRef} style={{ opacity: 0 }}>
        <g transform="translate(-14 -14)">
          <rect x="9" y="9" width="10" height="10" rx="3" fill="#C6F432" />
          <path d="M11 11 L5 5 M17 11 L23 5 M11 17 L5 23 M17 17 L23 23" stroke="#C6F432" strokeWidth="2" strokeLinecap="round" />
          <circle cx="5" cy="5" r="3.5" fill="none" stroke="#C6F432" strokeWidth="1.5" />
          <circle cx="23" cy="5" r="3.5" fill="none" stroke="#C6F432" strokeWidth="1.5" />
          <circle cx="5" cy="23" r="3.5" fill="none" stroke="#C6F432" strokeWidth="1.5" />
          <circle cx="23" cy="23" r="3.5" fill="none" stroke="#C6F432" strokeWidth="1.5" />
        </g>
      </g>
    </svg>
  );
}


/* ------------------------------------------------------------------ */
/* Hero background parallax                                            */
/* ------------------------------------------------------------------ */

/**
 * Classic hero parallax: the background drifts down at a quarter of the scroll speed while the hero scrolls
 * away (the section clips it, so no edge is ever exposed). Zero on the server, on the first client render
 * and with reduced motion, so the hero renders exactly as designed at rest.
 */
export function HeroParallax({ className, children }: { className?: string; children: React.ReactNode }) {
  const reduce = useReduce();
  const factor = useMotionValue(0);
  const { scrollY } = useScroll();
  const y = useTransform<number, number>([scrollY, factor], ([s, f]) => Math.min(s, 1200) * 0.25 * f);

  useEffect(() => {
    factor.set(reduce ? 0 : 1);
  }, [reduce, factor]);

  return (
    <motion.div aria-hidden="true" className={className} style={{ y }}>
      {children}
    </motion.div>
  );
}

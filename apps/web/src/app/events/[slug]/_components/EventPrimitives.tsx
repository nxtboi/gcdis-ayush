'use client';

/**
 * Championship-page building blocks, a sibling of the home page's "bold bento" design: the same BentoCard
 * tiles (ink outlines, hard offset shadows), BentoSection shells, home tokens (headings, buttons, container)
 * and light / dark rhythm, in the brighter GCDIS palette (#F8FAFC and #EFF6FF light sections, #0F172A navy,
 * greens #15803D / #22C55E / #4ADE80).
 *
 * Motion is deliberately different from the home page (no decode, light sweep or word-by-word blur): text
 * renders immediately and only fades / slides in; cards slide up with a slight stagger; numbers count up;
 * the timeline line draws on scroll; countdown digits flip; buttons get a subtle shine on hover. Everything
 * animates transform or opacity only and is switched off when the visitor prefers reduced motion.
 */
import React from 'react';
import { AnimatePresence, animate, motion, useInView, useMotionValue, useScroll, useSpring, useTransform } from 'framer-motion';
import { BentoCard } from '@/components/home-bento/BentoCard';
import { BentoSection } from '@/components/home-bento/Section';
import { usePointerEffects, useReduce } from '@/components/home-bento/hooks';
import { CONTAINER as HOME_CONTAINER, H2 as HOME_H2, cx } from '@/components/home-bento/tokens';
import { pad2, type CountdownParts } from '@/lib/countdown';

export { cx };

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

export const CONTAINER = HOME_CONTAINER;
export const H2 = HOME_H2;
export const SECTION_PAD = 'py-20 sm:py-24';
/** Anchor offset below the floating navbar and the sticky section nav. */
export const ANCHOR = '!scroll-mt-36';

/** Green accent text: #15803D on the light sections (AA), #4ADE80 on navy. */
export const ACCENT_TEXT = 'text-[#15803D]';
export const ACCENT_TEXT_DARK = 'text-[#4ADE80]';

export const FOCUS = 'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-bento-ink';
export const FOCUS_DARK = 'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#4ADE80]';

/** Subtle diagonal shine that crosses a button on hover (pseudo-element, transform only; off with reduced motion). */
export const SHINE =
  "relative isolate overflow-hidden before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:-z-10 before:w-1/3 before:-translate-x-[160%] before:skew-x-[-20deg] before:bg-white/40 before:content-[''] before:transition-transform before:duration-700 before:ease-out hover:before:translate-x-[420%] motion-reduce:before:hidden";

const BTN_BASE =
  'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border-[2.5px] px-5 py-2.5 text-xs font-extrabold uppercase tracking-wider whitespace-nowrap transition-[transform,box-shadow,background-color,color] duration-200 ease-out hover:-translate-x-0.5 hover:-translate-y-0.5 active:translate-x-[3px] active:translate-y-[3px] active:shadow-none motion-reduce:transform-none';
/** Primary call to action: GCDIS green with ink text and an ink hard shadow (home button shape). */
export const BTN_PRIMARY = `${BTN_BASE} ${SHINE} border-bento-ink bg-[#22C55E] text-bento-ink shadow-[3px_3px_0_#111] hover:shadow-[5px_5px_0_#111]`;
/** White button with an ink hard shadow (light sections). */
export const BTN_OUTLINE = `${BTN_BASE} ${SHINE} border-bento-ink bg-white text-bento-ink shadow-[3px_3px_0_#111] hover:shadow-[5px_5px_0_#111]`;
/** Outline button for navy sections. */
export const BTN_OUTLINE_DARK = `${BTN_BASE} ${SHINE} border-white/40 bg-transparent text-white hover:border-[#4ADE80] hover:text-[#4ADE80]`;

export type Tone = 'white' | 'mist' | 'navy';

const TONE: Record<Tone, { tone: 'paper' | 'dark'; backdrop: 'dots' | 'grid' | 'dark-dots'; className: string }> = {
  white: { tone: 'paper', backdrop: 'dots', className: '!bg-[#F8FAFC]' },
  mist: { tone: 'paper', backdrop: 'grid', className: '!bg-[#EFF6FF]' },
  navy: { tone: 'dark', backdrop: 'dark-dots', className: '!bg-[#0F172A]' }
};

/* ------------------------------------------------------------------ */
/* Section shell and title                                             */
/* ------------------------------------------------------------------ */

/** Full-width home BentoSection in the page palette (no clip-path wipe: motion stays on the content). */
export function EventSection({ id, labelledBy, tone, children }: { id: string; labelledBy: string; tone: Tone; children: React.ReactNode }) {
  const t = TONE[tone];
  return (
    <BentoSection id={id} labelledBy={labelledBy} tone={t.tone} backdrop={t.backdrop} className={cx(ANCHOR, t.className)}>
      <div className={cx(CONTAINER, SECTION_PAD)}>{children}</div>
    </BentoSection>
  );
}

/** Fades and slides its content up once when it scrolls into view (opacity and transform only). */
export function FadeUp({ children, className, delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  const reduce = useReduce();
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 22 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={reduce ? { duration: 0 } : { duration: 0.6, ease: [0.22, 1, 0.36, 1], delay }}
    >
      {children}
    </motion.div>
  );
}

/** Static eyebrow pill and display heading (home look); the block fades and slides in, the text never animates. */
export function SectionTitle({
  id,
  eyebrow,
  title,
  lead,
  dark = false,
  align = 'left',
  children
}: {
  id: string;
  eyebrow: string;
  title: string;
  lead?: React.ReactNode;
  dark?: boolean;
  align?: 'left' | 'center';
  children?: React.ReactNode;
}) {
  return (
    <FadeUp className={cx('max-w-3xl', align === 'center' && 'mx-auto text-center')}>
      <p className={cx('inline-block rounded-md px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.24em]', dark ? 'bg-[#4ADE80] text-bento-ink' : 'bg-bento-ink text-[#4ADE80]')}>
        {eyebrow}
      </p>
      <h2 id={id} className={cx(H2, 'mt-3', dark ? 'text-white' : 'text-bento-ink')}>
        {title}
      </h2>
      {lead && <p className={cx('mt-4 text-[15px] leading-relaxed', dark ? 'text-slate-300' : 'text-slate-600')}>{lead}</p>}
      {children}
    </FadeUp>
  );
}

/* ------------------------------------------------------------------ */
/* Cards                                                               */
/* ------------------------------------------------------------------ */

/**
 * Home BentoCard: ink outline and ink hard shadow on light sections, dark outline and lime hard shadow on
 * navy; slides up with its Stagger group, lifts on hover and keyboard focus.
 */
export function Card({
  dark = false,
  as,
  className,
  wrapperClassName,
  reveal = true,
  shadow,
  children
}: {
  dark?: boolean;
  as?: 'div' | 'article' | 'li';
  className?: string;
  wrapperClassName?: string;
  reveal?: boolean;
  shadow?: 'ink' | 'lime' | 'none';
  children: React.ReactNode;
}) {
  return (
    <BentoCard
      as={as}
      reveal={reveal}
      shadow={shadow ?? (dark ? 'lime' : 'ink')}
      border={dark ? 'dark' : 'ink'}
      wrapperClassName={wrapperClassName}
      className={cx(dark ? 'bg-[#1E293B] text-white' : 'bg-white text-bento-ink', className)}
    >
      {children}
    </BentoCard>
  );
}

/* ------------------------------------------------------------------ */
/* 3D tilt with a soft glow                                            */
/* ------------------------------------------------------------------ */

/** Tilts its card gently toward the pointer (desktop pointers only) with a soft green glow on hover / focus. */
export function Tilt({ id, className, children }: { id?: string; className?: string; children: React.ReactNode }) {
  const enabled = usePointerEffects();
  const px = useMotionValue(0);
  const py = useMotionValue(0);
  const rotateY = useSpring(useTransform(px, [-0.5, 0.5], [-4, 4]), { stiffness: 200, damping: 24 });
  const rotateX = useSpring(useTransform(py, [-0.5, 0.5], [3, -3]), { stiffness: 200, damping: 24 });

  return (
    <div
      id={id}
      className={cx('group/tilt relative scroll-mt-36 [perspective:1200px]', className)}
      onPointerMove={(e) => {
        if (!enabled || e.pointerType !== 'mouse') return;
        const r = e.currentTarget.getBoundingClientRect();
        px.set((e.clientX - r.left) / r.width - 0.5);
        py.set((e.clientY - r.top) / r.height - 0.5);
      }}
      onPointerLeave={() => {
        px.set(0);
        py.set(0);
      }}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -inset-3 rounded-[28px] bg-[#22C55E]/20 opacity-0 blur-2xl transition-opacity duration-500 group-focus-within/tilt:opacity-100 group-hover/tilt:opacity-100"
      />
      <motion.div style={enabled ? { rotateX, rotateY } : undefined} className="relative h-full">
        {children}
      </motion.div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Scroll-drawn timeline line                                          */
/* ------------------------------------------------------------------ */

/** A line that draws itself as its container scrolls through the viewport (horizontal or vertical). */
export function TimelineLine({
  target,
  orientation,
  dark = false,
  className
}: {
  target: React.RefObject<HTMLElement | null>;
  orientation: 'x' | 'y';
  dark?: boolean;
  className?: string;
}) {
  const reduce = useReduce();
  const { scrollYProgress } = useScroll({ target, offset: ['start 85%', 'end 55%'], layoutEffect: false });
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 30, mass: 0.4 });
  const style = reduce ? undefined : orientation === 'x' ? { scaleX: progress } : { scaleY: progress };
  return (
    <div aria-hidden="true" className={cx('pointer-events-none absolute overflow-hidden rounded-full', dark ? 'bg-white/15' : 'bg-bento-ink/15', className)}>
      <motion.div className={cx('absolute inset-0 bg-[#22C55E]', orientation === 'x' ? 'origin-left' : 'origin-top')} style={style} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Flip countdown                                                      */
/* ------------------------------------------------------------------ */

/** One countdown tile whose value flips over (rotateX) when it changes; a plain cross-fade with reduced motion. */
function FlipTile({ value, label }: { value: string; label: string }) {
  const reduce = useReduce();
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative h-12 w-[3.2rem] overflow-hidden rounded-lg border-2 border-white/15 bg-black/40 [perspective:260px] sm:h-14 sm:w-[3.6rem]">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={value}
            className="absolute inset-0 flex items-center justify-center font-mono text-2xl font-bold tabular-nums text-white [backface-visibility:hidden] sm:text-[1.7rem]"
            initial={reduce ? { opacity: 0 } : { rotateX: -90, opacity: 0 }}
            animate={{ rotateX: 0, opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { rotateX: 90, opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.4, ease: [0.22, 1, 0.36, 1] }}
          >
            {value}
          </motion.span>
        </AnimatePresence>
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-black/50" />
      </div>
      <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-slate-300">{label}</span>
    </div>
  );
}

/** Days / hours / minutes / seconds as flip tiles ("--" until mounted, so server and client markup match). */
export function FlipCountdown({ parts }: { parts: CountdownParts | null }) {
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
      className="flex gap-2"
    >
      {units.map((u) => (
        <FlipTile key={u.label} value={u.value} label={u.label} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Empty state                                                         */
/* ------------------------------------------------------------------ */

export function EmptyState({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) {
  return (
    <div
      className={cx(
        'rounded-2xl border-[2.5px] border-dashed px-6 py-12 text-center text-sm font-bold',
        dark ? 'border-white/30 bg-white/[0.03] text-slate-300' : 'border-bento-ink bg-white text-bento-ink'
      )}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Count-up                                                            */
/* ------------------------------------------------------------------ */

function formatCount(n: number, format: 'inr' | 'plain'): string {
  return `${format === 'inr' ? '₹' : ''}${Math.round(n).toLocaleString('en-IN')}`;
}

/**
 * Counts up to `value` once it scrolls into view (plain digits, no motion blur). The final value is rendered
 * on the server, before the count starts and whenever the count cannot run, so it is never left at zero;
 * screen readers always get the final value. Skipped with reduced motion.
 */
export function Counter({ value, format = 'plain', duration = 1.4, className }: { value: number; format?: 'inr' | 'plain'; duration?: number; className?: string }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.5 });
  const reduce = useReduce();
  const finalText = formatCount(value, format);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || !inView || reduce) return;
    const controls = animate(0, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (latest) => {
        el.textContent = formatCount(latest, format);
      },
      onComplete: () => {
        el.textContent = finalText;
      }
    });
    return () => {
      controls.stop();
      el.textContent = finalText;
    };
  }, [inView, reduce, value, format, duration, finalText]);

  return (
    <span className={className}>
      <span className="sr-only">{finalText}</span>
      <span ref={ref} aria-hidden="true" className="tabular-nums">
        {finalText}
      </span>
    </span>
  );
}

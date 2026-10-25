/**
 * Shared design tokens of the home page "bold bento" layout: off-white paper, ink outlines, lime and
 * orange accents, hard offset shadows. Motion stays formal: springs without visible overshoot.
 */
import { EASE_FORMAL } from '@/components/motion/tokens';

export const INK = '#111111';
export const PAPER = '#F2F2EC';
export const LIME = '#C6F432';
export const ORANGE = '#FF5C35';

export const EASE = EASE_FORMAL;

/** Card lift and press: quick, critically damped. */
export const SPRING_LIFT = { type: 'spring', stiffness: 520, damping: 34, mass: 0.7 } as const;
/** Larger moves (carousel snap, sliders). */
export const SPRING_SLIDE = { type: 'spring', stiffness: 260, damping: 32, mass: 0.9 } as const;

export const VIEWPORT = { once: true, margin: '-80px' } as const;

/** Page container: 16 px gutters on phones. */
export const CONTAINER = 'relative mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8';

/** Huge, tight, uppercase section heading. */
export const H2 = 'font-extrabold uppercase leading-[0.95] tracking-[-0.045em] text-[clamp(2.125rem,4.6vw,3.625rem)] [overflow-wrap:anywhere]';

/** Focus rings: ink on light surfaces, lime on dark ones. */
export const FOCUS = 'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-bento-ink';
export const FOCUS_DARK = 'focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-bento-lime';

const BTN_BASE =
  'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border-[2.5px] px-5 py-2.5 text-xs font-extrabold uppercase tracking-wider transition-[transform,box-shadow,background-color,color] duration-200 ease-out hover:-translate-x-0.5 hover:-translate-y-0.5 active:translate-x-[3px] active:translate-y-[3px] active:shadow-none motion-reduce:transform-none';

/** Lime button with an ink hard shadow (light or dark backgrounds). */
export const BTN_LIME = `${BTN_BASE} border-bento-ink bg-bento-lime text-bento-ink shadow-[3px_3px_0_#111] hover:shadow-[5px_5px_0_#111]`;
/** White button with an ink hard shadow. */
export const BTN_WHITE = `${BTN_BASE} border-bento-ink bg-white text-bento-ink shadow-[3px_3px_0_#111] hover:shadow-[5px_5px_0_#111]`;
/** Ink button (light backgrounds). */
export const BTN_INK = `${BTN_BASE} border-bento-ink bg-bento-ink text-white shadow-[3px_3px_0_#C6F432] hover:shadow-[5px_5px_0_#C6F432]`;
/** Outline button for dark backgrounds. */
export const BTN_GHOST_DARK = `${BTN_BASE} border-white/40 bg-transparent text-white hover:border-bento-lime hover:text-bento-lime`;
/** Outline lime button for dark backgrounds. */
export const BTN_OUTLINE_LIME = `${BTN_BASE} border-bento-lime bg-transparent text-bento-lime hover:bg-bento-lime hover:text-bento-ink`;

/** Round icon button (carousel arrows); 44 px tap target. */
export const ICON_BTN =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-[2.5px] border-bento-ink transition-[transform,background-color,color,opacity] duration-200 hover:-translate-y-0.5 active:translate-y-0.5 disabled:pointer-events-none disabled:opacity-35 motion-reduce:transform-none';

/** Filter chip. */
export const CHIP =
  'relative isolate inline-flex min-h-[44px] items-center rounded-full border-[2.5px] border-bento-ink px-4 text-[11px] font-extrabold uppercase tracking-wider transition-colors duration-200';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

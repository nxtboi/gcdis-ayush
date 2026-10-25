'use client';

/**
 * Shared motion primitives for the Team Portal dashboard.
 *
 * Formal motion only: short travel (≤ 8 px), eased deceleration, no springs or overshoot,
 * durations between 0.2 s and 0.45 s. Every consumer is rendered inside
 * `<MotionConfig reducedMotion="user">`, so transforms are dropped automatically when the
 * operating system requests reduced motion; components that animate layout-affecting values
 * (widths) also check `useReducedMotion()` explicitly.
 *
 * Nothing here changes the rendered size of an element, so the animations never cause layout shift.
 */

import React from 'react';
import { motion, useReducedMotion, type HTMLMotionProps, type Transition, type Variants } from 'framer-motion';

/** Decelerating ease used across the portal (matches the sign-in view). */
export const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

export const DURATION = {
  fast: 0.2,
  base: 0.3,
  slow: 0.45
} as const;

/** Tab panels: fade with a small upward slide on enter (enter-only, so a tab switch never waits on an exit). */
export const tabPanelVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: DURATION.base, ease: EASE_OUT }
  }
};

/** Container that reveals its `StaggerItem` children one after another. */
export const staggerContainer = (stagger = 0.05, delayChildren = 0.04): Variants => ({
  hidden: {},
  show: { transition: { staggerChildren: stagger, delayChildren } }
});

export const staggerItemVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: DURATION.base, ease: EASE_OUT }
  }
};

/** Hover lift for cards (transform only, so surrounding layout never moves). */
export const cardHover = {
  y: -2,
  transition: { duration: DURATION.fast, ease: EASE_OUT }
} as const;

/** Subtle press feedback for buttons. */
export const buttonPress = { scale: 0.98 } as const;

const pressTransition: Transition = { duration: 0.12, ease: 'easeOut' };

type StaggerProps = HTMLMotionProps<'div'> & {
  stagger?: number;
  delayChildren?: number;
};

/** Staggered reveal wrapper. Children should be `StaggerItem`s (or other motion elements using the same variant names). */
export function Stagger({ stagger, delayChildren, children, ...rest }: StaggerProps) {
  return (
    <motion.div variants={staggerContainer(stagger, delayChildren)} initial="hidden" animate="show" {...rest}>
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, ...rest }: HTMLMotionProps<'div'>) {
  return (
    <motion.div variants={staggerItemVariants} {...rest}>
      {children}
    </motion.div>
  );
}

/** List item variant of StaggerItem (for <ul>/<ol> lists inside a Stagger list). */
export function StaggerListItem({ children, ...rest }: HTMLMotionProps<'li'>) {
  return (
    <motion.li variants={staggerItemVariants} {...rest}>
      {children}
    </motion.li>
  );
}

/** Button with a restrained press state. Accepts every native button prop. */
export const MotionButton = React.forwardRef<HTMLButtonElement, HTMLMotionProps<'button'>>(function MotionButton(
  { whileTap, transition, disabled, ...rest },
  ref
) {
  return (
    <motion.button
      ref={ref}
      disabled={disabled}
      whileTap={disabled ? undefined : (whileTap ?? buttonPress)}
      transition={transition ?? pressTransition}
      {...rest}
    />
  );
});

/**
 * Progress bar whose fill eases to `value` (0–100). The fill is scaled horizontally rather than
 * resized, so it never triggers layout; with reduced motion it renders at its final width.
 */
export function ProgressBar({
  value,
  label,
  className = 'h-2.5 bg-slate-100',
  barClassName = 'bg-[#22C55E]'
}: {
  value: number;
  label: string;
  className?: string;
  barClassName?: string;
}) {
  const reduceMotion = useReducedMotion();
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      className={`w-full overflow-hidden rounded-full ${className}`}
    >
      <motion.div
        className={`h-full w-full origin-left rounded-full ${barClassName}`}
        initial={reduceMotion ? false : { scaleX: 0 }}
        animate={{ scaleX: clamped / 100 }}
        transition={{
          duration: reduceMotion ? 0 : DURATION.slow,
          ease: EASE_OUT,
          delay: reduceMotion ? 0 : 0.1
        }}
      />
    </div>
  );
}

/** Pulsing status dot (opacity only). Static when reduced motion is requested. */
export function StatusDot({ className = 'bg-[#22C55E]' }: { className?: string }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.span
      aria-hidden="true"
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${className}`}
      animate={reduceMotion ? undefined : { opacity: [1, 0.35, 1] }}
      transition={reduceMotion ? undefined : { duration: 2.4, ease: 'easeInOut', repeat: Infinity }}
    />
  );
}

/** Inline feedback (alerts / confirmations) that fades in without moving the surrounding layout. */
export function FadeIn({ children, ...rest }: HTMLMotionProps<'div'>) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: DURATION.fast, ease: 'easeOut' }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

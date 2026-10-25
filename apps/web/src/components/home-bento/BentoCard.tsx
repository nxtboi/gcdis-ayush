'use client';

import React, { useState } from 'react';
import { motion, type Variants } from 'framer-motion';
import { SPRING_LIFT, cx } from './tokens';

/** Reveal variants used by `Stagger` children (rise and fade). */
export const ITEM_REVEAL: Variants = {
  hidden: { opacity: 0, y: 28 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } }
};

const LIFT: Variants = {
  rest: { x: 0, y: 0 },
  lift: { x: -4, y: -4 },
  press: { x: 5, y: 5 }
};

const SHADOW_COLOUR = { ink: 'bg-bento-ink', lime: 'bg-bento-lime', orange: 'bg-bento-orange' } as const;

const WRAPPERS = { div: motion.div, article: motion.article, li: motion.li } as const;

export interface BentoCardProps {
  children: React.ReactNode;
  /** Element of the outer wrapper. */
  as?: keyof typeof WRAPPERS;
  /** Classes of the card surface (background, padding, text colour). */
  className?: string;
  /** Classes of the outer wrapper (grid placement, height). */
  wrapperClassName?: string;
  /** Colour of the hard offset shadow. */
  shadow?: keyof typeof SHADOW_COLOUR | 'none';
  /** Show the shadow only while hovered or focused. */
  shadowOnHover?: boolean;
  /** Collapse the shadow while pressed (cards that act as one control). */
  pressable?: boolean;
  /** Border style of the surface. */
  border?: 'ink' | 'dark' | 'none';
  /** Corner radius class shared by the surface and the shadow. */
  radius?: string;
  /** Join the parent `Stagger` reveal. */
  reveal?: boolean;
  /** Layout animation of the wrapper (re-flowing grids). */
  layout?: boolean | 'position';
  id?: string;
  style?: React.CSSProperties;
  'aria-label'?: string;
  'aria-roledescription'?: string;
  role?: string;
}

/**
 * Bold bento card: thick ink outline and a hard offset shadow. Hover and keyboard focus lift the card by
 * 4 px towards the top left, so the shadow grows from 6 px to 10 px; pressing pushes the card into its
 * shadow. Only transforms are animated: the shadow is a separate layer that stays in place.
 */
export function BentoCard({
  children,
  as = 'div',
  className,
  wrapperClassName,
  shadow = 'ink',
  shadowOnHover = false,
  pressable = false,
  border = 'ink',
  radius = 'rounded-[18px]',
  reveal = true,
  layout,
  id,
  style,
  role,
  ...aria
}: BentoCardProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const active = hovered || focused;
  const Wrapper = WRAPPERS[as];

  return (
    <Wrapper
      id={id}
      role={role}
      {...aria}
      layout={layout}
      variants={reveal ? ITEM_REVEAL : undefined}
      className={cx('relative', wrapperClassName)}
      style={style}
      onFocus={(e: React.FocusEvent<HTMLElement>) => {
        const target = e.target as HTMLElement;
        if (typeof target.matches === 'function' && target.matches(':focus-visible')) setFocused(true);
      }}
      onBlur={(e: React.FocusEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {shadow !== 'none' && (
        <span
          aria-hidden="true"
          className={cx(
            'pointer-events-none absolute inset-0 translate-x-[6px] translate-y-[6px] transition-opacity duration-300',
            radius,
            SHADOW_COLOUR[shadow],
            shadowOnHover && !active ? 'opacity-0' : 'opacity-100'
          )}
        />
      )}
      <motion.div
        className={cx(
          'relative h-full',
          radius,
          border === 'ink' && 'border-[2.5px] border-bento-ink',
          border === 'dark' && 'border-2 border-bento-line',
          className
        )}
        variants={LIFT}
        initial={false}
        animate={active ? 'lift' : 'rest'}
        whileTap={pressable ? 'press' : undefined}
        transition={SPRING_LIFT}
        onHoverStart={() => setHovered(true)}
        onHoverEnd={() => setHovered(false)}
        data-active={active ? 'true' : undefined}
      >
        {children}
      </motion.div>
    </Wrapper>
  );
}

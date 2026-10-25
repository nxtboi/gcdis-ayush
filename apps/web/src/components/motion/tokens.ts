/**
 * Shared motion language for the public site: short travel, eased deceleration, no bounce or overshoot.
 * Matches the tone of the hero entrance animations.
 */
export const EASE_FORMAL: [number, number, number, number] = [0.22, 1, 0.36, 1];

export const DURATION = {
  fast: 0.3,
  base: 0.45,
  slow: 0.6
} as const;

/** Reveal elements once, slightly before they are fully in view. */
export const VIEWPORT_ONCE = { once: true, margin: '-80px' } as const;

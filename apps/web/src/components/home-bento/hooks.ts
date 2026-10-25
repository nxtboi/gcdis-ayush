'use client';

import { useEffect, useState } from 'react';
import { useReducedMotion } from 'framer-motion';

/** True after the first client render (anything time-, random- or device-based renders after this). */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/**
 * Desktop pointer (mouse or trackpad that can hover) and no reduced-motion request. Always `false` on the
 * server and on the first client render, so pointer effects never cause a hydration mismatch.
 */
export function usePointerEffects(): boolean {
  const reduce = useReducedMotion();
  const [fine, setFine] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(hover: hover) and (pointer: fine)');
    const update = () => setFine(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return fine && !reduce;
}

/** Reduced-motion preference, safe to read in effects and transitions (not in rendered markup). */
export function useReduce(): boolean {
  return Boolean(useReducedMotion());
}

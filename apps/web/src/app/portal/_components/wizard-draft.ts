'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { draftHasContent, toSafeDraft } from './registration-validation';

/**
 * Autosaved registration drafts (localStorage, this browser only). Only the draft-safe text fields are
 * written (see DRAFT_SAFE_FIELDS: never passwords); every storage access is wrapped in try/catch because
 * storage can be unavailable (private windows, blocked site data).
 */

export const REGISTER_DRAFT_KEY = 'gcdis.portal.registerDraft.v1';
export const TEAM_SETUP_DRAFT_KEY = 'gcdis.portal.teamSetupDraft.v1';

export interface StoredDraft {
  values: Record<string, string>;
  step: number;
  savedAt: number;
}

export function readDraft(key: string): StoredDraft | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDraft>;
    if (!parsed || typeof parsed !== 'object' || !parsed.values || typeof parsed.values !== 'object') return null;
    const values = toSafeDraft(parsed.values as Record<string, unknown>);
    if (!draftHasContent(values)) return null;
    return { values, step: Number.isInteger(parsed.step) ? Number(parsed.step) : 0, savedAt: Number(parsed.savedAt) || 0 };
  } catch {
    return null;
  }
}

export function writeDraft(key: string, values: Record<string, unknown>, step: number): void {
  try {
    const safe = toSafeDraft(values);
    if (!draftHasContent(safe)) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify({ values: safe, step, savedAt: Date.now() }));
  } catch {
    // Storage unavailable: the draft is simply not kept
  }
}

export function clearDraft(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage unavailable
  }
}

/**
 * Offers a stored draft once on mount (`pending`), then autosaves `values` and `step` (debounced) after the
 * captain has either restored or dismissed the offer, or started typing. `enabled: false` turns it off.
 */
export function useWizardDraft(key: string, values: Record<string, unknown>, step: number, enabled = true) {
  const [pending, setPending] = useState<StoredDraft | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const decided = useRef(false);
  const initialValues = useRef(JSON.stringify(toSafeDraft(values)));

  useEffect(() => {
    if (!enabled) return;
    const stored = readDraft(key);
    // Nothing to offer when the stored draft equals what the form already shows
    if (stored && JSON.stringify(stored.values) !== initialValues.current) setPending(stored);
    else decided.current = true;
  }, [key, enabled]);

  const serialised = JSON.stringify(toSafeDraft(values));
  const dirty = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    // Nothing is written until the captain changes something (opening the form never overwrites a draft)
    if (!dirty.current) {
      if (serialised === initialValues.current) return;
      dirty.current = true;
    }
    if (!decided.current) {
      // The captain started a new entry without answering the offer: the new entry replaces the old draft
      decided.current = true;
      setPending(null);
    }
    const id = window.setTimeout(() => {
      const values = JSON.parse(serialised) as Record<string, string>;
      writeDraft(key, values, step);
      setSavedAt(draftHasContent(values) ? Date.now() : null);
    }, 600);
    return () => window.clearTimeout(id);
  }, [key, serialised, step, enabled]);

  const accept = useCallback(() => {
    decided.current = true;
    const draft = pending;
    setPending(null);
    return draft;
  }, [pending]);

  const discard = useCallback(() => {
    decided.current = true;
    setPending(null);
    clearDraft(key);
  }, [key]);

  const clear = useCallback(() => {
    clearDraft(key);
    setSavedAt(null);
  }, [key]);

  return { pending, accept, discard, clear, savedAt };
}

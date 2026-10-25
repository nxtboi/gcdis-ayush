'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { adminFetch, toPagedResult } from '../../lib/api-client';
import CountBadge from './CountBadge';

/** Dispatched on window after a registration status change so the menu badge refreshes at once. */
export const REGISTRATIONS_CHANGED_EVENT = 'gcdis:registrations-changed';
const POLL_MS = 60_000;
const REVIEW_STATUSES = ['PAYMENT_VERIFIED', 'SUBMITTED'] as const;

export function notifyRegistrationsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(REGISTRATIONS_CHANGED_EVENT));
}

/**
 * Menu badge on "Registrations": number of registrations awaiting the Secretariat's review. Teams pay straight
 * after submitting, so that is every paid entry (PAYMENT_VERIFIED) plus any entry still SUBMITTED (a category
 * without a fee). Uses the existing paged list endpoint with limit=1, whose response carries the total count,
 * so no new API is needed. Super and Event Administrators only; renders nothing at zero.
 */
export default function AwaitingReviewBadge({ role, active }: { role?: string | null; active?: boolean }) {
  const [count, setCount] = useState(0);
  const allowed = role === 'SUPER_ADMIN' || role === 'EVENT_ADMIN';

  const load = useCallback(async () => {
    try {
      const counts = await Promise.all(
        REVIEW_STATUSES.map(async (status) => {
          const { items, total } = toPagedResult(await adminFetch(`/registrations?status=${status}&limit=1&offset=0`), 'registrations');
          return total ?? items.length;
        })
      );
      setCount(counts.reduce((sum, n) => sum + n, 0));
    } catch {
      // Badge only: failures are silent
    }
  }, []);

  useEffect(() => {
    if (!allowed) return;
    void load();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    const onChange = () => void load();
    window.addEventListener(REGISTRATIONS_CHANGED_EVENT, onChange);
    return () => {
      window.clearInterval(id);
      window.removeEventListener(REGISTRATIONS_CHANGED_EVENT, onChange);
    };
  }, [allowed, load]);

  if (!allowed || count <= 0) return null;
  const label = `${count} ${count === 1 ? 'registration' : 'registrations'} awaiting review`;
  return <CountBadge count={count} label={label} tone="lime" active={active} testId="awaiting-review-badge" />;
}

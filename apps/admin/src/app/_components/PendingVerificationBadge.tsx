'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { adminFetch, toPagedResult } from '../../lib/api-client';
import CountBadge from './CountBadge';

/** Dispatched on window after a verification action so the menu badge refreshes at once. */
export const PENDING_VERIFICATIONS_CHANGED_EVENT = 'gcdis:pending-verifications-changed';
const POLL_MS = 60_000;

export function notifyPendingVerificationsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(PENDING_VERIFICATIONS_CHANGED_EVENT));
}

/**
 * Menu badge on "Registrations": number of team captains whose email address is not yet verified
 * (Super and Event Administrators; renders nothing for other roles or when the count is zero).
 */
export default function PendingVerificationBadge({ role, active }: { role?: string | null; active?: boolean }) {
  const [count, setCount] = useState(0);
  const allowed = role === 'SUPER_ADMIN' || role === 'EVENT_ADMIN';

  const load = useCallback(async () => {
    try {
      const { items, total } = toPagedResult(await adminFetch('/auth/captains/awaiting-verification?limit=1&offset=0'));
      setCount(total ?? items.length);
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
    window.addEventListener(PENDING_VERIFICATIONS_CHANGED_EVENT, onChange);
    return () => {
      window.clearInterval(id);
      window.removeEventListener(PENDING_VERIFICATIONS_CHANGED_EVENT, onChange);
    };
  }, [allowed, load]);

  if (!allowed || count <= 0) return null;
  const label = `${count} pending email ${count === 1 ? 'verification' : 'verifications'}`;
  return <CountBadge count={count} label={label} tone="amber" active={active} testId="pending-verification-badge" />;
}

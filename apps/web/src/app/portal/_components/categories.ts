'use client';

import { useEffect, useState } from 'react';
import { fetchApi } from '../../../lib/api-client';

/** Event whose categories teams register for from the portal. */
export const PORTAL_EVENT_SLUG = 'drone-soccer-2026';

export interface PortalCategory {
  id: string;
  slug: string;
  name: string;
  maxTeamSize: number;
  entryFee: number;
  currency: string;
}

interface EventResponse {
  categories?: (PortalCategory & { isActive?: boolean })[];
}

/** Entry fee as shown to captains, for example "₹1,500" (amounts are GST-inclusive). */
export function formatFee(amount: number, currency: string): string {
  if (!Number.isFinite(amount) || amount <= 0) return 'Fee announced later';
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency || 'INR'} ${amount}`;
  }
}

export interface CategoriesState {
  categories: PortalCategory[];
  loading: boolean;
  error: string | null;
}

/** Loads the active categories of the championship from GET /events/:slug. */
export function useEventCategories(): CategoriesState {
  const [state, setState] = useState<CategoriesState>({ categories: [], loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    fetchApi<EventResponse>(`/events/${PORTAL_EVENT_SLUG}`)
      .then((event) => {
        if (cancelled) return;
        const categories = (event?.categories ?? []).filter((c) => c.isActive !== false);
        setState({
          categories,
          loading: false,
          error: categories.length === 0 ? 'No competition categories are open for registration at present.' : null
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error && err.message ? err.message : 'The request failed.';
        setState({ categories: [], loading: false, error: `The competition categories could not be loaded. ${message}` });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

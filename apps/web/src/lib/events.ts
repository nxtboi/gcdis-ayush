import { cache } from 'react';
import { titleFromSlug } from '@/lib/site';
import { normaliseEventDetails, type EventDetails } from '@/lib/championship-event';

/** Event slugs that the public championship page is built for. Used when the API cannot be reached. */
export const KNOWN_EVENT_SLUGS: readonly string[] = ['drone-soccer-2026'];

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function serverApiBaseUrl(): string | null {
  const configured = process.env.API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL;
  if (configured) return configured.replace(/\/$/, '');
  return process.env.NODE_ENV === 'development' ? 'http://localhost:4000/api' : null;
}

export interface ResolvedEvent {
  slug: string;
  title: string;
}

/**
 * Resolve an event slug for the public event pages (server-side only).
 *
 * - The API (`GET /events/:slug`) is authoritative: 200 means the event exists, 404 means it does not.
 * - If the API is unreachable or errors, fall back to the list of known slugs so the championship page
 *   still renders during an API outage.
 *
 * Returns `null` when the event does not exist; callers should then call `notFound()`.
 */
export const resolveEvent = cache(async (rawSlug: string): Promise<ResolvedEvent | null> => {
  let slug: string;
  try {
    slug = decodeURIComponent(rawSlug).toLowerCase();
  } catch {
    return null;
  }
  if (!SLUG_PATTERN.test(slug) || slug.length > 100) return null;

  const fallback = (): ResolvedEvent | null =>
    KNOWN_EVENT_SLUGS.includes(slug) ? { slug, title: titleFromSlug(slug) } : null;

  const base = serverApiBaseUrl();
  if (!base) return fallback();

  try {
    const res = await fetch(`${base}/events/${encodeURIComponent(slug)}`, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(3000)
    });
    if (res.status === 404) return null;
    if (!res.ok) return fallback();
    const data = (await res.json().catch(() => null)) as { title?: unknown } | null;
    // The root title template already appends "| GCDIS", so drop a leading "GCDIS " from the API title.
    const apiTitle = typeof data?.title === 'string' ? data.title.trim().replace(/^GCDIS\s+/i, '') : '';
    const title = apiTitle || titleFromSlug(slug);
    return { slug, title };
  } catch {
    return fallback();
  }
});

/**
 * Categories (entry fees, active flags) and venue of an event from `GET /events/:slug` (server-side only,
 * revalidated every 5 minutes). `null` when the API cannot be reached: the page then leaves those facts out.
 */
export const getEventDetails = cache(async (slug: string): Promise<EventDetails | null> => {
  const base = serverApiBaseUrl();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/events/${encodeURIComponent(slug)}`, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return null;
    return normaliseEventDetails(await res.json().catch(() => null));
  } catch {
    return null;
  }
});

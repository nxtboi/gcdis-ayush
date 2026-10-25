'use client';

import React, { createContext, useContext, useMemo } from 'react';
import {
  DEFAULT_SITE_CONTENT,
  type PublicSiteContent,
  type SiteInfo,
  type Sponsor,
  type SponsorPlacement
} from '@/lib/site-content';

interface SiteContentValue extends PublicSiteContent {
  /** Sponsors loaded on the server, by placement (only the placements the current route needs). */
  sponsors: Partial<Record<SponsorPlacement, Sponsor[]>>;
}

const SiteContentContext = createContext<SiteContentValue>({ ...DEFAULT_SITE_CONTENT, sponsors: {} });

/**
 * Makes the server-fetched site content available to client components (footer, contact sections, portal).
 * Values are passed from server layouts as props, so server and client render identical markup.
 * Nested providers add sponsors for further placements (for example the championship page adds EVENT).
 */
export function SiteContentProvider({
  content,
  sponsors,
  children
}: {
  content?: PublicSiteContent;
  sponsors?: Partial<Record<SponsorPlacement, Sponsor[]>>;
  children: React.ReactNode;
}) {
  const parent = useContext(SiteContentContext);
  const value = useMemo<SiteContentValue>(
    () => ({ ...(content ?? parent), sponsors: { ...parent.sponsors, ...sponsors } }),
    [content, parent, sponsors]
  );
  return <SiteContentContext.Provider value={value}>{children}</SiteContentContext.Provider>;
}

/** Site content with section settings; defaults from lib/site.ts when no provider is present. */
export function useSiteContent(): SiteContentValue {
  return useContext(SiteContentContext);
}

/** Organisation name, address, phones, email and social links. */
export function useSiteInfo(): SiteInfo {
  return useContext(SiteContentContext).siteInfo;
}

/** Sponsors loaded for a placement on the current route (empty when none or not loaded). */
export function usePlacementSponsors(placement: SponsorPlacement): Sponsor[] {
  return useContext(SiteContentContext).sponsors[placement] ?? EMPTY;
}

const EMPTY: Sponsor[] = [];

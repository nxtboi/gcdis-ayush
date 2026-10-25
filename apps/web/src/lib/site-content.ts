/**
 * Site content managed from the staff console (site information, sponsors, gallery).
 *
 * - Server components call the `get*` fetchers below; responses are cached by Next.js for
 *   `CONTENT_REVALIDATE_SECONDS`, so edits made in the console appear across the site within about 30 s.
 * - Every value is normalised and falls back to the constants in `lib/site.ts` when the API is
 *   unreachable or a field is missing or invalid, so pages always render.
 * - The `normalise*` helpers are pure and shared with tests.
 */
import { cache } from 'react';
import { API_BASE_URL, resolveApiAssetUrl } from './api-client';
import { ORG_ADDRESS_LINES, ORG_EMAIL, ORG_PHONES } from './site';

export const CONTENT_REVALIDATE_SECONDS = 30;
const FETCH_TIMEOUT_MS = 3000;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type SocialKey = 'linkedin' | 'instagram' | 'youtube' | 'x' | 'facebook';
export const SOCIAL_KEYS: readonly SocialKey[] = ['linkedin', 'instagram', 'youtube', 'x', 'facebook'];

export interface SitePhone {
  display: string;
  tel: string;
}

export interface SiteInfo {
  organisationName: string;
  shortName: string;
  universityName: string;
  addressLines: string[];
  phones: SitePhone[];
  email: string;
  mapUrl: string | null;
  social: Partial<Record<SocialKey, string>>;
  aboutImageUrl: string | null;
  aboutImageAlt: string | null;
}

export type SponsorPlacement = 'HOME' | 'EVENT' | 'FOOTER';
export const SPONSOR_PLACEMENTS: readonly SponsorPlacement[] = ['HOME', 'EVENT', 'FOOTER'];

export type SponsorTier = 'TITLE' | 'PLATINUM' | 'GOLD' | 'SILVER' | 'PARTNER' | 'ACADEMIC' | 'MEDIA';

/** Tiers in display order (highest first). */
export const SPONSOR_TIERS: readonly SponsorTier[] = ['TITLE', 'PLATINUM', 'GOLD', 'SILVER', 'PARTNER', 'ACADEMIC', 'MEDIA'];

export const SPONSOR_TIER_LABELS: Record<SponsorTier, string> = {
  TITLE: 'Title Sponsor',
  PLATINUM: 'Platinum Sponsor',
  GOLD: 'Gold Sponsor',
  SILVER: 'Silver Sponsor',
  PARTNER: 'Partner',
  ACADEMIC: 'Academic Partner',
  MEDIA: 'Media Partner'
};

/** Plural headings for tier groups. */
export const SPONSOR_TIER_HEADINGS: Record<SponsorTier, string> = {
  TITLE: 'Title Sponsor',
  PLATINUM: 'Platinum Sponsors',
  GOLD: 'Gold Sponsors',
  SILVER: 'Silver Sponsors',
  PARTNER: 'Partners',
  ACADEMIC: 'Academic Partners',
  MEDIA: 'Media Partners'
};

export interface Sponsor {
  id: string;
  name: string;
  tier: SponsorTier;
  logoUrl: string | null;
  websiteUrl: string | null;
  description: string | null;
  placements: SponsorPlacement[];
  displayOrder: number;
}

export interface SponsorTierGroup {
  tier: SponsorTier;
  label: string;
  heading: string;
  sponsors: Sponsor[];
}

export interface SponsorsSectionSettings {
  enabled: boolean;
  title: string;
  subtitle: string;
  showOn: { home: boolean; event: boolean; footer: boolean };
}

export interface GallerySectionSettings {
  enabled: boolean;
  title: string;
  subtitle: string;
}

export interface GalleryImage {
  id: string;
  imageUrl: string;
  title: string;
  caption: string | null;
  altText: string;
  category: string | null;
  displayOrder: number;
  width: number | null;
  height: number | null;
}

export interface PublicSiteContent {
  siteInfo: SiteInfo;
  sponsorsSection: SponsorsSectionSettings;
  gallerySection: GallerySectionSettings;
}

/* ------------------------------------------------------------------ */
/* Defaults (equal to the constants in lib/site.ts)                    */
/* ------------------------------------------------------------------ */

export const DEFAULT_SITE_INFO: SiteInfo = {
  organisationName: 'Galgotias Centre for Drone Intelligence & Simulation',
  shortName: 'GCDIS',
  universityName: 'Galgotias University',
  addressLines: [...ORG_ADDRESS_LINES],
  phones: ORG_PHONES.map((p) => ({ display: p.display, tel: p.tel })),
  email: ORG_EMAIL,
  mapUrl: null,
  social: {},
  aboutImageUrl: null,
  aboutImageAlt: null
};

export const DEFAULT_SPONSORS_SECTION: SponsorsSectionSettings = {
  enabled: true,
  title: 'Sponsors and Partners',
  subtitle: '',
  showOn: { home: true, event: true, footer: true }
};

export const DEFAULT_GALLERY_SECTION: GallerySectionSettings = {
  enabled: true,
  title: 'Gallery',
  subtitle: ''
};

export const DEFAULT_SITE_CONTENT: PublicSiteContent = {
  siteInfo: DEFAULT_SITE_INFO,
  sponsorsSection: DEFAULT_SPONSORS_SECTION,
  gallerySection: DEFAULT_GALLERY_SECTION
};

/* ------------------------------------------------------------------ */
/* Normalisation helpers                                               */
/* ------------------------------------------------------------------ */

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, max = 500): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const EMAIL_PATTERN = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+$/;
const TEL_PATTERN = /^\+?[0-9]{6,15}$/;

/** Accepts only absolute http(s) URLs (no javascript:, data: or protocol-relative values). */
export function safeExternalUrl(v: unknown): string | null {
  const s = str(v, 2048);
  if (!s) return null;
  try {
    const url = new URL(s);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Image URL from the API: an API-relative upload path (`/api/uploads/files/x`) is resolved against the
 * API origin; absolute http(s) URLs are kept. Anything else is rejected.
 */
export function safeImageUrl(v: unknown): string | null {
  const s = str(v, 2048);
  if (!s) return null;
  if (s.startsWith('/') && !s.startsWith('//')) {
    const resolved = resolveApiAssetUrl(s);
    return /^https?:\/\//i.test(resolved) ? resolved : null;
  }
  return safeExternalUrl(s);
}

/** True when an image URL is served by the GCDIS API (eligible for the Next.js image optimiser). */
export function isApiHostedImage(url: string): boolean {
  if (!API_BASE_URL) return false;
  try {
    return new URL(url).origin === new URL(API_BASE_URL).origin;
  } catch {
    return false;
  }
}

export function normaliseSiteInfo(raw: unknown): SiteInfo {
  const d = DEFAULT_SITE_INFO;
  if (!isObj(raw)) return { ...d, social: {} };

  const addressLines = Array.isArray(raw.addressLines)
    ? raw.addressLines.map((l) => str(l, 200)).filter((l): l is string => Boolean(l)).slice(0, 6)
    : [];

  const phones = Array.isArray(raw.phones)
    ? raw.phones
        .map((p) => {
          if (!isObj(p)) return null;
          const display = str(p.display, 40);
          const tel = str(p.tel, 20)?.replace(/[\s-]/g, '') ?? null;
          return display && tel && TEL_PATTERN.test(tel) ? { display, tel } : null;
        })
        .filter((p): p is SitePhone => p !== null)
        .slice(0, 4)
    : [];

  const email = str(raw.email, 254);
  const social: Partial<Record<SocialKey, string>> = {};
  if (isObj(raw.social)) {
    for (const key of SOCIAL_KEYS) {
      const url = safeExternalUrl(raw.social[key]);
      if (url) social[key] = url;
    }
  }

  const aboutImageUrl = safeImageUrl(raw.aboutImageUrl);

  return {
    organisationName: str(raw.organisationName, 200) ?? d.organisationName,
    shortName: str(raw.shortName, 40) ?? d.shortName,
    universityName: str(raw.universityName, 200) ?? d.universityName,
    addressLines: addressLines.length > 0 ? addressLines : [...d.addressLines],
    phones: phones.length > 0 ? phones : d.phones.map((p) => ({ ...p })),
    email: email && EMAIL_PATTERN.test(email) ? email : d.email,
    mapUrl: safeExternalUrl(raw.mapUrl),
    social,
    aboutImageUrl,
    aboutImageAlt: aboutImageUrl ? (str(raw.aboutImageAlt, 300) ?? null) : null
  };
}

export function normaliseSponsorsSection(raw: unknown): SponsorsSectionSettings {
  const d = DEFAULT_SPONSORS_SECTION;
  if (!isObj(raw)) return { ...d, showOn: { ...d.showOn } };
  const showOn = isObj(raw.showOn) ? raw.showOn : {};
  return {
    enabled: bool(raw.enabled, d.enabled),
    title: str(raw.title, 120) ?? d.title,
    subtitle: str(raw.subtitle, 400) ?? '',
    showOn: {
      home: bool(showOn.home, d.showOn.home),
      event: bool(showOn.event, d.showOn.event),
      footer: bool(showOn.footer, d.showOn.footer)
    }
  };
}

export function normaliseGallerySection(raw: unknown): GallerySectionSettings {
  const d = DEFAULT_GALLERY_SECTION;
  if (!isObj(raw)) return { ...d };
  return {
    enabled: bool(raw.enabled, d.enabled),
    title: str(raw.title, 120) ?? d.title,
    subtitle: str(raw.subtitle, 400) ?? ''
  };
}

export function normaliseSiteContent(raw: unknown): PublicSiteContent {
  const r = isObj(raw) ? raw : {};
  return {
    siteInfo: normaliseSiteInfo(r.siteInfo),
    sponsorsSection: normaliseSponsorsSection(r.sponsorsSection),
    gallerySection: normaliseGallerySection(r.gallerySection)
  };
}

function isTier(v: unknown): v is SponsorTier {
  return typeof v === 'string' && (SPONSOR_TIERS as readonly string[]).includes(v);
}

function isPlacement(v: unknown): v is SponsorPlacement {
  return typeof v === 'string' && (SPONSOR_PLACEMENTS as readonly string[]).includes(v);
}

/**
 * Validates a sponsor list from the API: inactive and malformed entries are dropped, entries outside the
 * requested placement are removed (defensive; the API already filters by `?placement=`), and the list
 * is ordered by tier rank and then `displayOrder`.
 */
export function normaliseSponsors(raw: unknown, placement?: SponsorPlacement): Sponsor[] {
  if (!Array.isArray(raw)) return [];
  const out: Sponsor[] = [];
  raw.forEach((item, index) => {
    if (!isObj(item) || item.isActive === false) return;
    const name = str(item.name, 200);
    if (!name) return;
    const placements = Array.isArray(item.placements) ? item.placements.filter(isPlacement) : [];
    if (placement && Array.isArray(item.placements) && !placements.includes(placement)) return;
    out.push({
      id: str(item.id, 100) ?? `sponsor-${index}`,
      name,
      tier: isTier(item.tier) ? item.tier : 'PARTNER',
      logoUrl: safeImageUrl(item.logoUrl),
      websiteUrl: safeExternalUrl(item.websiteUrl),
      description: str(item.description, 500),
      placements,
      displayOrder: num(item.displayOrder) ?? index
    });
  });
  const rank = (t: SponsorTier) => SPONSOR_TIERS.indexOf(t);
  return out.sort((a, b) => rank(a.tier) - rank(b.tier) || a.displayOrder - b.displayOrder);
}

/** Groups an ordered sponsor list by tier (empty tiers omitted, highest tier first). */
export function groupSponsorsByTier(sponsors: Sponsor[]): SponsorTierGroup[] {
  return SPONSOR_TIERS.map((tier) => ({
    tier,
    label: SPONSOR_TIER_LABELS[tier],
    heading: SPONSOR_TIER_HEADINGS[tier],
    sponsors: sponsors.filter((s) => s.tier === tier)
  })).filter((g) => g.sponsors.length > 0);
}

export function normaliseGallery(raw: unknown): GalleryImage[] {
  if (!Array.isArray(raw)) return [];
  const out: GalleryImage[] = [];
  raw.forEach((item, index) => {
    if (!isObj(item) || item.isPublished === false) return;
    const imageUrl = safeImageUrl(item.imageUrl);
    if (!imageUrl) return;
    const title = str(item.title, 200) ?? '';
    const width = num(item.width);
    const height = num(item.height);
    out.push({
      id: str(item.id, 100) ?? `image-${index}`,
      imageUrl,
      title,
      caption: str(item.caption, 1000),
      altText: str(item.altText, 300) ?? title,
      category: str(item.category, 60),
      displayOrder: num(item.displayOrder) ?? index,
      width: width && width > 0 ? width : null,
      height: height && height > 0 ? height : null
    });
  });
  return out.sort((a, b) => a.displayOrder - b.displayOrder);
}

/** Distinct categories in first-appearance order. */
export function galleryCategories(images: GalleryImage[]): string[] {
  const seen: string[] = [];
  for (const img of images) if (img.category && !seen.includes(img.category)) seen.push(img.category);
  return seen;
}

/* ------------------------------------------------------------------ */
/* Server fetchers                                                     */
/* ------------------------------------------------------------------ */

function serverApiBaseUrl(): string | null {
  const configured = process.env.API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL;
  if (configured) return configured.replace(/\/$/, '');
  return process.env.NODE_ENV === 'development' ? 'http://localhost:4000/api' : null;
}

/** GET a public JSON endpoint; returns `undefined` on any failure (network, timeout, non-2xx, bad JSON). */
export async function getPublicJson(path: string): Promise<unknown> {
  const base = serverApiBaseUrl();
  if (!base) return undefined;
  try {
    const res = await fetch(`${base}${path}`, {
      next: { revalidate: CONTENT_REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    } as RequestInit);
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

/** Site information and section settings (`GET /cms/public/site`), with fallbacks. */
export const getSiteContent = cache(async (): Promise<PublicSiteContent> => normaliseSiteContent(await getPublicJson('/cms/public/site')));

/** Active sponsors for a placement (`GET /cms/sponsors?placement=`). Empty list on failure. */
export const getSponsors = cache(
  async (placement: SponsorPlacement): Promise<Sponsor[]> =>
    normaliseSponsors(await getPublicJson(`/cms/sponsors?placement=${placement}`), placement)
);

/** Published gallery images (`GET /cms/gallery`). Empty list on failure. */
export const getGalleryImages = cache(async (): Promise<GalleryImage[]> => normaliseGallery(await getPublicJson('/cms/gallery')));

/**
 * Championship media managed from the staff console: the hero background video and poster, and the
 * "Drones & Arena" photo gallery (`GET /cms/public/championship-media`, revalidated every 30 seconds), plus an
 * optional image / video for each page section and for items inside some of them (`sections`; site uploads
 * only, see `safeUploadUrl`).
 *
 * Every URL is re-validated here: images must be API uploads or absolute http(s) URLs (`safeImageUrl`), and
 * videos must be site uploads (`/api/uploads/files/...`, resolved against the API origin) or https URLs.
 * When the endpoint is missing, fails or returns nothing, the page falls back to the laboratory photograph
 * as the poster, with no video and no gallery.
 */
import { cache } from 'react';
import { resolveApiAssetUrl } from './api-client';
import { getPublicJson, safeImageUrl, type GalleryImage } from './site-content';

export type GalleryKind = 'drone' | 'arena' | 'event';
export const GALLERY_KINDS: readonly GalleryKind[] = ['drone', 'arena', 'event'];
export const GALLERY_KIND_LABELS: Record<GalleryKind, string> = { drone: 'Drones', arena: 'Arena', event: 'Event' };

export interface ChampionshipGalleryItem {
  id: string;
  imageUrl: string;
  caption: string | null;
  kind: GalleryKind;
  /** Alternative text when it differs from the caption (fallback site photographs). */
  alt?: string | null;
}

export interface GalleryContent {
  items: ChampionshipGalleryItem[];
  /** True when the championship gallery is empty and real site photographs are shown instead. */
  isFallback: boolean;
}

/** Sections of the page that can carry their own image / video (keys of the API's `sections` map). */
export type SectionMediaKey = 'facts' | 'takePart' | 'categories' | 'programme' | 'prizes' | 'rules' | 'teams' | 'scores' | 'venue' | 'finalCta';
export const SECTION_MEDIA_KEYS: readonly SectionMediaKey[] = ['facts', 'takePart', 'categories', 'programme', 'prizes', 'rules', 'teams', 'scores', 'venue', 'finalCta'];
/** Items inside a section that can carry their own media. */
export const SECTION_MEDIA_ITEMS: Partial<Record<SectionMediaKey, readonly string[]>> = {
  categories: ['d20', 'd40'],
  programme: ['day1', 'day2'],
  prizes: ['d20', 'd40']
};

/** One media slot, re-validated: absolute URLs of site uploads only (never external), alt text trimmed. */
export interface SlotMedia {
  imageUrl: string | null;
  videoUrl: string | null;
  imageAlt: string;
}

export interface SectionMedia {
  /** The section's own media (null when only items have media). */
  own: SlotMedia | null;
  items: Partial<Record<string, SlotMedia>>;
}

export type ChampionshipSectionMedia = Partial<Record<SectionMediaKey, SectionMedia>>;

export interface ChampionshipMedia {
  heroVideoUrl: string | null;
  heroPosterUrl: string | null;
  gallery: ChampionshipGalleryItem[];
  sections: ChampionshipSectionMedia;
}

export const EMPTY_CHAMPIONSHIP_MEDIA: ChampionshipMedia = { heroVideoUrl: null, heroPosterUrl: null, gallery: [], sections: {} };

/** Laboratory photograph used as the hero poster when the console has none. */
export const DEFAULT_HERO_POSTER = '/images/gcdis-drone-lab.jpg';

const MAX_GALLERY = 60;
const UPLOAD_PATH = /^\/api\/uploads\/files\/[A-Za-z0-9._-]+$/;

/** Video URL: a site upload (`/api/uploads/files/...`, resolved against the API origin) or an https URL. */
export function safeVideoUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 2048) return null;
  if (UPLOAD_PATH.test(s)) {
    const resolved = resolveApiAssetUrl(s);
    return /^https?:\/\//i.test(resolved) ? resolved : null;
  }
  try {
    const url = new URL(s);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Section media URL: only a site upload (`/api/uploads/files/<key>`), resolved against the API origin.
 * External URLs, protocol-relative URLs, data: and anything else are dropped.
 */
export function safeUploadUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!UPLOAD_PATH.test(s)) return null;
  const resolved = resolveApiAssetUrl(s);
  return /^https?:\/\//i.test(resolved) ? resolved : null;
}

function slotFrom(raw: unknown): SlotMedia | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const imageUrl = safeUploadUrl(r.imageUrl);
  const videoUrl = safeUploadUrl(r.videoUrl);
  if (!imageUrl && !videoUrl) return null;
  return { imageUrl, videoUrl, imageAlt: text(r.imageAlt, 200) ?? '' };
}

/** Normalise the `sections` map: whitelisted sections and items only, each URL re-validated. */
export function normaliseSectionMedia(raw: unknown): ChampionshipSectionMedia {
  const out: ChampionshipSectionMedia = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const data = raw as Record<string, unknown>;
  for (const key of SECTION_MEDIA_KEYS) {
    const entry = data[key];
    if (!entry || typeof entry !== 'object') continue;
    const own = slotFrom(entry);
    const items: Partial<Record<string, SlotMedia>> = {};
    const rawItems = (entry as Record<string, unknown>).items;
    for (const itemKey of SECTION_MEDIA_ITEMS[key] ?? []) {
      const slot = rawItems && typeof rawItems === 'object' ? slotFrom((rawItems as Record<string, unknown>)[itemKey]) : null;
      if (slot) items[itemKey] = slot;
    }
    if (own || Object.keys(items).length > 0) out[key] = { own, items };
  }
  return out;
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

/** Normalise the endpoint response; anything malformed is dropped. */
export function normaliseChampionshipMedia(raw: unknown): ChampionshipMedia {
  if (!raw || typeof raw !== 'object') return EMPTY_CHAMPIONSHIP_MEDIA;
  const data = raw as Record<string, unknown>;
  const gallery: ChampionshipGalleryItem[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(data.gallery) ? data.gallery : []) {
    if (!item || typeof item !== 'object' || gallery.length >= MAX_GALLERY) continue;
    const g = item as Record<string, unknown>;
    const id = text(g.id, 100);
    const imageUrl = safeImageUrl(g.imageUrl);
    const kind = GALLERY_KINDS.find((k) => k === g.kind);
    if (!id || !imageUrl || !kind || seen.has(id)) continue;
    seen.add(id);
    gallery.push({ id, imageUrl, caption: text(g.caption, 300), kind });
  }
  return {
    heroVideoUrl: safeVideoUrl(data.heroVideoUrl),
    heroPosterUrl: safeImageUrl(data.heroPosterUrl),
    gallery,
    sections: normaliseSectionMedia(data.sections)
  };
}

/** Championship media (server-side; empty on any failure, including a 404 before the endpoint exists). */
export const getChampionshipMedia = cache(
  async (): Promise<ChampionshipMedia> => normaliseChampionshipMedia(await getPublicJson('/cms/public/championship-media'))
);

/**
 * Photographs for the Drones & Arena section: the championship gallery when it has images; otherwise real
 * images that already exist on the site (the published site gallery, then the laboratory photograph), all
 * filed under "Event". Never stock or invented images.
 */
export function galleryWithFallback(gallery: ChampionshipGalleryItem[], siteGallery: GalleryImage[]): GalleryContent {
  if (gallery.length > 0) return { items: gallery, isFallback: false };
  const items: ChampionshipGalleryItem[] = siteGallery
    .filter((g) => g && g.id && g.imageUrl)
    .slice(0, 11)
    .map((g) => ({ id: `site-${g.id}`, imageUrl: g.imageUrl, caption: g.caption || g.title || null, kind: 'event' as const, alt: g.altText || g.title || null }));
  items.push({
    id: 'gcdis-drone-lab',
    imageUrl: DEFAULT_HERO_POSTER,
    caption: 'GCDIS drone laboratory, Galgotias University',
    kind: 'event',
    alt: 'The GCDIS drone laboratory at Galgotias University'
  });
  return { items, isFallback: true };
}

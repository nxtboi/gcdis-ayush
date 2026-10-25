/**
 * Home page sections managed from the staff console ("Home Page Sections"): which sections are shown, in
 * which order, and their content (GET /cms/public/home).
 *
 * - Fetched on the server and cached for `CONTENT_REVALIDATE_SECONDS`, like the rest of the site content.
 * - The API returns enabled sections only, already in page order. A section missing from a successful
 *   response is hidden; when the API is unreachable the bundled `HOME_CONTENT` is shown with every section.
 * - Content is checked against the shape of the bundled defaults (a section that does not match falls back to
 *   its defaults) and every link and image URL is re-validated, so the page always renders safely.
 */
import { cache } from 'react';
import { HOME_CONTENT, type HomeContent } from './home-content';
import { getPublicJson, safeExternalUrl, safeImageUrl } from './site-content';
import { resolveApiAssetUrl } from './api-client';

export const HOME_SECTION_KEYS = [
  'hero',
  'ticker',
  'partners',
  'about',
  'mission',
  'centres',
  'programmes',
  'marquee',
  'mous',
  'services',
  'news',
  'awards',
  'testimonials',
  'footer'
] as const;
export type HomeSectionKey = (typeof HOME_SECTION_KEYS)[number];

/** Sections of the page body (between the ticker and the footer), in the default order. */
export const HOME_BODY_KEYS = [
  'partners',
  'about',
  'mission',
  'centres',
  'programmes',
  'marquee',
  'mous',
  'services',
  'news',
  'awards',
  'testimonials'
] as const satisfies readonly HomeSectionKey[];
export type HomeBodyKey = (typeof HOME_BODY_KEYS)[number];

/** Element id of each section (navbar scroll-spy and footer anchors). */
export const HOME_SECTION_ANCHORS: Readonly<Record<HomeSectionKey, string | null>> = {
  hero: null,
  ticker: null,
  partners: 'partners',
  about: 'about',
  mission: 'mission',
  centres: 'centres',
  programmes: 'programmes',
  marquee: null,
  mous: 'mous',
  services: 'services',
  news: 'news',
  awards: 'awards',
  testimonials: 'testimonials',
  footer: 'contact'
};

export interface HomePageData {
  /** Content of every section (bundled defaults for sections the API did not return). */
  content: HomeContent;
  /** Enabled body sections in page order. */
  order: HomeBodyKey[];
  /** Whether the ticker below the hero is shown. */
  showTicker: boolean;
  /** Anchors (`about`, `news`, ...) of hidden sections: links to them are not shown. */
  hiddenAnchors: string[];
  /** False when the API was unreachable and the bundled defaults are used. */
  fromApi: boolean;
}

export const DEFAULT_HOME_PAGE: HomePageData = {
  content: HOME_CONTENT,
  order: [...HOME_BODY_KEYS],
  showTicker: true,
  hiddenAnchors: [],
  fromApi: false
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Fields that may be absent from an entry. */
const OPTIONAL_FIELDS = new Set(['placeholder', 'pad', 'format', 'text', 'lead', 'highlights', 'date', 'status', 'imageUrl', 'showRoadmap', 'highlight']);
/** Fields that may be null. */
const NULLABLE_FIELDS = new Set(['value', 'video', 'roadmap', 'details', 'highlights', 'nextEvent', 'storyVideo', 'imageUrl', 'url', 'documentUrl', 'syllabusUrl']);

/**
 * True when `raw` has the shape of `template` (the bundled default): same types for every field the template
 * has, arrays checked entry by entry against the template's first entry.
 */
export function conformsToTemplate(raw: unknown, template: unknown, key?: string): boolean {
  if (raw === null && key && NULLABLE_FIELDS.has(key)) return true;
  if (template === null) return raw === null || typeof raw === 'string' || typeof raw === 'number';
  if (Array.isArray(template)) {
    if (!Array.isArray(raw)) return false;
    return template.length === 0 || raw.every((item) => conformsToTemplate(item, template[0]));
  }
  if (isObj(template)) {
    if (!isObj(raw)) return false;
    return Object.entries(template).every(([k, v]) =>
      raw[k] === undefined ? OPTIONAL_FIELDS.has(k) : conformsToTemplate(raw[k], v, k)
    );
  }
  return typeof raw === typeof template;
}

const ANCHOR = /^#[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SITE_PATH = /^\/(?![/\\])[^\s"'<>\\`]*$/;

/** In-page anchor, same-site path or absolute http(s) URL; anything else (javascript:, data:, //host) is rejected. */
export function safeHref(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 2048) return null;
  if (ANCHOR.test(s) || SITE_PATH.test(s)) return s;
  return safeExternalUrl(s);
}

/** Path of a file uploaded through the API (the only place a home page video may come from). */
const UPLOAD_PATH = /^\/api\/uploads\/files\/[A-Za-z0-9_.-]{1,200}$/;

/**
 * Video URL of a section or entry: only a file uploaded through the API (`/api/uploads/files/...`, resolved to
 * the API origin, which the CSP allows as media-src). External URLs and embeds (YouTube, data:, blob:) are
 * rejected, so the page never loads third-party video.
 */
export function safeVideoUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!UPLOAD_PATH.test(s)) return null;
  const resolved = resolveApiAssetUrl(s);
  return /^https?:\/\//i.test(resolved) || resolved === s ? resolved : null;
}

/** Re-validates every link, image and video URL in a content value (returns a copy). */
export function sanitiseHomeLinks<T>(value: T, key?: string): T {
  if (Array.isArray(value)) return value.map((v) => sanitiseHomeLinks(v)) as unknown as T;
  if (isObj(value)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitiseHomeLinks(v, k);
    return out as T;
  }
  if (key === 'href') return (safeHref(value) ?? '#') as unknown as T;
  if (key === 'url' || key === 'documentUrl' || key === 'syllabusUrl') return (value === null ? null : safeHref(value)) as unknown as T;
  if (key === 'imageUrl') return (value === null ? null : safeImageUrl(value)) as unknown as T;
  if (key === 'videoUrl') return safeVideoUrl(value) as unknown as T;
  if (key === 'imageAlt') return (typeof value === 'string' ? value.slice(0, 200) : undefined) as unknown as T;
  return value;
}

function isHomeSectionKey(v: unknown): v is HomeSectionKey {
  return typeof v === 'string' && (HOME_SECTION_KEYS as readonly string[]).includes(v);
}

function isBodyKey(v: HomeSectionKey): v is HomeBodyKey {
  return (HOME_BODY_KEYS as readonly string[]).includes(v);
}

/** Builds the page data from a GET /cms/public/home response (pure; shared with tests). */
export function normaliseHomePage(raw: unknown): HomePageData {
  if (!isObj(raw) || !Array.isArray(raw.sections)) return DEFAULT_HOME_PAGE;

  const content: HomeContent = { ...HOME_CONTENT };
  const enabled = new Set<HomeSectionKey>(['hero', 'footer']);
  const body: { key: HomeBodyKey; sortOrder: number; index: number }[] = [];

  const seen = new Set<HomeSectionKey>();
  raw.sections.forEach((section, index) => {
    if (!isObj(section) || !isHomeSectionKey(section.key) || seen.has(section.key)) return;
    const key = section.key;
    seen.add(key);
    enabled.add(key);
    if (conformsToTemplate(section.content, HOME_CONTENT[key])) {
      (content as unknown as Record<HomeSectionKey, unknown>)[key] = sanitiseHomeLinks(section.content);
    }
    if (isBodyKey(key)) {
      const sortOrder = typeof section.sortOrder === 'number' && Number.isFinite(section.sortOrder) ? section.sortOrder : index;
      body.push({ key, sortOrder, index });
    }
  });

  return {
    content,
    order: body.sort((a, b) => a.sortOrder - b.sortOrder || a.index - b.index).map((b) => b.key),
    showTicker: enabled.has('ticker'),
    hiddenAnchors: HOME_SECTION_KEYS.filter((k) => !enabled.has(k))
      .map((k) => HOME_SECTION_ANCHORS[k])
      .filter((a): a is string => Boolean(a)),
    fromApi: true
  };
}

/** True when a link points at a section of the home page that is hidden (`#news`, `/#news`). */
export function linksToHiddenSection(href: string, hiddenAnchors: readonly string[]): boolean {
  if (hiddenAnchors.length === 0) return false;
  const m = /^\/?#([A-Za-z][A-Za-z0-9_-]*)$/.exec(href);
  return Boolean(m && hiddenAnchors.includes(m[1]));
}

/** Home page sections (`GET /cms/public/home`), with the bundled defaults as fallback. */
export const getHomePage = cache(async (): Promise<HomePageData> => normaliseHomePage(await getPublicJson('/cms/public/home')));

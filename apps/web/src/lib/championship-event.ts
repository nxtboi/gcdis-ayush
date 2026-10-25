/**
 * Pure helpers of the single-page championship event site (`/events/drone-soccer-2026`): section anchors,
 * the mapping of the old tab fragments, the event details read from `GET /events/:slug`, and the
 * schema.org SportsEvent structured data. Shared by the page and the tests.
 *
 * Facts rule: everything here comes from lib/championship.ts, the API or the console-managed site
 * information. Unknown values (venue placeholders, missing fees, registration deadlines) are left out.
 */
import {
  CHAMPIONSHIP_DATES_LABEL,
  CHAMPIONSHIP_DAYS,
  CHAMPIONSHIP_END_FALLBACK,
  CHAMPIONSHIP_NAME,
  CHAMPIONSHIP_PATH,
  CHAMPIONSHIP_START_FALLBACK,
  formatInr
} from './championship';
import type { SiteInfo } from './site-content';

/** Display dates of the championship (1 and 2 December 2026). */
export const EVENT_DATES_LABEL = CHAMPIONSHIP_DATES_LABEL;

/** Number of programme days. */
export const EVENT_DAY_COUNT = CHAMPIONSHIP_DAYS.length;

/* ------------------------------------------------------------------ */
/* Section anchors                                                     */
/* ------------------------------------------------------------------ */

export type EventSectionId =
  | 'facts'
  | 'take-part'
  | 'categories'
  | 'programme'
  | 'gallery'
  | 'partners'
  | 'prizes'
  | 'rules'
  | 'teams'
  | 'scores'
  | 'venue'
  | 'register';

/** Sections in page order, with their labels in the sticky in-page navigation. */
export const EVENT_SECTIONS: readonly { id: EventSectionId; label: string }[] = [
  { id: 'facts', label: 'Key facts' },
  { id: 'take-part', label: 'How to take part' },
  { id: 'categories', label: 'Categories' },
  { id: 'programme', label: 'Programme' },
  { id: 'gallery', label: 'Gallery' },
  { id: 'partners', label: 'Sponsors' },
  { id: 'prizes', label: 'Prizes' },
  { id: 'rules', label: 'Rules' },
  { id: 'teams', label: 'Teams' },
  { id: 'scores', label: 'Live scores' },
  { id: 'venue', label: 'Venue & contact' },
  { id: 'register', label: 'Register' }
];

/**
 * Fragments of the former tabbed page (and other aliases used by the footer and the home page), mapped to
 * the section that now holds that content. Section ids map to themselves.
 */
export const LEGACY_HASHES: Readonly<Record<string, EventSectionId>> = {
  overview: 'facts',
  categories: 'categories',
  d20: 'categories',
  d40: 'categories',
  rules: 'rules',
  safety: 'rules',
  schedule: 'programme',
  fixtures: 'programme',
  teams: 'teams',
  scoring: 'scores',
  live: 'scores',
  partners: 'partners',
  sponsors: 'partners',
  contact: 'venue'
};

/** Resolved target of a URL fragment: the section, and the element to scroll to (a class card for #d20 / #d40). */
export interface HashTarget {
  section: EventSectionId;
  elementId: string;
}

/** Map a URL fragment (with or without `#`, any case) to its section; `null` for unknown fragments. */
export function sectionFromHash(hash: string): HashTarget | null {
  const key = hash.replace(/^#/, '').trim().toLowerCase();
  if (!key) return null;
  if (key === 'd20' || key === 'd40') return { section: 'categories', elementId: key };
  const direct = EVENT_SECTIONS.find((s) => s.id === key);
  if (direct) return { section: direct.id, elementId: direct.id };
  const legacy = LEGACY_HASHES[key];
  return legacy ? { section: legacy, elementId: legacy } : null;
}

/* ------------------------------------------------------------------ */
/* Event details (GET /events/:slug)                                   */
/* ------------------------------------------------------------------ */

export interface EventCategoryInfo {
  slug: string;
  name: string;
  /** GST-inclusive entry fee, or `null` when the API does not state a positive fee. */
  entryFee: number | null;
  currency: string;
  isActive: boolean;
}

export interface EventDetails {
  title: string | null;
  /** Start and end instants from the API (ISO strings), or `null` when missing or invalid. */
  startsAt: string | null;
  endsAt: string | null;
  /** Venue from the API, or `null` when it is missing or still a placeholder. */
  venueName: string | null;
  venueAddress: string | null;
  categories: EventCategoryInfo[];
}

const PLACEHOLDER_TEXT = /^(needs input|tbd|tba|to be (announced|confirmed|decided)|n\/?a|none|null|undefined|-+|\?+)$/i;

/** Whether a value is a real fact rather than an empty or placeholder string such as "Needs input". */
export function isKnownText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !PLACEHOLDER_TEXT.test(value.trim());
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Normalise the `GET /events/:slug` response; anything missing or malformed becomes empty / `null`. */
export function normaliseEventDetails(raw: unknown): EventDetails {
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawCategories = Array.isArray(data.categories) ? data.categories : [];
  const categories: EventCategoryInfo[] = [];
  for (const c of rawCategories) {
    if (!c || typeof c !== 'object') continue;
    const cat = c as Record<string, unknown>;
    const slug = str(cat.slug).toLowerCase();
    if (!slug) continue;
    const fee = typeof cat.entryFee === 'number' ? cat.entryFee : Number(cat.entryFee);
    categories.push({
      slug,
      name: str(cat.name) || slug.toUpperCase(),
      entryFee: Number.isFinite(fee) && fee > 0 ? fee : null,
      currency: str(cat.currency).toUpperCase() || 'INR',
      isActive: cat.isActive !== false
    });
  }
  const instant = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
  const startsAt = instant(data.startDate);
  const endsAt = instant(data.endDate);
  const ordered = startsAt && endsAt && Date.parse(endsAt) > Date.parse(startsAt);
  return {
    title: isKnownText(data.title) ? data.title.trim() : null,
    startsAt: ordered ? startsAt : null,
    endsAt: ordered ? endsAt : null,
    venueName: isKnownText(data.venueName) ? data.venueName.trim() : null,
    venueAddress: isKnownText(data.venueAddress) ? data.venueAddress.trim() : null,
    categories
  };
}

/** The category with a slug, if the API returned it. */
export function findCategory(details: EventDetails | null, slug: 'd20' | 'd40'): EventCategoryInfo | null {
  return details?.categories.find((c) => c.slug === slug) ?? null;
}

/** Entry fee of a class, e.g. "₹1,500", or `null` when unknown (never invented). */
export function feeLabel(details: EventDetails | null, slug: 'd20' | 'd40'): string | null {
  const cat = findCategory(details, slug);
  if (!cat || cat.entryFee === null || cat.currency !== 'INR') return null;
  return formatInr(cat.entryFee);
}

/** Format an instant as an ISO 8601 string in Indian Standard Time, e.g. "2026-12-01T09:00:00+05:30". */
export function toIstIso(value: string | number | Date): string | null {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const ist = new Date(ms + 330 * 60_000).toISOString().slice(0, 19);
  return `${ist}+05:30`;
}

/**
 * Start and end of the championship: the API event dates when available (the countdown target), otherwise
 * the fallbacks in lib/championship.ts (1 December 2026, 09:00 IST to 2 December 2026, 18:00 IST).
 */
export function eventWindow(details: EventDetails | null): { startsAt: string; endsAt: string } {
  if (details?.startsAt && details.endsAt) {
    return { startsAt: toIstIso(details.startsAt) ?? CHAMPIONSHIP_START_FALLBACK, endsAt: toIstIso(details.endsAt) ?? CHAMPIONSHIP_END_FALLBACK };
  }
  return { startsAt: CHAMPIONSHIP_START_FALLBACK, endsAt: CHAMPIONSHIP_END_FALLBACK };
}

export type RegistrationStatus = 'open' | 'closed' | 'unknown';

/** Registration is open while at least one category is active; unknown when the API returned none. */
export function registrationStatus(details: EventDetails | null): RegistrationStatus {
  if (!details || details.categories.length === 0) return 'unknown';
  return details.categories.some((c) => c.isActive) ? 'open' : 'closed';
}

/**
 * Venue line: the API venue when it is a real value; otherwise the host university with its city when the
 * site information states it (for example "Galgotias University, Greater Noida"); otherwise `null`.
 */
export function venueLabel(details: EventDetails | null, siteInfo: Pick<SiteInfo, 'universityName' | 'addressLines'>): string | null {
  if (details?.venueName) return details.venueName;
  const university = str(siteInfo.universityName);
  if (!university) return null;
  const mentionsUniversity = siteInfo.addressLines.some((l) => l.toLowerCase().includes(university.toLowerCase()));
  if (!mentionsUniversity) return null;
  const city = siteInfo.addressLines.map((l) => /\bGreater Noida\b/i.exec(l)?.[0]).find(Boolean);
  return city ? `${university}, ${city}` : university;
}

/* ------------------------------------------------------------------ */
/* How to take part (the Team Portal flow)                            */
/* ------------------------------------------------------------------ */

export const TAKE_PART_STEPS: readonly { title: string; detail: string }[] = [
  { title: 'Create an account', detail: 'Sign up in the Team Portal as the team captain.' },
  { title: 'Verify your email', detail: 'Enter the 6-digit code sent to your email address.' },
  { title: 'Add team members', detail: 'Build the roster of players and coaches.' },
  { title: 'Submit registration', detail: 'Choose the Class 20 (D20) or Class 40 (D40) category and submit.' },
  { title: 'Pay the entry fee', detail: 'Pay the GST-inclusive entry fee online from the portal.' },
  { title: 'Document review', detail: 'The organising committee reviews the documents you upload.' },
  { title: 'Technical inspection', detail: 'Drone balls are measured, weighed and checked on Day 1.' },
  { title: 'Compete', detail: 'Take to the arena for the group stage and knockouts.' }
];

/* ------------------------------------------------------------------ */
/* Structured data                                                     */
/* ------------------------------------------------------------------ */

export interface EventJsonLdInput {
  details: EventDetails | null;
  siteInfo: Pick<SiteInfo, 'organisationName' | 'universityName' | 'addressLines' | 'email'>;
  /** Absolute site origin without a trailing slash, e.g. "https://www.gcdis.in". */
  siteUrl: string;
  path?: string;
}

/** schema.org SportsEvent for the championship. Offers list only the fees the API states. */
export function buildEventJsonLd({ details, siteInfo, siteUrl, path = CHAMPIONSHIP_PATH }: EventJsonLdInput): Record<string, unknown> {
  const url = `${siteUrl}${path}`;
  const venue = venueLabel(details, siteInfo);
  const address = details?.venueAddress ?? (siteInfo.addressLines.length > 0 ? siteInfo.addressLines.join(', ') : null);
  const status = registrationStatus(details);
  const { startsAt, endsAt } = eventWindow(details);

  const offers = (['d20', 'd40'] as const)
    .map((slug) => findCategory(details, slug))
    .filter((c): c is EventCategoryInfo => Boolean(c && c.entryFee !== null))
    .map((c) => ({
      '@type': 'Offer',
      name: `${c.name} entry fee (GST-inclusive)`,
      price: c.entryFee,
      priceCurrency: c.currency,
      url: `${siteUrl}/portal`,
      ...(status !== 'unknown' ? { availability: c.isActive ? 'https://schema.org/InStock' : 'https://schema.org/SoldOut' } : {})
    }));

  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: CHAMPIONSHIP_NAME,
    description:
      'National drone soccer championship in two categories, Class 20 (D20) and Class 40 (D40), conducted under the FIDA Dronesoccer Regulations.',
    sport: 'Drone soccer',
    startDate: startsAt,
    endDate: endsAt,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    url,
    image: [`${siteUrl}/images/gcdis-drone-lab.jpg`],
    organizer: {
      '@type': 'Organization',
      name: siteInfo.organisationName,
      url: siteUrl,
      ...(siteInfo.email ? { email: siteInfo.email } : {})
    }
  };
  if (venue) {
    ld.location = {
      '@type': 'Place',
      name: venue,
      ...(address ? { address: { '@type': 'PostalAddress', streetAddress: address, addressCountry: 'IN' } } : {})
    };
  }
  if (offers.length > 0) ld.offers = offers;
  return ld;
}

/** JSON for an inline `application/ld+json` block, escaped so it can never close the script element. */
export function serialiseJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
}

import { z } from 'zod';
import { sanitizePlainText } from '../../common/utils/cms-sanitizer.util';
import { HOME_ICON_KEYS, HomeSectionKey, NEWS_CATEGORIES, SERVICE_TONES } from '../home-content.defaults';
import { UPLOAD_PATH_PATTERN, isHttpsUrl } from './site-content.dto';

/**
 * Strict content schemas for the home page sections (one per section key).
 * - Unknown keys are rejected (`.strict()`), so only whitelisted fields are ever stored.
 * - Every text field is plain text: markup is stripped by sanitizePlainText and lengths are capped.
 * - Links are same-site paths (`/portal`), in-page anchors (`#about`) or absolute https URLs.
 * - Images must be uploaded files (/api/uploads/files/...); the service also checks that each one is a
 *   public SITE_IMAGE / GALLERY_IMAGE upload.
 * - Videos (`videoUrl`) must be uploaded files too; the service checks that each one is a public EVENT_VIDEO
 *   upload (MP4 / WebM). External video embeds (YouTube and the like) are never accepted.
 * - Every section (except the text-only ticker and marquee bands) and every entry shown as a card or tile
 *   carries the optional media fields `imageUrl`, `videoUrl` and `imageAlt` (`MEDIA_FIELDS`); all three are
 *   optional, so content saved before they existed stays valid.
 */

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

/** Plain text, trimmed, markup removed, at most `max` characters; `min` 1 makes it required. */
function text(max: number, min = 0) {
  return z
    .string()
    .trim()
    .max(max, `must be at most ${max} characters`)
    .transform((v) => sanitizePlainText(v, max, 'text').trim())
    .refine((v) => v.length >= min, { message: 'must not be empty' });
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const id = z.string().regex(SLUG, 'must be lowercase letters, digits and hyphens (at most 64)');

/** `#anchor`, a same-site path (never protocol-relative) or an https URL. */
const SITE_PATH = /^\/(?![/\\])[^\s"'<>\\`]{0,499}$/;
const ANCHOR = /^#[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export function isSafeHref(v: unknown): boolean {
  return typeof v === 'string' && v.length <= 500 && (ANCHOR.test(v) || SITE_PATH.test(v) || isHttpsUrl(v));
}
const href = z
  .string()
  .trim()
  .max(500)
  .refine(isSafeHref, { message: 'must be a site path (/page), an anchor (#section) or an https URL' });
/** Optional link: empty clears it. */
const optionalHref = z.preprocess(emptyToNull, href.nullable()).optional();

/** Uploaded image path (/api/uploads/files/...) or null. */
const imageRef = z
  .preprocess(emptyToNull, z.string().max(2048).regex(UPLOAD_PATH_PATTERN, 'must be an uploaded image').nullable())
  .optional();

/** Uploaded video path (/api/uploads/files/...) or null; the service checks it is a public EVENT_VIDEO upload. */
const videoRef = z
  .preprocess(emptyToNull, z.string().max(2048).regex(UPLOAD_PATH_PATTERN, 'must be an uploaded video').nullable())
  .optional();

/** Optional image and video of a section or entry; the video plays muted with the image as its poster. */
export const MEDIA_FIELDS = {
  imageUrl: imageRef,
  videoUrl: videoRef,
  /** Description of the image for screen readers; empty = decorative. */
  imageAlt: z.preprocess(emptyToUndefined, text(200).optional())
} as const;

const imagePosition = z
  .string()
  .regex(/^(100|[1-9]?\d)% (100|[1-9]?\d)%$/, 'must be two percentages, for example "50% 60%"');

const isoDate = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'must be a date as YYYY-MM-DD')
    .optional()
);
const isoInstant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/, 'must be a date and time with an offset, for example 2026-12-01T09:00:00+05:30')
  .refine((v) => Number.isFinite(Date.parse(v)), { message: 'must be a valid date and time' });

const placeholder = z.boolean().optional();
const icon = z.enum(HOME_ICON_KEYS);

/** List whose entries carry unique `id`s. */
function idList<T extends z.ZodTypeAny>(item: T, max: number) {
  return z
    .array(item)
    .max(max, `may contain at most ${max} entries`)
    .superRefine((list, ctx) => {
      const seen = new Set<string>();
      list.forEach((entry: any, i) => {
        if (entry && typeof entry.id === 'string') {
          if (seen.has(entry.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'id'], message: 'must be unique' });
          seen.add(entry.id);
        }
      });
    });
}

function textList(max: number, maxItems: number) {
  return z.array(text(max, 1)).max(maxItems, `may contain at most ${maxItems} entries`);
}

const link = z.object({ label: text(60, 1), href }).strict();
const filter = z.object({ id, label: text(30, 1) }).strict();

const video = z
  .object({
    placeholder,
    title: text(120, 1),
    meta: text(60),
    url: optionalHref,
    ...MEDIA_FIELDS
  })
  .strict()
  .nullable();

const testimonial = z
  .object({ id, placeholder, quote: text(1000, 1), name: text(80, 1), role: text(120), ...MEDIA_FIELDS })
  .strict();

const footerLink = z.object({ label: text(60, 1), href, highlight: z.boolean().optional() }).strict();

export const HOME_SECTION_SCHEMAS: Readonly<Record<HomeSectionKey, z.ZodTypeAny>> = Object.freeze({
  hero: z
    .object({
      eyebrow: text(120, 1),
      headlineLead: text(120, 1),
      headlineHighlight: text(60, 1),
      keywords: textList(30, 5),
      primaryCta: link,
      secondaryCta: link,
      // Optional third button (added Oct 2026); older stored content without it stays valid
      tertiaryCta: link.nullable().optional(),
      facts: z
        .array(z.object({ label: text(40, 1), value: text(40, 1), url: optionalHref }).strict())
        .max(3, 'may contain at most 3 entries'),
      // Background: video (muted, looping) with the image as its poster; set under Home Page Hero or here
      ...MEDIA_FIELDS
    })
    .strict(),

  ticker: z.object({ items: textList(200, 12) }).strict(),

  partners: z
    .object({ title: text(80, 1), fallbackTitle: text(120, 1), fallbackBody: text(600), ...MEDIA_FIELDS })
    .strict(),

  about: z
    .object({
      eyebrow: text(60),
      intro: text(1200, 1),
      ...MEDIA_FIELDS,
      video,
      cta: link,
      stats: idList(
        z
          .object({
            id,
            placeholder,
            value: z.number().finite().min(0).max(1_000_000_000_000).nullable(),
            text: z.preprocess(emptyToUndefined, text(40).optional()),
            format: z.enum(['inr', 'plain']).optional(),
            pad: z.boolean().optional(),
            label: text(120, 1),
            ring: z.number().int().min(0).max(100),
            icon
          })
          .strict(),
        12
      )
    })
    .strict(),

  mission: z
    .object({
      tabs: idList(
        z
          .object({
            id,
            label: text(30, 1),
            heading: text(80, 1),
            statement: text(600, 1),
            icon,
            showRoadmap: z.boolean().optional(),
            ...MEDIA_FIELDS,
            points: z.array(z.object({ title: text(100, 1), body: text(600, 1) }).strict()).max(10, 'may contain at most 10 entries')
          })
          .strict(),
        6
      ).refine((tabs) => tabs.length >= 1, { message: 'must contain at least one tab' }),
      roadmap: z
        .object({ placeholder, label: text(60, 1), progress: z.number().int().min(0).max(100) })
        .strict()
        .nullable(),
      ...MEDIA_FIELDS
    })
    .strict(),

  centres: z
    .object({
      eyebrow: text(60),
      heading: text(120, 1),
      ...MEDIA_FIELDS,
      enquiryLabel: text(60, 1),
      filters: idList(filter, 12),
      items: idList(
        z
          .object({
            id,
            placeholder,
            code: text(20),
            title: text(120, 1),
            focus: textList(60, 8),
            category: id,
            ...MEDIA_FIELDS,
            imagePosition
          })
          .strict(),
        24
      )
    })
    .strict(),

  programmes: z
    .object({
      eyebrow: text(60),
      heading: text(120, 1),
      ...MEDIA_FIELDS,
      categories: idList(filter, 12),
      items: idList(
        z
          .object({
            id,
            placeholder,
            title: text(120, 1),
            category: id,
            summary: text(600, 1),
            tags: textList(40, 8),
            ...MEDIA_FIELDS,
            imagePosition,
            details: z
              .object({
                placeholder,
                duration: text(60),
                award: text(80),
                level: text(60),
                syllabus: textList(160, 20),
                syllabusUrl: optionalHref
              })
              .strict()
              .nullable()
          })
          .strict(),
        24
      )
    })
    .strict(),

  marquee: z.object({ items: textList(80, 20) }).strict(),

  mous: z
    .object({
      heading: text(120, 1),
      subheading: text(200),
      ...MEDIA_FIELDS,
      items: idList(
        z
          .object({ id, placeholder, organisation: text(120, 1), year: text(20), summary: text(600), documentUrl: optionalHref, ...MEDIA_FIELDS })
          .strict(),
        24
      )
    })
    .strict(),

  services: z
    .object({
      eyebrow: text(60),
      heading: text(120, 1),
      ...MEDIA_FIELDS,
      items: idList(
        z
          .object({
            id,
            placeholder,
            title: text(80, 1),
            ...MEDIA_FIELDS,
            icon,
            tone: z.enum(SERVICE_TONES),
            bullets: textList(120, 10),
            lead: z.preprocess(emptyToUndefined, text(300).optional()),
            highlights: z
              .object({ placeholder, items: textList(60, 6) })
              .strict()
              .nullable()
              .optional()
          })
          .strict(),
        12
      ),
      enquiry: z.object({ title: text(80, 1), body: text(400) }).strict()
    })
    .strict(),

  news: z
    .object({
      eyebrow: text(60),
      heading: text(120, 1),
      ...MEDIA_FIELDS,
      nextEvent: z
        .object({
          label: text(40, 1),
          title: text(120, 1),
          dates: text(60, 1),
          startsAt: isoInstant,
          endsAt: isoInstant,
          register: link,
          live: link
        })
        .strict()
        .refine((e) => Date.parse(e.endsAt) > Date.parse(e.startsAt), { message: 'endsAt must be after startsAt', path: ['endsAt'] })
        .nullable(),
      filters: idList(z.object({ id: z.enum(NEWS_CATEGORIES), label: text(30, 1) }).strict(), NEWS_CATEGORIES.length),
      items: idList(
        z
          .object({
            id,
            placeholder,
            category: z.enum(NEWS_CATEGORIES),
            title: text(160, 1),
            summary: text(600),
            date: isoDate,
            status: z.preprocess(emptyToUndefined, text(30).optional()),
            href,
            ...MEDIA_FIELDS,
            imagePosition
          })
          .strict(),
        30
      )
    })
    .strict(),

  awards: z
    .object({
      eyebrow: text(60),
      heading: text(120, 1),
      galleryEyebrow: text(60),
      ...MEDIA_FIELDS,
      items: idList(
        z
          .object({ id, placeholder, badge: text(60), title: text(120, 1), detail: text(300), ...MEDIA_FIELDS })
          .strict(),
        4
      )
    })
    .strict(),

  testimonials: z
    .object({
      visitorsHeading: text(80, 1),
      visitors: idList(testimonial, 12),
      storiesHeading: text(80, 1),
      storyVideo: video,
      stories: idList(testimonial, 12),
      ...MEDIA_FIELDS
    })
    .strict(),

  footer: z
    .object({
      subscribeTitle: text(80, 1),
      subscribeBody: text(300),
      subscribeSubject: text(120, 1),
      quickLinksTitle: text(40, 1),
      quickLinks: z.array(footerLink).max(12, 'may contain at most 12 entries'),
      programmeLinksTitle: text(40, 1),
      programmeLinks: z.array(footerLink).max(12, 'may contain at most 12 entries'),
      ...MEDIA_FIELDS
    })
    .strict()
});

/** PATCH /cms/admin/home/sections/:key */
export const UpdateHomeSectionSchema = z
  .object({
    enabled: z.boolean().optional(),
    content: z.record(z.unknown()).optional()
  })
  .strict()
  .refine((b) => b.enabled !== undefined || b.content !== undefined, { message: 'enabled or content is required' });

/** PUT /cms/admin/home/sections/order: the new order of the orderable sections (first = top). */
export const ReorderHomeSectionsSchema = z
  .object({
    keys: z.array(z.string().max(64)).min(1).max(32)
  })
  .strict();

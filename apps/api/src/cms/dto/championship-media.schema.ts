import { z } from 'zod';
import { sanitizePlainText } from '../../common/utils/cms-sanitizer.util';
import { UPLOAD_PATH_PATTERN, isHttpsUrl } from './site-content.dto';
import { isSafeHref } from './home-content.schema';

/**
 * Strict schemas for the championship page media (site setting `championship_media`) and the staff request
 * bodies that change it.
 * - Unknown keys are rejected (`.strict()`), so only whitelisted fields are ever stored.
 * - Captions are plain text: markup is stripped by sanitizePlainText and the length is capped at 160.
 * - Every media URL is an uploaded file (/api/uploads/files/<key>) or an absolute https URL, and also passes
 *   isSafeHref (the home page link check). The service additionally checks that each uploaded path is a public
 *   upload of the right purpose and type (EVENT_VIDEO for the video, SITE_IMAGE / GALLERY_IMAGE for photos).
 */

export const CHAMPIONSHIP_MEDIA_KINDS = ['drone', 'arena', 'event'] as const;
export type ChampionshipMediaKind = (typeof CHAMPIONSHIP_MEDIA_KINDS)[number];

/** At most this many gallery photos (published or not). */
export const CHAMPIONSHIP_GALLERY_MAX = 40;
export const CHAMPIONSHIP_CAPTION_MAX = 160;

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

/** An uploaded file path or an https URL. */
export function isChampionshipMediaUrl(v: unknown): v is string {
  return typeof v === 'string' && (UPLOAD_PATH_PATTERN.test(v) || isHttpsUrl(v)) && isSafeHref(v);
}

const mediaUrl = z
  .string()
  .trim()
  .max(500, 'must be at most 500 characters')
  .refine(isChampionshipMediaUrl, { message: 'must be an uploaded file (/api/uploads/files/...) or an https URL' });

/** Optional media URL in a request: null or '' removes it. */
const optionalMediaUrl = z.preprocess(emptyToNull, mediaUrl.nullable()).optional();

const caption = z
  .string()
  .trim()
  .max(CHAMPIONSHIP_CAPTION_MAX, `must be at most ${CHAMPIONSHIP_CAPTION_MAX} characters`)
  .transform((v) => sanitizePlainText(v, CHAMPIONSHIP_CAPTION_MAX, 'caption').trim());

const kind = z.enum(CHAMPIONSHIP_MEDIA_KINDS, {
  errorMap: () => ({ message: `must be one of: ${CHAMPIONSHIP_MEDIA_KINDS.join(', ')}` })
});

const itemId = z.string().uuid('must be a UUID');

export const ChampionshipGalleryItemSchema = z
  .object({
    id: itemId,
    imageUrl: mediaUrl,
    caption,
    kind,
    published: z.boolean()
  })
  .strict();

function uniqueIds<T extends { id: string }>(list: T[], ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  list.forEach((entry, i) => {
    if (seen.has(entry.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'id'], message: 'must be unique' });
    seen.add(entry.id);
  });
}

// ------------------------------------------------------------------ Section media

/** Page sections that can carry their own image and / or video (ids match the web page's section components). */
export const CHAMPIONSHIP_SECTION_KEYS = [
  'facts',
  'takePart',
  'categories',
  'programme',
  'prizes',
  'rules',
  'teams',
  'scores',
  'venue',
  'finalCta'
] as const;
export type ChampionshipSectionKey = (typeof CHAMPIONSHIP_SECTION_KEYS)[number];

/** Items inside a section that can carry their own media (the D20 / D40 cards, the two programme days...). */
export const CHAMPIONSHIP_SECTION_ITEMS = {
  categories: ['d20', 'd40'],
  programme: ['day1', 'day2'],
  prizes: ['d20', 'd40']
} as const satisfies Partial<Record<ChampionshipSectionKey, readonly string[]>>;
export type ChampionshipSectionWithItems = keyof typeof CHAMPIONSHIP_SECTION_ITEMS;

export const CHAMPIONSHIP_IMAGE_ALT_MAX = 200;

export function isChampionshipSectionKey(v: unknown): v is ChampionshipSectionKey {
  return typeof v === 'string' && (CHAMPIONSHIP_SECTION_KEYS as readonly string[]).includes(v);
}

export function isChampionshipSectionItem(section: unknown, item: unknown): boolean {
  if (!isChampionshipSectionKey(section) || typeof item !== 'string') return false;
  const items = (CHAMPIONSHIP_SECTION_ITEMS as Partial<Record<string, readonly string[]>>)[section];
  return !!items && items.includes(item);
}

/**
 * Section media URLs are stricter than the hero's: site uploads only (/api/uploads/files/<key>), never an
 * external URL, so nothing outside this site is ever embedded in a section. The service additionally checks the
 * upload's purpose, type and visibility.
 */
export function isChampionshipUploadUrl(v: unknown): v is string {
  return typeof v === 'string' && UPLOAD_PATH_PATTERN.test(v) && isSafeHref(v);
}

const uploadUrl = z
  .string()
  .trim()
  .max(500, 'must be at most 500 characters')
  .refine(isChampionshipUploadUrl, { message: 'must be an uploaded file (/api/uploads/files/...)' });

const imageAlt = z
  .string()
  .trim()
  .max(CHAMPIONSHIP_IMAGE_ALT_MAX, `must be at most ${CHAMPIONSHIP_IMAGE_ALT_MAX} characters`)
  .transform((v) => sanitizePlainText(v, CHAMPIONSHIP_IMAGE_ALT_MAX, 'imageAlt').trim());

/** One media slot as stored: an image and / or a video, with the image's alternative text. */
export const ChampionshipSlotMediaSchema = z
  .object({
    imageUrl: uploadUrl.nullable().optional(),
    videoUrl: uploadUrl.nullable().optional(),
    imageAlt: imageAlt.optional()
  })
  .strict();
export type ChampionshipSlotMedia = z.infer<typeof ChampionshipSlotMediaSchema>;

function sectionWithItems<K extends readonly string[]>(items: K) {
  const shape = Object.fromEntries(items.map((k) => [k, ChampionshipSlotMediaSchema.optional()])) as Record<
    K[number],
    z.ZodOptional<typeof ChampionshipSlotMediaSchema>
  >;
  return z
    .object({
      imageUrl: uploadUrl.nullable().optional(),
      videoUrl: uploadUrl.nullable().optional(),
      imageAlt: imageAlt.optional(),
      items: z.object(shape).strict().optional()
    })
    .strict();
}

export const ChampionshipSectionsSchema = z
  .object({
    facts: ChampionshipSlotMediaSchema.optional(),
    takePart: ChampionshipSlotMediaSchema.optional(),
    categories: sectionWithItems(CHAMPIONSHIP_SECTION_ITEMS.categories).optional(),
    programme: sectionWithItems(CHAMPIONSHIP_SECTION_ITEMS.programme).optional(),
    prizes: sectionWithItems(CHAMPIONSHIP_SECTION_ITEMS.prizes).optional(),
    rules: ChampionshipSlotMediaSchema.optional(),
    teams: ChampionshipSlotMediaSchema.optional(),
    scores: ChampionshipSlotMediaSchema.optional(),
    venue: ChampionshipSlotMediaSchema.optional(),
    finalCta: ChampionshipSlotMediaSchema.optional()
  })
  .strict();
export type ChampionshipSections = z.infer<typeof ChampionshipSectionsSchema>;

/**
 * PUT /cms/admin/championship-media/sections/:key (and .../items/:item): sets (or with null / '' removes) the
 * image and / or video, and / or changes the image's alternative text.
 */
export const UpdateChampionshipSectionMediaSchema = z
  .object({
    imageUrl: z.preprocess(emptyToNull, uploadUrl.nullable()).optional(),
    videoUrl: z.preprocess(emptyToNull, uploadUrl.nullable()).optional(),
    imageAlt: imageAlt.optional()
  })
  .strict()
  .refine((b) => b.imageUrl !== undefined || b.videoUrl !== undefined || b.imageAlt !== undefined, {
    message: 'imageUrl, videoUrl or imageAlt is required'
  });

// ------------------------------------------------------------------ Stored value

/** The stored value (also re-validated on every read). `sections` is optional so earlier values stay valid. */
export const ChampionshipMediaSchema = z
  .object({
    heroVideoUrl: mediaUrl.nullable(),
    heroPosterUrl: mediaUrl.nullable(),
    gallery: z
      .array(ChampionshipGalleryItemSchema)
      .max(CHAMPIONSHIP_GALLERY_MAX, `may contain at most ${CHAMPIONSHIP_GALLERY_MAX} photos`)
      .superRefine(uniqueIds),
    sections: ChampionshipSectionsSchema.optional()
  })
  .strict();

export type ChampionshipMedia = z.infer<typeof ChampionshipMediaSchema>;
export type ChampionshipGalleryItem = z.infer<typeof ChampionshipGalleryItemSchema>;

/** PUT /cms/admin/championship-media/hero: sets (or with null / '' removes) the video and / or the poster. */
export const UpdateChampionshipHeroSchema = z
  .object({
    heroVideoUrl: optionalMediaUrl,
    heroPosterUrl: optionalMediaUrl
  })
  .strict()
  .refine((b) => b.heroVideoUrl !== undefined || b.heroPosterUrl !== undefined, {
    message: 'heroVideoUrl or heroPosterUrl is required'
  });

/** POST /cms/admin/championship-media/gallery: one new photo (published unless stated otherwise). */
export const CreateChampionshipGalleryItemSchema = z
  .object({
    imageUrl: mediaUrl,
    caption: caption.optional(),
    kind,
    published: z.boolean().optional()
  })
  .strict();

/** PATCH /cms/admin/championship-media/gallery/:id: caption, kind and / or published (the photo itself is fixed). */
export const UpdateChampionshipGalleryItemSchema = z
  .object({
    caption: caption.optional(),
    kind: kind.optional(),
    published: z.boolean().optional()
  })
  .strict()
  .refine((b) => b.caption !== undefined || b.kind !== undefined || b.published !== undefined, {
    message: 'caption, kind or published is required'
  });

/** PUT /cms/admin/championship-media/gallery/order: listed ids first, the rest keep their relative order. */
export const ReorderChampionshipGallerySchema = z
  .object({
    ids: z
      .array(itemId)
      .min(1, 'must list at least one photo')
      .max(CHAMPIONSHIP_GALLERY_MAX, `may list at most ${CHAMPIONSHIP_GALLERY_MAX} photos`)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'must not list a photo twice' })
  })
  .strict();

export function emptyChampionshipMedia(): ChampionshipMedia {
  return { heroVideoUrl: null, heroPosterUrl: null, gallery: [] };
}

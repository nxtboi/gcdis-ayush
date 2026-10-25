import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { stepUpRequiredException } from '../auth/step-up.guard';
import { parseBody } from '../common/utils/validate-body.util';
import { VIDEO_MIME_TYPES, videoUploadMaxBytes } from '../uploads/uploads.service';
import { ContentActor, SiteContentService } from './site-content.service';
import { CHAMPIONSHIP_MEDIA_SETTING_KEY } from './site-content.defaults';
import { UPLOAD_PATH_PATTERN } from './dto/site-content.dto';
import {
  CHAMPIONSHIP_CAPTION_MAX,
  CHAMPIONSHIP_GALLERY_MAX,
  CHAMPIONSHIP_IMAGE_ALT_MAX,
  CHAMPIONSHIP_MEDIA_KINDS,
  CHAMPIONSHIP_SECTION_ITEMS,
  CHAMPIONSHIP_SECTION_KEYS,
  ChampionshipGalleryItem,
  ChampionshipMedia,
  ChampionshipMediaKind,
  ChampionshipMediaSchema,
  ChampionshipSectionKey,
  ChampionshipSections,
  ChampionshipSlotMedia,
  CreateChampionshipGalleryItemSchema,
  ReorderChampionshipGallerySchema,
  UpdateChampionshipGalleryItemSchema,
  UpdateChampionshipHeroSchema,
  UpdateChampionshipSectionMediaSchema,
  emptyChampionshipMedia,
  isChampionshipSectionItem,
  isChampionshipSectionKey
} from './dto/championship-media.schema';

/** Upload purposes accepted for each kind of championship media. */
const VIDEO_PURPOSES = ['EVENT_VIDEO'];
const PHOTO_PURPOSES = ['SITE_IMAGE', 'GALLERY_IMAGE'];
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

/** One section or item media slot as published: only slots with an image or a video are listed. */
export interface PublicSlotMedia {
  imageUrl: string | null;
  videoUrl: string | null;
  imageAlt: string;
}

/** Section media as published: `{ [section]: slot & { items?: { [item]: slot } } }`, empty sections left out. */
export type PublicChampionshipSections = Partial<
  Record<ChampionshipSectionKey, Partial<PublicSlotMedia> & { items?: Record<string, PublicSlotMedia> }>
>;

/** Public contract of GET /cms/public/championship-media (consumed by apps/web). */
export interface PublicChampionshipMedia {
  heroVideoUrl: string | null;
  heroPosterUrl: string | null;
  gallery: Array<{ id: string; imageUrl: string; caption: string; kind: ChampionshipMediaKind }>;
  sections: PublicChampionshipSections;
}

/** Staff view: every gallery photo (published or not) plus the limits the console checks before uploading. */
export interface AdminChampionshipMedia extends ChampionshipMedia {
  sections: ChampionshipSections;
  limits: {
    galleryMax: number;
    captionMax: number;
    videoMaxBytes: number;
    videoTypes: string[];
    kinds: readonly string[];
    sectionKeys: readonly string[];
    sectionItems: Record<string, readonly string[]>;
    imageAltMax: number;
  };
  updatedAt: Date | null;
  updatedBy: string | null;
}

/**
 * Championship page media: hero background video, poster image and the photo gallery of the team's drones and
 * the arena, stored as one strictly validated JSON site setting (`championship_media`). Admin writes follow the
 * site-content rules: an audit entry for every write, uploaded files must be public uploads of the right purpose
 * and type, and replaced or removed upload files are deleted once nothing references them
 * (SiteContentService.removeFileIfUnreferenced). Replacing or removing the video or poster and deleting a photo
 * require a recent step-up.
 */
@Injectable()
export class ChampionshipMediaService {
  private readonly logger = new Logger(ChampionshipMediaService.name);
  /** Serialises read-modify-write cycles of the setting within this API instance. */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private siteContent: SiteContentService
  ) {}

  // ================================================================ Reads

  /** Public: hero media and the published photos in staff order; empty defaults when nothing is set. */
  async getPublic(): Promise<PublicChampionshipMedia> {
    const { media } = await this.read();
    return {
      heroVideoUrl: media.heroVideoUrl,
      heroPosterUrl: media.heroPosterUrl,
      gallery: media.gallery
        .filter((item) => item.published)
        .map((item) => ({ id: item.id, imageUrl: item.imageUrl, caption: item.caption, kind: item.kind })),
      sections: publicSections(media.sections)
    };
  }

  async getAdmin(): Promise<AdminChampionshipMedia> {
    const { media, row } = await this.read();
    return this.adminView(media, row);
  }

  // ================================================================ Hero video and poster

  /**
   * Sets the video and / or the poster (null or '' removes one). Setting a value where there was none needs no
   * step-up; replacing or removing an existing one does (`hasStepUp`, from the session).
   */
  async updateHero(rawBody: unknown, actor: ContentActor, hasStepUp: boolean): Promise<AdminChampionshipMedia> {
    const body = parseBody(UpdateChampionshipHeroSchema, rawBody);
    if (body.heroVideoUrl) await this.assertMedia(body.heroVideoUrl, 'video', 'heroVideoUrl');
    if (body.heroPosterUrl) await this.assertMedia(body.heroPosterUrl, 'image', 'heroPosterUrl');

    return this.exclusive(async () => {
      const { media: before } = await this.read();
      const next: ChampionshipMedia = { ...before, gallery: [...before.gallery] };
      if (body.heroVideoUrl !== undefined) next.heroVideoUrl = body.heroVideoUrl;
      if (body.heroPosterUrl !== undefined) next.heroPosterUrl = body.heroPosterUrl;

      const replaced = [
        before.heroVideoUrl && before.heroVideoUrl !== next.heroVideoUrl ? before.heroVideoUrl : null,
        before.heroPosterUrl && before.heroPosterUrl !== next.heroPosterUrl ? before.heroPosterUrl : null
      ].filter((u): u is string => !!u);
      if (replaced.length > 0 && !hasStepUp) throw stepUpRequiredException();

      const saved = await this.write(next, actor);
      await this.audit(
        actor,
        'UPDATE_CHAMPIONSHIP_HERO_MEDIA',
        CHAMPIONSHIP_MEDIA_SETTING_KEY,
        { heroVideoUrl: before.heroVideoUrl, heroPosterUrl: before.heroPosterUrl },
        { heroVideoUrl: next.heroVideoUrl, heroPosterUrl: next.heroPosterUrl }
      );
      await this.cleanup(replaced, next, actor);
      return saved;
    });
  }

  /** Removes the hero video or the poster (the route requires a step-up). */
  async clearHero(field: 'video' | 'poster', actor: ContentActor): Promise<AdminChampionshipMedia> {
    return this.exclusive(async () => {
      const { media: before, row } = await this.read();
      const key = field === 'video' ? 'heroVideoUrl' : 'heroPosterUrl';
      const old = before[key];
      if (!old) return this.adminView(before, row);
      const next: ChampionshipMedia = { ...before, [key]: null };
      const saved = await this.write(next, actor);
      await this.audit(
        actor,
        field === 'video' ? 'REMOVE_CHAMPIONSHIP_HERO_VIDEO' : 'REMOVE_CHAMPIONSHIP_HERO_POSTER',
        CHAMPIONSHIP_MEDIA_SETTING_KEY,
        { [key]: old },
        { [key]: null }
      );
      await this.cleanup([old], next, actor);
      return saved;
    });
  }

  // ================================================================ Section and item media

  /**
   * Sets the image and / or video of a section (`item` null) or of an item inside it (null or '' removes one),
   * and / or its alternative text. Setting media where there was none needs no step-up; replacing or removing
   * an existing image or video does (`hasStepUp`, from the session). Replaced files are cleaned up.
   */
  async updateSectionMedia(
    section: string,
    item: string | null,
    rawBody: unknown,
    actor: ContentActor,
    hasStepUp: boolean
  ): Promise<AdminChampionshipMedia> {
    const slotKey = assertSlot(section, item);
    const body = parseBody(UpdateChampionshipSectionMediaSchema, rawBody);
    if (body.videoUrl) await this.assertMedia(body.videoUrl, 'video', 'videoUrl', true);
    if (body.imageUrl) await this.assertMedia(body.imageUrl, 'image', 'imageUrl', true);

    return this.exclusive(async () => {
      const { media: before } = await this.read();
      const old = getSlot(before.sections, slotKey.section, slotKey.item);
      const updated: ChampionshipSlotMedia = { ...old };
      if (body.imageUrl !== undefined) updated.imageUrl = body.imageUrl;
      if (body.videoUrl !== undefined) updated.videoUrl = body.videoUrl;
      if (body.imageAlt !== undefined) updated.imageAlt = body.imageAlt;

      const replaced = [
        old.imageUrl && old.imageUrl !== (updated.imageUrl ?? null) ? old.imageUrl : null,
        old.videoUrl && old.videoUrl !== (updated.videoUrl ?? null) ? old.videoUrl : null
      ].filter((u): u is string => !!u);
      if (replaced.length > 0 && !hasStepUp) throw stepUpRequiredException();

      const next: ChampionshipMedia = { ...before, sections: setSlot(before.sections, slotKey.section, slotKey.item, updated) };
      const saved = await this.write(next, actor);
      await this.audit(actor, 'UPDATE_CHAMPIONSHIP_SECTION_MEDIA', slotId(slotKey), slotState(old), slotState(updated));
      await this.cleanup(replaced, next, actor);
      return saved;
    });
  }

  /** Removes the image or video of a section or item (the route requires a step-up); the file is cleaned up. */
  async clearSectionMedia(section: string, item: string | null, field: string, actor: ContentActor): Promise<AdminChampionshipMedia> {
    const slotKey = assertSlot(section, item);
    if (field !== 'image' && field !== 'video') throw new NotFoundException('Unknown media field (image or video).');
    const key = field === 'image' ? 'imageUrl' : 'videoUrl';
    return this.exclusive(async () => {
      const { media: before, row } = await this.read();
      const old = getSlot(before.sections, slotKey.section, slotKey.item);
      const url = old[key];
      if (!url) return this.adminView(before, row);
      const updated: ChampionshipSlotMedia = { ...old, [key]: null };
      const next: ChampionshipMedia = { ...before, sections: setSlot(before.sections, slotKey.section, slotKey.item, updated) };
      const saved = await this.write(next, actor);
      await this.audit(
        actor,
        field === 'image' ? 'REMOVE_CHAMPIONSHIP_SECTION_IMAGE' : 'REMOVE_CHAMPIONSHIP_SECTION_VIDEO',
        slotId(slotKey),
        { [key]: url },
        { [key]: null }
      );
      await this.cleanup([url], next, actor);
      return saved;
    });
  }

  // ================================================================ Gallery

  async addGalleryItem(rawBody: unknown, actor: ContentActor): Promise<AdminChampionshipMedia> {
    const body = parseBody(CreateChampionshipGalleryItemSchema, rawBody);
    await this.assertMedia(body.imageUrl, 'image', 'imageUrl');
    return this.exclusive(async () => {
      const { media: before } = await this.read();
      if (before.gallery.length >= CHAMPIONSHIP_GALLERY_MAX) {
        throw new BadRequestException(`The championship gallery may contain at most ${CHAMPIONSHIP_GALLERY_MAX} photos.`);
      }
      const item: ChampionshipGalleryItem = {
        id: crypto.randomUUID(),
        imageUrl: body.imageUrl,
        caption: body.caption ?? '',
        kind: body.kind,
        published: body.published ?? true
      };
      const saved = await this.write({ ...before, gallery: [...before.gallery, item] }, actor);
      await this.audit(actor, 'CREATE_CHAMPIONSHIP_GALLERY_ITEM', item.id, null, item);
      return saved;
    });
  }

  async updateGalleryItem(id: string, rawBody: unknown, actor: ContentActor): Promise<AdminChampionshipMedia> {
    const body = parseBody(UpdateChampionshipGalleryItemSchema, rawBody);
    return this.exclusive(async () => {
      const { media: before } = await this.read();
      const existing = before.gallery.find((item) => item.id === id);
      if (!existing) throw new NotFoundException('Gallery photo not found');
      const updated: ChampionshipGalleryItem = {
        ...existing,
        ...(body.caption !== undefined ? { caption: body.caption } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.published !== undefined ? { published: body.published } : {})
      };
      const saved = await this.write({ ...before, gallery: before.gallery.map((item) => (item.id === id ? updated : item)) }, actor);
      await this.audit(actor, 'UPDATE_CHAMPIONSHIP_GALLERY_ITEM', id, existing, updated);
      return saved;
    });
  }

  async reorderGallery(rawBody: unknown, actor: ContentActor): Promise<AdminChampionshipMedia> {
    const { ids } = parseBody(ReorderChampionshipGallerySchema, rawBody);
    return this.exclusive(async () => {
      const { media: before } = await this.read();
      const known = new Set(before.gallery.map((item) => item.id));
      const unknown = ids.filter((id) => !known.has(id));
      if (unknown.length > 0) throw new BadRequestException(`Unknown gallery photo id(s): ${unknown.slice(0, 5).join(', ')}`);
      const byId = new Map(before.gallery.map((item) => [item.id, item]));
      const listed = new Set(ids);
      const gallery = [...ids.map((id) => byId.get(id)!), ...before.gallery.filter((item) => !listed.has(item.id))];
      const saved = await this.write({ ...before, gallery }, actor);
      await this.audit(
        actor,
        'REORDER_CHAMPIONSHIP_GALLERY',
        CHAMPIONSHIP_MEDIA_SETTING_KEY,
        before.gallery.map((item) => item.id),
        gallery.map((item) => item.id)
      );
      return saved;
    });
  }

  /** Deletes a photo (the route requires a step-up); its file is removed when nothing else uses it. */
  async deleteGalleryItem(id: string, actor: ContentActor): Promise<AdminChampionshipMedia & { fileDeleted: boolean }> {
    return this.exclusive(async () => {
      const { media: before } = await this.read();
      const existing = before.gallery.find((item) => item.id === id);
      if (!existing) throw new NotFoundException('Gallery photo not found');
      const next: ChampionshipMedia = { ...before, gallery: before.gallery.filter((item) => item.id !== id) };
      const saved = await this.write(next, actor);
      await this.audit(actor, 'DELETE_CHAMPIONSHIP_GALLERY_ITEM', id, existing, null);
      const fileDeleted = (await this.cleanup([existing.imageUrl], next, actor)) > 0;
      return { ...saved, fileDeleted };
    });
  }

  // ================================================================ Helpers

  private async read(): Promise<{ media: ChampionshipMedia; row: any | null }> {
    const row = await this.prisma.siteSetting.findUnique({ where: { key: CHAMPIONSHIP_MEDIA_SETTING_KEY } });
    if (!row || row.value === null || row.value === undefined) return { media: emptyChampionshipMedia(), row: row ?? null };
    // Stored content is re-validated on read; anything that no longer fits the schema falls back to the empty defaults
    const parsed = ChampionshipMediaSchema.safeParse(row.value);
    if (!parsed.success) {
      this.logger.warn(`Stored setting '${CHAMPIONSHIP_MEDIA_SETTING_KEY}' is invalid; the empty defaults are used.`);
      return { media: emptyChampionshipMedia(), row };
    }
    return { media: parsed.data, row };
  }

  private async write(media: ChampionshipMedia, actor: ContentActor): Promise<AdminChampionshipMedia> {
    // Never store anything the schema would not accept back
    const value = parseBody(ChampionshipMediaSchema, media);
    const updatedBy = actor.email ?? actor.id ?? null;
    const row = await this.prisma.siteSetting.upsert({
      where: { key: CHAMPIONSHIP_MEDIA_SETTING_KEY },
      update: { value: value as any, updatedBy },
      create: {
        key: CHAMPIONSHIP_MEDIA_SETTING_KEY,
        value: value as any,
        description: 'Championship page hero video, poster and photo gallery',
        updatedBy
      }
    });
    return this.adminView(value, row);
  }

  private adminView(media: ChampionshipMedia, row: any | null): AdminChampionshipMedia {
    return {
      heroVideoUrl: media.heroVideoUrl,
      heroPosterUrl: media.heroPosterUrl,
      gallery: media.gallery.map((item) => ({ ...item })),
      sections: JSON.parse(JSON.stringify(media.sections ?? {})),
      limits: {
        galleryMax: CHAMPIONSHIP_GALLERY_MAX,
        captionMax: CHAMPIONSHIP_CAPTION_MAX,
        videoMaxBytes: videoUploadMaxBytes(),
        videoTypes: [...VIDEO_MIME_TYPES],
        kinds: CHAMPIONSHIP_MEDIA_KINDS,
        sectionKeys: CHAMPIONSHIP_SECTION_KEYS,
        sectionItems: CHAMPIONSHIP_SECTION_ITEMS,
        imageAltMax: CHAMPIONSHIP_IMAGE_ALT_MAX
      },
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null
    };
  }

  /**
   * Uploaded paths must belong to a public upload of the right purpose and type: EVENT_VIDEO (MP4 / WebM) for the
   * video, SITE_IMAGE or GALLERY_IMAGE (JPEG / PNG / WebP) for the poster and gallery photos. https URLs pass.
   */
  private async assertMedia(url: string, type: 'video' | 'image', field: string, uploadsOnly = false): Promise<void> {
    // Section media (`uploadsOnly`) must be a site upload: the schema already limits it, this checks it again
    if (!UPLOAD_PATH_PATTERN.test(url)) {
      if (uploadsOnly) throw new BadRequestException(`${field} must be an uploaded file (/api/uploads/files/...).`);
      return;
    }
    const purposes = type === 'video' ? VIDEO_PURPOSES : PHOTO_PURPOSES;
    const mimes = type === 'video' ? VIDEO_MIME_TYPES : IMAGE_MIMES;
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { fileUrl: url, isPublic: true, purpose: { in: purposes }, mimeType: { in: mimes } },
      select: { id: true }
    });
    if (!asset) {
      throw new BadRequestException(
        type === 'video'
          ? `${field} must reference an uploaded video (EVENT_VIDEO, MP4 or WebM).`
          : `${field} must reference an uploaded image (SITE_IMAGE or GALLERY_IMAGE).`
      );
    }
  }

  /** Deletes replaced / removed upload files that the new value no longer uses (when unused elsewhere). */
  private async cleanup(urls: string[], next: ChampionshipMedia, actor: ContentActor): Promise<number> {
    const stillUsed = new Set<string>([
      ...(next.heroVideoUrl ? [next.heroVideoUrl] : []),
      ...(next.heroPosterUrl ? [next.heroPosterUrl] : []),
      ...next.gallery.map((item) => item.imageUrl),
      ...sectionUrls(next.sections)
    ]);
    let removed = 0;
    for (const url of new Set(urls)) {
      if (stillUsed.has(url) || !UPLOAD_PATH_PATTERN.test(url)) continue;
      if (await this.siteContent.removeFileIfUnreferenced(url, actor)) removed++;
    }
    return removed;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async audit(actor: ContentActor, action: string, entityId: string | undefined, beforeState: unknown, afterState: unknown) {
    await this.auditService.logAction({
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      action,
      entityType: 'ChampionshipMedia',
      entityId,
      beforeState: beforeState ?? undefined,
      afterState: afterState ?? undefined,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    });
  }
}

// ================================================================ Section media helpers

interface SlotKey {
  section: ChampionshipSectionKey;
  item: string | null;
}

type StoredSection = ChampionshipSlotMedia & { items?: Record<string, ChampionshipSlotMedia | undefined> };

/** Validates the route's section (and item) against the whitelists; anything else is a 404. */
function assertSlot(section: string, item: string | null): SlotKey {
  if (!isChampionshipSectionKey(section)) throw new NotFoundException('Unknown championship page section.');
  if (item !== null && !isChampionshipSectionItem(section, item)) throw new NotFoundException('Unknown item for this section.');
  return { section, item };
}

function slotId(key: SlotKey): string {
  return `section:${key.section}${key.item ? `.${key.item}` : ''}`;
}

function slotState(slot: ChampionshipSlotMedia) {
  return { imageUrl: slot.imageUrl ?? null, videoUrl: slot.videoUrl ?? null, imageAlt: slot.imageAlt ?? '' };
}

function getSlot(sections: ChampionshipSections | undefined, section: ChampionshipSectionKey, item: string | null): ChampionshipSlotMedia {
  const entry = (sections?.[section] ?? {}) as StoredSection;
  const slot = item === null ? entry : entry.items?.[item];
  return { imageUrl: slot?.imageUrl ?? null, videoUrl: slot?.videoUrl ?? null, imageAlt: slot?.imageAlt ?? '' };
}

/** A slot is stored only while it has an image, a video or alternative text. */
function compactSlot(slot: ChampionshipSlotMedia): ChampionshipSlotMedia | undefined {
  const out: ChampionshipSlotMedia = {};
  if (slot.imageUrl) out.imageUrl = slot.imageUrl;
  if (slot.videoUrl) out.videoUrl = slot.videoUrl;
  if (slot.imageAlt) out.imageAlt = slot.imageAlt;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Returns a new sections map with one slot replaced; empty slots, item maps and sections are dropped. */
function setSlot(
  sections: ChampionshipSections | undefined,
  section: ChampionshipSectionKey,
  item: string | null,
  slot: ChampionshipSlotMedia
): ChampionshipSections {
  const all = JSON.parse(JSON.stringify(sections ?? {})) as Record<string, StoredSection>;
  const entry: StoredSection = { ...(all[section] ?? {}) };
  const compact = compactSlot(slot);
  if (item === null) {
    delete entry.imageUrl;
    delete entry.videoUrl;
    delete entry.imageAlt;
    Object.assign(entry, compact ?? {});
  } else {
    const items: Record<string, ChampionshipSlotMedia | undefined> = { ...(entry.items ?? {}) };
    if (compact) items[item] = compact;
    else delete items[item];
    if (Object.keys(items).length > 0) entry.items = items;
    else delete entry.items;
  }
  if (Object.keys(entry).length > 0) all[section] = entry;
  else delete all[section];
  return all as ChampionshipSections;
}

/** Every upload URL used by section or item media (so cleanup never deletes a file the page still shows). */
export function sectionUrls(sections: ChampionshipSections | undefined): string[] {
  const urls: string[] = [];
  const add = (slot: ChampionshipSlotMedia | undefined) => {
    if (slot?.imageUrl) urls.push(slot.imageUrl);
    if (slot?.videoUrl) urls.push(slot.videoUrl);
  };
  for (const key of CHAMPIONSHIP_SECTION_KEYS) {
    const entry = sections?.[key] as StoredSection | undefined;
    add(entry);
    for (const slot of Object.values(entry?.items ?? {})) add(slot);
  }
  return urls;
}

function publicSlot(slot: ChampionshipSlotMedia | undefined): PublicSlotMedia | null {
  if (!slot || (!slot.imageUrl && !slot.videoUrl)) return null;
  return { imageUrl: slot.imageUrl ?? null, videoUrl: slot.videoUrl ?? null, imageAlt: slot.imageAlt ?? '' };
}

/** Public section media: only slots with an image or a video, in whitelisted sections and items. */
function publicSections(sections: ChampionshipSections | undefined): PublicChampionshipSections {
  const out: PublicChampionshipSections = {};
  for (const key of CHAMPIONSHIP_SECTION_KEYS) {
    const entry = sections?.[key] as StoredSection | undefined;
    if (!entry) continue;
    const own = publicSlot(entry);
    const items: Record<string, PublicSlotMedia> = {};
    const allowed = (CHAMPIONSHIP_SECTION_ITEMS as Partial<Record<string, readonly string[]>>)[key] ?? [];
    for (const itemKey of allowed) {
      const slot = publicSlot(entry.items?.[itemKey]);
      if (slot) items[itemKey] = slot;
    }
    if (!own && Object.keys(items).length === 0) continue;
    out[key] = { ...(own ?? {}), ...(Object.keys(items).length > 0 ? { items } : {}) };
  }
  return out;
}

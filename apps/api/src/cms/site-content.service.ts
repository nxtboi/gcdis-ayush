import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { UploadsService, UPLOAD_FILE_URL_PREFIX } from '../uploads/uploads.service';
import { sanitizePlainText } from '../common/utils/cms-sanitizer.util';
import {
  CHAMPIONSHIP_MEDIA_SETTING_KEY,
  GallerySection,
  MAIN_EVENT_SLUG,
  SITE_SETTING_KEYS,
  SPONSOR_PLACEMENTS,
  SPONSOR_TIERS,
  SiteInfo,
  SponsorsSection,
  defaultGallerySection,
  defaultSiteInfo,
  defaultSponsorsSection
} from './site-content.defaults';
import {
  CreateGalleryImageDto,
  CreateSponsorDto,
  GallerySectionDto,
  SiteInfoDto,
  SponsorsSectionDto,
  UpdateGalleryImageDto,
  UpdateSponsorDto,
  UPLOAD_PATH_PATTERN
} from './dto/site-content.dto';

/** Who performed an admin write (for the audit log). */
export interface ContentActor {
  id?: string;
  email?: string;
  role?: string;
  ipAddress?: string;
  userAgent?: string;
}

/** Upload purposes accepted for each kind of site image. */
const LOGO_PURPOSES = ['SPONSOR_LOGO', 'SITE_IMAGE', 'GALLERY_IMAGE'];
const GALLERY_PURPOSES = ['GALLERY_IMAGE'];
const SITE_IMAGE_PURPOSES = ['SITE_IMAGE', 'GALLERY_IMAGE'];
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

const TIER_RANK = new Map<string, number>(SPONSOR_TIERS.map((t, i) => [t, i]));

export interface SponsorView {
  id: string;
  name: string;
  tier: string;
  logoUrl: string | null;
  websiteUrl: string | null;
  description: string | null;
  placements: string[];
  isActive: boolean;
  displayOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface GalleryImageView {
  id: string;
  imageUrl: string;
  title: string;
  caption: string | null;
  altText: string;
  category: string | null;
  isPublished: boolean;
  displayOrder: number;
  width: number | null;
  height: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toSponsorView(s: any): SponsorView {
  return {
    id: s.id,
    name: s.name,
    tier: s.tier,
    logoUrl: s.logoUrl ?? null,
    websiteUrl: s.websiteUrl ?? null,
    description: s.description ?? null,
    placements: Array.isArray(s.placements) ? s.placements : [],
    isActive: s.isActive !== false,
    displayOrder: s.displayOrder ?? 0,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt
  };
}

export function toGalleryView(g: any): GalleryImageView {
  return {
    id: g.id,
    imageUrl: g.imageUrl,
    title: g.title,
    caption: g.caption ?? null,
    altText: g.altText,
    category: g.category ?? null,
    isPublished: g.isPublished !== false,
    displayOrder: g.displayOrder ?? 0,
    width: g.width ?? null,
    height: g.height ?? null,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt
  };
}

/** Public ordering: tier rank (TITLE first), then displayOrder, then name. */
export function compareSponsorsForPublic(a: { tier: string; displayOrder: number; name: string }, b: typeof a): number {
  const ra = TIER_RANK.get(a.tier) ?? SPONSOR_TIERS.length;
  const rb = TIER_RANK.get(b.tier) ?? SPONSOR_TIERS.length;
  if (ra !== rb) return ra - rb;
  if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
  return a.name.localeCompare(b.name);
}

function plainOrNull(value: string | null | undefined, max: number, field: string): string | null {
  if (value === null || value === undefined) return null;
  const text = sanitizePlainText(value, max, field).trim();
  return text === '' ? null : text;
}

function plainRequired(value: string, max: number, field: string): string {
  const text = sanitizePlainText(value, max, field).trim();
  if (!text) throw new BadRequestException(`${field} must not be empty`);
  return text;
}

/** True when `needle` is one of the string values anywhere inside a JSON value. */
export function jsonContainsString(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value === needle;
  if (Array.isArray(value)) return value.some((v) => jsonContainsString(v, needle));
  if (value && typeof value === 'object') return Object.values(value).some((v) => jsonContainsString(v, needle));
  return false;
}

@Injectable()
export class SiteContentService {
  private readonly logger = new Logger(SiteContentService.name);
  private mainEventId: string | null = null;

  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private uploadsService: UploadsService
  ) {}

  // ================================================================ Settings

  async getPublicSite(): Promise<{ siteInfo: SiteInfo; sponsorsSection: SponsorsSection; gallerySection: GallerySection }> {
    const rows = await this.prisma.siteSetting.findMany({
      where: { key: { in: Object.values(SITE_SETTING_KEYS) } }
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    return {
      siteInfo: this.normaliseSiteInfo(byKey.get(SITE_SETTING_KEYS.siteInfo)),
      sponsorsSection: this.normaliseSponsorsSection(byKey.get(SITE_SETTING_KEYS.sponsorsSection)),
      gallerySection: this.normaliseGallerySection(byKey.get(SITE_SETTING_KEYS.gallerySection))
    };
  }

  async getSiteInfo(): Promise<SiteInfo> {
    return this.normaliseSiteInfo(await this.readSetting(SITE_SETTING_KEYS.siteInfo));
  }

  async getSponsorsSection(): Promise<SponsorsSection> {
    return this.normaliseSponsorsSection(await this.readSetting(SITE_SETTING_KEYS.sponsorsSection));
  }

  async getGallerySection(): Promise<GallerySection> {
    return this.normaliseGallerySection(await this.readSetting(SITE_SETTING_KEYS.gallerySection));
  }

  async saveSiteInfo(dto: SiteInfoDto, actor: ContentActor): Promise<SiteInfo> {
    const addressLines = (dto.addressLines || [])
      .map((line, i) => plainOrNull(line, 200, `addressLines[${i}]`))
      .filter((line): line is string => !!line);
    const phones = (dto.phones || []).map((p, i) => ({
      display: plainRequired(p.display, 40, `phones[${i}].display`),
      tel: p.tel
    }));
    const social: Record<string, string> = {};
    for (const key of ['linkedin', 'instagram', 'youtube', 'x', 'facebook'] as const) {
      const v = (dto.social as any)?.[key];
      if (typeof v === 'string' && v) social[key] = v;
    }
    if (dto.aboutImageUrl) {
      await this.assertImageRef(dto.aboutImageUrl, SITE_IMAGE_PURPOSES, 'aboutImageUrl');
    }

    const value: SiteInfo = {
      organisationName: plainRequired(dto.organisationName, 160, 'organisationName'),
      shortName: plainRequired(dto.shortName, 40, 'shortName'),
      universityName: plainRequired(dto.universityName, 160, 'universityName'),
      addressLines,
      phones,
      email: dto.email.toLowerCase(),
      mapUrl: dto.mapUrl || null,
      social,
      aboutImageUrl: dto.aboutImageUrl || null,
      aboutImageAlt: plainOrNull(dto.aboutImageAlt, 300, 'aboutImageAlt')
    };
    await this.writeSetting(SITE_SETTING_KEYS.siteInfo, value, 'Public site organisation and contact information', actor);
    return value;
  }

  async saveSponsorsSection(dto: SponsorsSectionDto, actor: ContentActor): Promise<SponsorsSection> {
    const value: SponsorsSection = {
      enabled: dto.enabled,
      title: plainRequired(dto.title, 120, 'title'),
      subtitle: plainOrNull(dto.subtitle ?? '', 300, 'subtitle') ?? '',
      showOn: { home: dto.showOn.home, event: dto.showOn.event, footer: dto.showOn.footer }
    };
    await this.writeSetting(SITE_SETTING_KEYS.sponsorsSection, value, 'Sponsors section display settings', actor);
    return value;
  }

  async saveGallerySection(dto: GallerySectionDto, actor: ContentActor): Promise<GallerySection> {
    const value: GallerySection = {
      enabled: dto.enabled,
      title: plainRequired(dto.title, 120, 'title'),
      subtitle: plainOrNull(dto.subtitle ?? '', 300, 'subtitle') ?? ''
    };
    await this.writeSetting(SITE_SETTING_KEYS.gallerySection, value, 'Gallery section display settings', actor);
    return value;
  }

  private async readSetting(key: string): Promise<unknown> {
    const row = await this.prisma.siteSetting.findUnique({ where: { key } });
    return row?.value;
  }

  private async writeSetting(key: string, value: object, description: string, actor: ContentActor) {
    const before = await this.prisma.siteSetting.findUnique({ where: { key } });
    await this.prisma.siteSetting.upsert({
      where: { key },
      update: { value: value as any, updatedBy: actor.email ?? actor.id ?? null },
      create: { key, value: value as any, description, updatedBy: actor.email ?? actor.id ?? null }
    });
    await this.audit(actor, 'UPDATE_SITE_SETTING', 'SiteSetting', key, before?.value ?? null, value);
  }

  /** Stored values merged over the defaults, so a missing field never breaks the public site. */
  private normaliseSiteInfo(stored: unknown): SiteInfo {
    const base = defaultSiteInfo();
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return base;
    const s = stored as Record<string, any>;
    const str = (v: any, fallback: string) => (typeof v === 'string' && v.trim() ? v : fallback);
    const strOrNull = (v: any) => (typeof v === 'string' && v.trim() ? v : null);
    const social: Record<string, string> = {};
    if (s.social && typeof s.social === 'object') {
      for (const key of ['linkedin', 'instagram', 'youtube', 'x', 'facebook']) {
        if (typeof s.social[key] === 'string' && s.social[key]) social[key] = s.social[key];
      }
    }
    return {
      organisationName: str(s.organisationName, base.organisationName),
      shortName: str(s.shortName, base.shortName),
      universityName: str(s.universityName, base.universityName),
      addressLines: Array.isArray(s.addressLines) ? s.addressLines.filter((l: any) => typeof l === 'string') : base.addressLines,
      phones: Array.isArray(s.phones)
        ? s.phones
            .filter((p: any) => p && typeof p.display === 'string' && typeof p.tel === 'string')
            .map((p: any) => ({ display: p.display, tel: p.tel }))
        : base.phones,
      email: str(s.email, base.email),
      mapUrl: strOrNull(s.mapUrl),
      social,
      aboutImageUrl: strOrNull(s.aboutImageUrl),
      aboutImageAlt: strOrNull(s.aboutImageAlt)
    };
  }

  private normaliseSponsorsSection(stored: unknown): SponsorsSection {
    const base = defaultSponsorsSection();
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return base;
    const s = stored as Record<string, any>;
    const showOn = s.showOn && typeof s.showOn === 'object' ? s.showOn : {};
    return {
      enabled: typeof s.enabled === 'boolean' ? s.enabled : base.enabled,
      title: typeof s.title === 'string' && s.title.trim() ? s.title : base.title,
      subtitle: typeof s.subtitle === 'string' ? s.subtitle : base.subtitle,
      showOn: {
        home: typeof showOn.home === 'boolean' ? showOn.home : base.showOn.home,
        event: typeof showOn.event === 'boolean' ? showOn.event : base.showOn.event,
        footer: typeof showOn.footer === 'boolean' ? showOn.footer : base.showOn.footer
      }
    };
  }

  private normaliseGallerySection(stored: unknown): GallerySection {
    const base = defaultGallerySection();
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return base;
    const s = stored as Record<string, any>;
    return {
      enabled: typeof s.enabled === 'boolean' ? s.enabled : base.enabled,
      title: typeof s.title === 'string' && s.title.trim() ? s.title : base.title,
      subtitle: typeof s.subtitle === 'string' ? s.subtitle : base.subtitle
    };
  }

  // ================================================================ Sponsors

  /** Public: active sponsors only (optionally for one placement), by tier rank then displayOrder. */
  async getPublicSponsors(placement?: string): Promise<SponsorView[]> {
    let where: Prisma.SponsorWhereInput = { isActive: true };
    if (placement !== undefined && placement !== null && placement !== '') {
      const p = String(placement).toUpperCase();
      if (!(SPONSOR_PLACEMENTS as readonly string[]).includes(p)) {
        throw new BadRequestException(`placement must be one of ${SPONSOR_PLACEMENTS.join(', ')}`);
      }
      where = { isActive: true, placements: { has: p } };
    }
    const rows = await this.prisma.sponsor.findMany({ where, take: 500 });
    return rows.map(toSponsorView).sort(compareSponsorsForPublic);
  }

  async listSponsors(): Promise<SponsorView[]> {
    const rows = await this.prisma.sponsor.findMany({
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      take: 500
    });
    return rows.map(toSponsorView);
  }

  async createSponsor(dto: CreateSponsorDto, actor: ContentActor): Promise<SponsorView> {
    const eventId = await this.resolveMainEventId();
    if (dto.logoUrl) await this.assertImageRef(dto.logoUrl, LOGO_PURPOSES, 'logoUrl');

    let displayOrder = dto.displayOrder;
    if (displayOrder === undefined) {
      const last = await this.prisma.sponsor.aggregate({ _max: { displayOrder: true } });
      displayOrder = (last._max.displayOrder ?? -1) + 1;
    }

    const created = await this.prisma.sponsor.create({
      data: {
        eventId,
        name: plainRequired(dto.name, 120, 'name'),
        tier: dto.tier,
        logoUrl: dto.logoUrl || null,
        websiteUrl: dto.websiteUrl || null,
        description: plainOrNull(dto.description, 1000, 'description'),
        placements: this.normalisePlacements(dto.placements),
        isActive: dto.isActive ?? true,
        displayOrder
      }
    });
    const view = toSponsorView(created);
    await this.audit(actor, 'CREATE_SPONSOR', 'Sponsor', created.id, null, view);
    return view;
  }

  async updateSponsor(id: string, dto: UpdateSponsorDto, actor: ContentActor): Promise<SponsorView> {
    const existing = await this.prisma.sponsor.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Sponsor not found');

    const data: Prisma.SponsorUpdateInput = {};
    if (dto.name !== undefined) data.name = plainRequired(dto.name, 120, 'name');
    if (dto.tier !== undefined) data.tier = dto.tier;
    if (dto.logoUrl !== undefined) {
      if (dto.logoUrl) await this.assertImageRef(dto.logoUrl, LOGO_PURPOSES, 'logoUrl');
      data.logoUrl = dto.logoUrl || null;
    }
    if (dto.websiteUrl !== undefined) data.websiteUrl = dto.websiteUrl || null;
    if (dto.description !== undefined) data.description = plainOrNull(dto.description, 1000, 'description');
    if (dto.placements !== undefined) data.placements = this.normalisePlacements(dto.placements);
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.displayOrder !== undefined) data.displayOrder = dto.displayOrder;
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No sponsor fields supplied');
    }

    const updated = await this.prisma.sponsor.update({ where: { id }, data });
    const view = toSponsorView(updated);
    await this.audit(actor, 'UPDATE_SPONSOR', 'Sponsor', id, toSponsorView(existing), view);
    // A replaced or removed logo file is deleted when nothing else uses it any more
    if (existing.logoUrl && existing.logoUrl !== updated.logoUrl) await this.removeFileIfUnreferenced(existing.logoUrl, actor);
    return view;
  }

  async deleteSponsor(id: string, actor: ContentActor): Promise<{ success: true; id: string; fileDeleted: boolean }> {
    const existing = await this.prisma.sponsor.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Sponsor not found');
    await this.prisma.sponsor.delete({ where: { id } });
    await this.audit(actor, 'DELETE_SPONSOR', 'Sponsor', id, toSponsorView(existing), null);
    const fileDeleted = existing.logoUrl ? await this.removeFileIfUnreferenced(existing.logoUrl, actor) : false;
    return { success: true, id, fileDeleted };
  }

  async reorderSponsors(ids: string[], actor: ContentActor): Promise<SponsorView[]> {
    const all = await this.prisma.sponsor.findMany({
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, displayOrder: true }
    });
    const updates = this.computeOrder(all, ids, 'sponsor');
    if (updates.length > 0) {
      await this.prisma.$transaction(
        updates.map((u) => this.prisma.sponsor.update({ where: { id: u.id }, data: { displayOrder: u.displayOrder } }))
      );
    }
    await this.audit(actor, 'REORDER_SPONSORS', 'Sponsor', undefined, all.map((s) => s.id), ids);
    return this.listSponsors();
  }

  private normalisePlacements(placements: string[]): string[] {
    const set = new Set((placements || []).map((p) => String(p).toUpperCase()));
    // Stable canonical order
    return (SPONSOR_PLACEMENTS as readonly string[]).filter((p) => set.has(p));
  }

  private async resolveMainEventId(): Promise<string> {
    if (this.mainEventId) {
      const still = await this.prisma.event.findUnique({ where: { id: this.mainEventId }, select: { id: true } });
      if (still) return this.mainEventId;
      this.mainEventId = null;
    }
    const event = await this.prisma.event.findUnique({ where: { slug: MAIN_EVENT_SLUG }, select: { id: true } });
    if (!event) {
      throw new ConflictException(`The main championship event (${MAIN_EVENT_SLUG}) has not been created yet.`);
    }
    this.mainEventId = event.id;
    return event.id;
  }

  // ================================================================ Gallery

  async getPublicGallery(): Promise<GalleryImageView[]> {
    const rows = await this.prisma.galleryImage.findMany({
      where: { isPublished: true },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      take: 500
    });
    return rows.map(toGalleryView);
  }

  async listGallery(): Promise<GalleryImageView[]> {
    const rows = await this.prisma.galleryImage.findMany({
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      take: 1000
    });
    return rows.map(toGalleryView);
  }

  async createGalleryImage(dto: CreateGalleryImageDto, actor: ContentActor): Promise<GalleryImageView> {
    const asset = await this.assertImageRef(dto.imageUrl, GALLERY_PURPOSES, 'imageUrl');
    const last = await this.prisma.galleryImage.aggregate({ _max: { displayOrder: true } });

    const created = await this.prisma.galleryImage.create({
      data: {
        imageUrl: dto.imageUrl,
        title: plainRequired(dto.title, 150, 'title'),
        altText: plainRequired(dto.altText, 300, 'altText'),
        caption: plainOrNull(dto.caption, 1000, 'caption'),
        category: plainOrNull(dto.category, 60, 'category'),
        isPublished: dto.isPublished ?? true,
        displayOrder: (last._max.displayOrder ?? -1) + 1,
        width: asset?.width ?? null,
        height: asset?.height ?? null,
        uploadedBy: actor.id ?? null,
        mediaAssetId: asset?.id ?? null
      }
    });
    const view = toGalleryView(created);
    await this.audit(actor, 'CREATE_GALLERY_IMAGE', 'GalleryImage', created.id, null, view);
    return view;
  }

  async updateGalleryImage(id: string, dto: UpdateGalleryImageDto, actor: ContentActor): Promise<GalleryImageView> {
    const existing = await this.prisma.galleryImage.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Gallery image not found');

    const data: Prisma.GalleryImageUpdateInput = {};
    let replacedUrl: string | null = null;
    if (dto.imageUrl !== undefined && dto.imageUrl !== existing.imageUrl) {
      const asset = await this.assertImageRef(dto.imageUrl, GALLERY_PURPOSES, 'imageUrl');
      data.imageUrl = dto.imageUrl;
      data.width = asset?.width ?? null;
      data.height = asset?.height ?? null;
      data.mediaAssetId = asset?.id ?? null;
      replacedUrl = existing.imageUrl;
    }
    if (dto.title !== undefined) data.title = plainRequired(dto.title, 150, 'title');
    if (dto.altText !== undefined) data.altText = plainRequired(dto.altText, 300, 'altText');
    if (dto.caption !== undefined) data.caption = plainOrNull(dto.caption, 1000, 'caption');
    if (dto.category !== undefined) data.category = plainOrNull(dto.category, 60, 'category');
    if (dto.isPublished !== undefined) data.isPublished = dto.isPublished;
    if (Object.keys(data).length === 0 && dto.imageUrl === undefined) {
      throw new BadRequestException('No gallery image fields supplied');
    }

    const updated = Object.keys(data).length
      ? await this.prisma.galleryImage.update({ where: { id }, data })
      : existing;
    const view = toGalleryView(updated);
    await this.audit(actor, 'UPDATE_GALLERY_IMAGE', 'GalleryImage', id, toGalleryView(existing), view);

    // The replaced image file is removed when nothing else uses it any more
    if (replacedUrl) await this.removeFileIfUnreferenced(replacedUrl, actor);
    return view;
  }

  async deleteGalleryImage(id: string, actor: ContentActor): Promise<{ success: true; id: string; fileDeleted: boolean }> {
    const existing = await this.prisma.galleryImage.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Gallery image not found');
    await this.prisma.galleryImage.delete({ where: { id } });
    await this.audit(actor, 'DELETE_GALLERY_IMAGE', 'GalleryImage', id, toGalleryView(existing), null);
    const fileDeleted = await this.removeFileIfUnreferenced(existing.imageUrl, actor);
    return { success: true, id, fileDeleted };
  }

  async reorderGallery(ids: string[], actor: ContentActor): Promise<GalleryImageView[]> {
    const all = await this.prisma.galleryImage.findMany({
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, displayOrder: true }
    });
    const updates = this.computeOrder(all, ids, 'gallery image');
    if (updates.length > 0) {
      await this.prisma.$transaction(
        updates.map((u) => this.prisma.galleryImage.update({ where: { id: u.id }, data: { displayOrder: u.displayOrder } }))
      );
    }
    await this.audit(actor, 'REORDER_GALLERY', 'GalleryImage', undefined, all.map((g) => g.id), ids);
    return this.listGallery();
  }

  // ================================================================ Helpers

  /**
   * Listed ids take positions 0..n-1 in the given order; unlisted items keep their relative order after
   * them. Every id must exist. Returns only the rows whose displayOrder changes.
   */
  private computeOrder(
    all: Array<{ id: string; displayOrder: number }>,
    ids: string[],
    label: string
  ): Array<{ id: string; displayOrder: number }> {
    const known = new Set(all.map((r) => r.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new BadRequestException(`Unknown ${label} id(s): ${unknown.slice(0, 5).join(', ')}`);
    }
    const listed = new Set(ids);
    const finalOrder = [...ids, ...all.filter((r) => !listed.has(r.id)).map((r) => r.id)];
    const current = new Map(all.map((r) => [r.id, r.displayOrder]));
    return finalOrder
      .map((id, index) => ({ id, displayOrder: index }))
      .filter((u) => current.get(u.id) !== u.displayOrder);
  }

  /**
   * Uploaded paths must belong to a public image upload with an accepted purpose; https URLs are allowed
   * where the purpose list permits external images (never for gallery images).
   */
  private async assertImageRef(url: string, purposes: string[], field: string) {
    if (UPLOAD_PATH_PATTERN.test(url)) {
      const asset = await this.prisma.mediaAsset.findFirst({
        where: { fileUrl: url, isPublic: true, purpose: { in: purposes }, mimeType: { in: IMAGE_MIMES } },
        select: { id: true, width: true, height: true }
      });
      if (!asset) {
        throw new BadRequestException(`${field} must reference an uploaded image (${purposes.join(' or ')}).`);
      }
      return asset;
    }
    if (purposes === GALLERY_PURPOSES) {
      throw new BadRequestException(`${field} must reference a GALLERY_IMAGE upload.`);
    }
    return null;
  }

  /**
   * Deletes a stored upload when no gallery image, sponsor, site setting (including the championship page media,
   * `championship_media`), content section (including the hero and its published versions), home page section
   * or event banner references its URL any more.
   */
  async removeFileIfUnreferenced(url: string, actor: ContentActor): Promise<boolean> {
    if (!url || !url.startsWith(UPLOAD_FILE_URL_PREFIX) || !UPLOAD_PATH_PATTERN.test(url)) return false;
    try {
      if (await this.isUrlReferenced(url)) return false;
      const removed = await this.uploadsService.deleteStoredFile(url);
      await this.audit(actor, 'DELETE_STORED_FILE', 'MediaAsset', url, null, { fileUrl: url, fileRemoved: removed });
      return removed;
    } catch (err: any) {
      // Never fail the content write because of storage cleanup
      this.logger.warn(`Stored file cleanup failed for ${url}: ${err?.message || err}`);
      return false;
    }
  }

  async isUrlReferenced(url: string): Promise<boolean> {
    const [gallery, sponsor, event] = await Promise.all([
      this.prisma.galleryImage.findFirst({ where: { imageUrl: url }, select: { id: true } }),
      this.prisma.sponsor.findFirst({ where: { logoUrl: url }, select: { id: true } }),
      this.prisma.event.findFirst({ where: { bannerUrl: url }, select: { id: true } })
    ]);
    if (gallery || sponsor || event) return true;

    const rows = await this.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT 1 AS n FROM "site_settings" WHERE strpos("value"::text, ${url}) > 0
      UNION ALL
      SELECT 1 AS n FROM "content_sections" WHERE strpos("data"::text, ${url}) > 0
      UNION ALL
      SELECT 1 AS n FROM "content_versions" WHERE strpos("data"::text, ${url}) > 0
      UNION ALL
      SELECT 1 AS n FROM "home_sections" WHERE strpos("content"::text, ${url}) > 0
      LIMIT 1`;
    if (Array.isArray(rows) && rows.length > 0) return true;

    // Championship page media (hero video, poster, gallery photos): checked explicitly by value as well, so
    // its files stay protected even if the generic site_settings text scan above changes
    const media = await this.prisma.siteSetting.findUnique({
      where: { key: CHAMPIONSHIP_MEDIA_SETTING_KEY },
      select: { value: true }
    });
    return jsonContainsString(media?.value, url);
  }

  private async audit(
    actor: ContentActor,
    action: string,
    entityType: string,
    entityId: string | undefined,
    beforeState: unknown,
    afterState: unknown
  ) {
    await this.auditService.logAction({
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      action,
      entityType,
      entityId,
      beforeState: beforeState ?? undefined,
      afterState: afterState ?? undefined,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    });
  }
}

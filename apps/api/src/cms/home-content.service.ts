import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { parseBody } from '../common/utils/validate-body.util';
import { stepUpRequiredException } from '../auth/step-up.guard';
import { ContentActor, SiteContentService } from './site-content.service';
import {
  ALWAYS_ENABLED_HOME_SECTIONS,
  HOME_SECTION_ANCHORS,
  HOME_SECTION_KEYS,
  HOME_SECTION_LABELS,
  HomeSectionKey,
  ORDERABLE_HOME_SECTIONS,
  PINNED_HOME_SECTIONS,
  defaultHomeSectionContent,
  defaultHomeSortOrder,
  isHomeSectionKey
} from './home-content.defaults';
import { HOME_SECTION_SCHEMAS, ReorderHomeSectionsSchema, UpdateHomeSectionSchema } from './dto/home-content.schema';
import { UPLOAD_PATH_PATTERN } from './dto/site-content.dto';

/** Upload purposes accepted for home page images. */
const HOME_IMAGE_PURPOSES = ['SITE_IMAGE', 'GALLERY_IMAGE'];
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
/** Upload purpose and types accepted for home page videos (as for the championship hero video). */
const HOME_VIDEO_PURPOSES = ['EVENT_VIDEO'];
const VIDEO_MIMES = ['video/mp4', 'video/webm'];

export interface HomeSectionView {
  key: HomeSectionKey;
  label: string;
  /** Element id of the section on the page (navbar / footer anchors), or null. */
  anchor: string | null;
  enabled: boolean;
  sortOrder: number;
  /** Fixed in place (hero, ticker, footer): not part of the reorderable list. */
  pinned: boolean;
  /** False for the hero and the footer, which are always shown. */
  canDisable: boolean;
  content: Record<string, unknown>;
  /** True while the section has never been saved (the defaults are shown). */
  isDefault: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export interface PublicHomeSection {
  key: HomeSectionKey;
  sortOrder: number;
  content: Record<string, unknown>;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Whether sample ("placeholder") entries are published: always outside production; in production only
 * with SHOW_PLACEHOLDER_CONTENT=true (or the web app's NEXT_PUBLIC_SHOW_PLACEHOLDER_CONTENT=true) for a
 * review deployment.
 */
export function showHomePlaceholders(env: Record<string, string | undefined> = process.env): boolean {
  return (
    env.NODE_ENV !== 'production' ||
    env.SHOW_PLACEHOLDER_CONTENT === 'true' ||
    env.NEXT_PUBLIC_SHOW_PLACEHOLDER_CONTENT === 'true'
  );
}

/**
 * Removes sample content: list entries with `placeholder: true` are dropped and single blocks with
 * `placeholder: true` (a video, the roadmap, programme details) become null. Pure; never mutates.
 */
export function stripPlaceholders<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.filter((v) => !(isObj(v) && v.placeholder === true)).map((v) => stripPlaceholders(v)) as unknown as T;
  }
  if (isObj(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isObj(v) && v.placeholder === true ? null : stripPlaceholders(v);
    }
    return out as T;
  }
  return value;
}

/** Every uploaded-file path referenced anywhere in a value. */
export function collectUploadPaths(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    if (UPLOAD_PATH_PATTERN.test(value)) out.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectUploadPaths(v, out));
  } else if (isObj(value)) {
    Object.values(value).forEach((v) => collectUploadPaths(v, out));
  }
  return out;
}

/** Values of every `field` (`imageUrl`, `videoUrl`) in a value. */
export function collectMediaFields(value: unknown, field: 'imageUrl' | 'videoUrl', out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((v) => collectMediaFields(v, field, out));
  } else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === field && typeof v === 'string' && v) out.add(v);
      else collectMediaFields(v, field, out);
    }
  }
  return out;
}

/** Videos used by `before` that `after` no longer uses (replaced or removed): these need a step-up. */
export function removedVideos(before: unknown, after: unknown): string[] {
  const kept = collectMediaFields(after, 'videoUrl');
  return [...collectMediaFields(before, 'videoUrl')].filter((u) => !kept.has(u));
}

/** Page order: hero, ticker, the orderable body by sortOrder, then the footer. */
export function orderHomeSections<T extends { key: HomeSectionKey; sortOrder: number }>(list: T[]): T[] {
  const rank = (s: T) => {
    if (s.key === 'hero') return -2;
    if (s.key === 'ticker') return -1;
    if (s.key === 'footer') return Number.MAX_SAFE_INTEGER;
    return s.sortOrder;
  };
  return [...list].sort((a, b) => rank(a) - rank(b) || HOME_SECTION_KEYS.indexOf(a.key) - HOME_SECTION_KEYS.indexOf(b.key));
}

/**
 * Home page sections (`home_sections` table): enable flag, order and strictly validated JSON content per
 * section. Admin writes follow the site-content rules: audit entry for every write, uploaded images must
 * be public site uploads, and replaced or removed upload files are deleted once nothing references them.
 */
@Injectable()
export class HomeContentService {
  private readonly logger = new Logger(HomeContentService.name);

  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private siteContent: SiteContentService
  ) {}

  // ================================================================ Reads

  /** Public: enabled sections only, in page order; sample entries removed in production. */
  async getPublicHome(): Promise<{ sections: PublicHomeSection[] }> {
    const views = await this.listSections();
    const show = showHomePlaceholders();
    return {
      sections: views
        .filter((s) => s.enabled)
        .map((s) => ({ key: s.key, sortOrder: s.sortOrder, content: show ? s.content : stripPlaceholders(s.content) }))
    };
  }

  /** Admin: every section (defaults for sections never saved), in page order. */
  async listSections(): Promise<HomeSectionView[]> {
    const rows = await this.prisma.homeSection.findMany({ take: 100 });
    const byKey = new Map(rows.filter((r) => isHomeSectionKey(r.key)).map((r) => [r.key as HomeSectionKey, r]));
    return orderHomeSections(HOME_SECTION_KEYS.map((key) => this.toView(key, byKey.get(key))));
  }

  async getSection(key: string): Promise<HomeSectionView> {
    const k = this.assertKey(key);
    const row = await this.prisma.homeSection.findUnique({ where: { key: k } });
    return this.toView(k, row);
  }

  // ================================================================ Writes

  /**
   * `hasStepUp` (from the session): replacing or removing a video that the section already shows needs a recent
   * step-up, like the championship hero video; adding one where there was none does not.
   */
  async updateSection(key: string, rawBody: unknown, actor: ContentActor, hasStepUp = false): Promise<HomeSectionView> {
    const k = this.assertKey(key);
    const body = parseBody(UpdateHomeSectionSchema, rawBody);
    if (body.enabled === false && ALWAYS_ENABLED_HOME_SECTIONS.includes(k)) {
      throw new BadRequestException(`The ${HOME_SECTION_LABELS[k].toLowerCase()} section cannot be hidden.`);
    }

    let content: Record<string, unknown> | undefined;
    if (body.content !== undefined) {
      content = parseBody(HOME_SECTION_SCHEMAS[k], body.content) as Record<string, unknown>;
      await this.assertImages(content);
      await this.assertVideos(content);
    }

    const existing = await this.prisma.homeSection.findUnique({ where: { key: k } });
    const before = this.toView(k, existing);
    if (content !== undefined && !hasStepUp && removedVideos(before.content, content).length > 0) {
      throw stepUpRequiredException();
    }
    const nextContent = content ?? before.content;
    const nextEnabled = body.enabled ?? before.enabled;
    const updatedBy = actor.email ?? actor.id ?? null;

    const saved = await this.prisma.homeSection.upsert({
      where: { key: k },
      update: { enabled: nextEnabled, content: nextContent as any, updatedBy },
      create: { key: k, enabled: nextEnabled, sortOrder: before.sortOrder, content: nextContent as any, updatedBy }
    });
    const view = this.toView(k, saved);
    await this.audit(
      actor,
      content !== undefined ? 'UPDATE_HOME_SECTION' : body.enabled ? 'ENABLE_HOME_SECTION' : 'DISABLE_HOME_SECTION',
      k,
      { enabled: before.enabled, content: before.content },
      { enabled: view.enabled, content: view.content }
    );
    if (content !== undefined) await this.cleanupRemovedUploads(before.content, view.content, actor);
    return view;
  }

  /** Restores a section's default content (its enabled flag and position are kept). */
  async resetSection(key: string, actor: ContentActor): Promise<HomeSectionView> {
    const k = this.assertKey(key);
    const existing = await this.prisma.homeSection.findUnique({ where: { key: k } });
    const before = this.toView(k, existing);
    const content = defaultHomeSectionContent(k);
    const updatedBy = actor.email ?? actor.id ?? null;
    const saved = await this.prisma.homeSection.upsert({
      where: { key: k },
      update: { content: content as any, updatedBy },
      create: { key: k, enabled: before.enabled, sortOrder: before.sortOrder, content: content as any, updatedBy }
    });
    const view = this.toView(k, saved);
    await this.audit(actor, 'RESET_HOME_SECTION', k, { content: before.content }, { content: view.content });
    await this.cleanupRemovedUploads(before.content, view.content, actor);
    return view;
  }

  /**
   * New order of the orderable sections: listed keys first (in the given order), unlisted ones keep their
   * relative order after them. The hero, ticker and footer are fixed and may not be listed.
   */
  async reorderSections(rawBody: unknown, actor: ContentActor): Promise<HomeSectionView[]> {
    const { keys } = parseBody(ReorderHomeSectionsSchema, rawBody);
    const unknown = keys.filter((k) => !isHomeSectionKey(k));
    if (unknown.length > 0) throw new BadRequestException(`Unknown home section(s): ${unknown.slice(0, 5).join(', ')}`);
    const pinned = keys.filter((k) => PINNED_HOME_SECTIONS.includes(k as HomeSectionKey));
    if (pinned.length > 0) throw new BadRequestException(`Fixed sections cannot be reordered: ${pinned.join(', ')}`);
    if (new Set(keys).size !== keys.length) throw new BadRequestException('Each section may be listed only once.');

    const current = (await this.listSections()).filter((s) => !s.pinned);
    const listed = new Set(keys);
    const finalOrder = [...(keys as HomeSectionKey[]), ...current.filter((s) => !listed.has(s.key)).map((s) => s.key)];
    const byKey = new Map(current.map((s) => [s.key, s]));
    const updatedBy = actor.email ?? actor.id ?? null;

    await this.prisma.$transaction(
      finalOrder.map((key, index) => {
        const sortOrder = (index + 2) * 10;
        const view = byKey.get(key)!;
        return this.prisma.homeSection.upsert({
          where: { key },
          update: { sortOrder },
          create: { key, enabled: view.enabled, sortOrder, content: view.content as any, updatedBy }
        });
      })
    );
    await this.audit(actor, 'REORDER_HOME_SECTIONS', undefined, current.map((s) => s.key), finalOrder);
    return this.listSections();
  }

  // ================================================================ Helpers

  private assertKey(key: string): HomeSectionKey {
    if (!isHomeSectionKey(key)) throw new NotFoundException('Home section not found');
    return key;
  }

  private toView(key: HomeSectionKey, row: any | null | undefined): HomeSectionView {
    let content = defaultHomeSectionContent(key);
    if (row && row.content !== undefined) {
      // Stored content is re-validated on read; anything that no longer fits the schema falls back to the defaults
      const parsed = HOME_SECTION_SCHEMAS[key].safeParse(row.content);
      if (parsed.success) content = parsed.data as Record<string, unknown>;
      else this.logger.warn(`Stored content of home section '${key}' is invalid; the defaults are used.`);
    }
    return {
      key,
      label: HOME_SECTION_LABELS[key],
      anchor: HOME_SECTION_ANCHORS[key],
      enabled: ALWAYS_ENABLED_HOME_SECTIONS.includes(key) ? true : row ? row.enabled !== false : true,
      sortOrder: row && Number.isInteger(row.sortOrder) ? row.sortOrder : defaultHomeSortOrder(key),
      pinned: PINNED_HOME_SECTIONS.includes(key),
      canDisable: !ALWAYS_ENABLED_HOME_SECTIONS.includes(key),
      content,
      isDefault: !row,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null
    };
  }

  /** Every `imageUrl` must be a public image upload intended for the site. */
  private async assertImages(content: Record<string, unknown>): Promise<void> {
    const urls = [...collectMediaFields(content, 'imageUrl')];
    if (urls.length === 0) return;
    const assets = await this.prisma.mediaAsset.findMany({
      where: { fileUrl: { in: urls }, isPublic: true, purpose: { in: HOME_IMAGE_PURPOSES }, mimeType: { in: IMAGE_MIMES } },
      select: { fileUrl: true }
    });
    const known = new Set(assets.map((a) => a.fileUrl));
    const missing = urls.filter((u) => !known.has(u));
    if (missing.length > 0) {
      throw new BadRequestException(`Images must be uploaded site images (SITE_IMAGE or GALLERY_IMAGE): ${missing.slice(0, 3).join(', ')}`);
    }
  }

  /** Every `videoUrl` must be a public EVENT_VIDEO upload (MP4 / WebM), checked as for the championship hero video. */
  private async assertVideos(content: Record<string, unknown>): Promise<void> {
    const urls = [...collectMediaFields(content, 'videoUrl')];
    if (urls.length === 0) return;
    const assets = await this.prisma.mediaAsset.findMany({
      where: { fileUrl: { in: urls }, isPublic: true, purpose: { in: HOME_VIDEO_PURPOSES }, mimeType: { in: VIDEO_MIMES } },
      select: { fileUrl: true }
    });
    const known = new Set(assets.map((a) => a.fileUrl));
    const missing = urls.filter((u) => !known.has(u));
    if (missing.length > 0) {
      throw new BadRequestException(`Videos must be uploaded site videos (EVENT_VIDEO, MP4 or WebM): ${missing.slice(0, 3).join(', ')}`);
    }
  }

  /** Deletes upload files that the previous content used and the new content no longer does (when unused elsewhere). */
  private async cleanupRemovedUploads(before: unknown, after: unknown, actor: ContentActor): Promise<void> {
    const kept = collectUploadPaths(after);
    for (const url of collectUploadPaths(before)) {
      if (!kept.has(url)) await this.siteContent.removeFileIfUnreferenced(url, actor);
    }
  }

  private async audit(actor: ContentActor, action: string, entityId: string | undefined, beforeState: unknown, afterState: unknown) {
    await this.auditService.logAction({
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      action,
      entityType: 'HomeSection',
      entityId,
      beforeState: beforeState ?? undefined,
      afterState: afterState ?? undefined,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    });
  }
}

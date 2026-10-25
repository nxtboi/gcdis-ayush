import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  deepSanitizeContent,
  sanitizeRichText,
  sanitizeUrl,
  validateBackgroundSettings,
  sanitizeHeroTextFields,
  BackgroundSettings
} from '../common/utils/cms-sanitizer.util';

/**
 * Content model (no schema change required):
 *  - `ContentSection` row  = the editable WORKING COPY (drafts are written here)
 *  - `ContentVersion` rows = immutable PUBLISHED snapshots; the highest versionNumber is what is live
 * Public reads are served from the latest published snapshot, so saving a draft never changes live content.
 */

export interface HeroBackgroundConfig {
  mediaUrl: string;
  mediaType: 'image' | 'video' | 'color';
  focusX: number; // 0-100
  focusY: number; // 0-100
  zoom: number; // 100-200%
  overlayColor: string; // hex
  overlayOpacity: number; // 0.0 - 1.0
  blurPx: number; // 0-20px
  brightnessPct: number; // 0-200%
  parallaxEnabled: boolean;
  mobileCropFocusY: number; // 0-100
  // Plain-text hero copy (sanitised by sanitizeHeroTextFields; limits in HERO_TEXT_LIMITS)
  headline?: string; // max 200
  description?: string; // max 600
  tagline?: string; // max 120
  announcementTitle?: string; // max 160
  announcementDate?: string; // max 60
  announcementBody?: string; // max 1000
}

@Injectable()
export class CMSService {
  constructor(
    private prisma: PrismaService,
    private auditService: AuditService
  ) {}

  /**
   * Get public published section by key (e.g. 'hero', 'about', 'rules').
   * Served from the latest published ContentVersion snapshot, never from the draft working copy.
   */
  async getPublicSection(key: string) {
    const section: any = await this.prisma.contentSection.findUnique({
      where: { key },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } }
    });
    if (!section || !section.isPublished) {
      throw new NotFoundException(`Section '${key}' not found or not published`);
    }

    const latest = this.latestVersion(section.versions);
    const { versions, ...base } = section;
    if (!latest) {
      // Legacy/seeded section never published through the versioning flow: the row itself is live.
      // (saveSectionDraft snapshots such rows before the first draft overwrites them.)
      return base;
    }

    // Subtitle is not versioned in the schema; only expose it when no unpublished draft is pending
    const hasPendingDraft =
      base.publishedAt && base.updatedAt
        ? new Date(base.updatedAt).getTime() > new Date(base.publishedAt).getTime() + 1000
        : false;

    return {
      ...base,
      title: latest.title,
      data: latest.data,
      subtitle: hasPendingDraft ? null : base.subtitle,
      versionNumber: latest.versionNumber,
      publishedAt: latest.createdAt ?? base.publishedAt
    };
  }

  private latestVersion(versions: any[] | undefined): any | null {
    if (!Array.isArray(versions) || versions.length === 0) return null;
    return versions.reduce((max, v) => (v.versionNumber > max.versionNumber ? v : max), versions[0]);
  }

  /**
   * Get all sections for Admin CMS with draft/published status
   */
  async getAllSections() {
    return this.prisma.contentSection.findMany({
      orderBy: { key: 'asc' },
      include: {
        versions: {
          orderBy: { versionNumber: 'desc' },
          take: 5
        }
      }
    });
  }

  /**
   * Save or Update draft content section with server-side sanitization and background range validation
   */
  async saveSectionDraft(
    key: string,
    data: any,
    title: string,
    subtitle?: string,
    adminUserId?: string,
    adminEmail?: string,
    adminRole?: string
  ) {
    // 1. Sanitize text and rich text fields
    const cleanTitle = sanitizeRichText(title);
    const cleanSubtitle = subtitle ? sanitizeRichText(subtitle) : undefined;
    let cleanData = deepSanitizeContent(data);

    // Hero copy (headline, description, tagline, announcement*) is plain text with length limits
    if (key === 'hero' && cleanData && typeof cleanData === 'object' && !Array.isArray(cleanData)) {
      cleanData = sanitizeHeroTextFields(cleanData);
    }

    // 2. Validate background settings if present
    if (cleanData && typeof cleanData === 'object') {
      if (cleanData.heroBackground) {
        validateBackgroundSettings(cleanData.heroBackground);
      }
      if (cleanData.background) {
        validateBackgroundSettings(cleanData.background);
      }
      if (key === 'hero' && cleanData.focusX !== undefined) {
        validateBackgroundSettings(cleanData as BackgroundSettings);
      }
    }

    const existing: any = await this.prisma.contentSection.findUnique({
      where: { key },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } }
    });

    // A live legacy section with no published snapshot is served from the row itself:
    // snapshot it as version 1 first so the draft below cannot change what the public sees.
    if (existing && existing.isPublished && !this.latestVersion(existing.versions)) {
      await this.prisma.contentVersion.create({
        data: {
          sectionId: existing.id,
          versionNumber: 1,
          title: existing.title,
          data: existing.data as any,
          changeNote: 'Baseline snapshot of live content before first draft',
          publishedBy: 'system'
        }
      });
    }

    // Drafts only touch the working copy; live content comes from ContentVersion snapshots.
    // New sections stay unpublished until publishSection() is called.
    const updated = await this.prisma.contentSection.upsert({
      where: { key },
      update: {
        title: cleanTitle,
        subtitle: cleanSubtitle ?? undefined,
        data: cleanData,
        updatedAt: new Date()
      },
      create: {
        key,
        title: cleanTitle,
        subtitle: cleanSubtitle ?? undefined,
        data: cleanData,
        isPublished: false
      }
    });

    await this.auditService.logAction({
      actorId: adminUserId,
      actorEmail: adminEmail,
      actorRole: adminRole,
      action: 'UPDATE_CONTENT_SECTION_DRAFT',
      entityType: 'ContentSection',
      entityId: key,
      beforeState: existing?.data,
      afterState: cleanData
    });

    return updated;
  }

  /**
   * Publish section and store immutable snapshot in ContentVersion
   */
  async publishSection(
    key: string,
    changeNote?: string,
    adminUserId?: string,
    adminEmail?: string,
    adminRole?: string
  ) {
    const section = await this.prisma.contentSection.findUnique({
      where: { key },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } }
    });
    if (!section) throw new NotFoundException(`Section '${key}' not found`);

    const latest = this.latestVersion((section as any).versions);
    const nextVersionNumber = latest ? latest.versionNumber + 1 : 1;

    // Defence in depth: re-apply the hero plain-text rules to the snapshot that goes live
    const publishData =
      key === 'hero' && section.data && typeof section.data === 'object' && !Array.isArray(section.data)
        ? sanitizeHeroTextFields(section.data as Record<string, any>)
        : section.data;

    const [publishedSection, version] = await this.prisma.$transaction([
      this.prisma.contentSection.update({
        where: { key },
        data: {
          isPublished: true,
          publishedAt: new Date()
        }
      }),
      this.prisma.contentVersion.create({
        data: {
          sectionId: section.id,
          versionNumber: nextVersionNumber,
          title: section.title,
          data: publishData as any,
          changeNote: changeNote || `Published version ${nextVersionNumber}`,
          publishedBy: adminEmail || 'Admin'
        }
      })
    ]);

    await this.auditService.logAction({
      actorId: adminUserId,
      actorEmail: adminEmail,
      actorRole: adminRole,
      action: 'PUBLISH_CONTENT_SECTION',
      entityType: 'ContentSection',
      entityId: key,
      afterState: { versionNumber: nextVersionNumber, data: publishData }
    });

    return { section: publishedSection, version };
  }

  /**
   * Rollback content section to a previous version
   */
  async rollbackSection(
    key: string,
    versionNumber: number,
    adminUserId?: string,
    adminEmail?: string,
    adminRole?: string
  ) {
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      throw new BadRequestException('Version number must be a positive integer');
    }

    const section: any = await this.prisma.contentSection.findUnique({
      where: { key },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } }
    });
    if (!section) throw new NotFoundException(`Section '${key}' not found`);

    const targetVersion = await this.prisma.contentVersion.findUnique({
      where: {
        sectionId_versionNumber: {
          sectionId: section.id,
          versionNumber
        }
      }
    });
    if (!targetVersion) throw new NotFoundException(`Version ${versionNumber} not found`);

    const latest = this.latestVersion(section.versions);
    const nextVersionNumber = latest ? latest.versionNumber + 1 : versionNumber + 1;

    // Restore the working copy AND publish the restored content as a new immutable snapshot,
    // so the rollback takes effect on the live site (history is never rewritten).
    const [updated] = await this.prisma.$transaction([
      this.prisma.contentSection.update({
        where: { key },
        data: {
          title: targetVersion.title,
          data: targetVersion.data as any,
          isPublished: true,
          publishedAt: new Date(),
          updatedAt: new Date()
        }
      }),
      this.prisma.contentVersion.create({
        data: {
          sectionId: section.id,
          versionNumber: nextVersionNumber,
          title: targetVersion.title,
          data: targetVersion.data as any,
          changeNote: `Rollback to version ${versionNumber}`,
          publishedBy: adminEmail || 'Admin'
        }
      })
    ]);

    await this.auditService.logAction({
      actorId: adminUserId,
      actorEmail: adminEmail,
      actorRole: adminRole,
      action: 'ROLLBACK_CONTENT_SECTION',
      entityType: 'ContentSection',
      entityId: key,
      beforeState: section.data,
      afterState: targetVersion.data
    });

    return updated;
  }

  /**
   * Get Section Version History
   */
  async getSectionVersions(key: string) {
    const section = await this.prisma.contentSection.findUnique({ where: { key } });
    if (!section) throw new NotFoundException(`Section '${key}' not found`);

    return this.prisma.contentVersion.findMany({
      where: { sectionId: section.id },
      orderBy: { versionNumber: 'desc' },
      take: 100
    });
  }

  /**
   * Prizes management: source of truth from Database
   */
  async getPrizes() {
    const prizes = await this.prisma.prize.findMany({
      orderBy: [{ category: 'asc' }, { rank: 'asc' }]
    });

    const confirmedTotal = prizes
      .filter((p) => p.isConfirmed)
      .reduce((sum, p) => sum + p.amount, 0);

    const poolSetting = await this.prisma.siteSetting.findUnique({
      where: { key: 'prize_pool_total' }
    });
    const poolTotal = (poolSetting?.value as any)?.amount ?? 100000;
    const unallocated = poolTotal - confirmedTotal;

    return {
      poolTotal,
      confirmedTotal,
      unallocated,
      unallocatedStatus: unallocated > 0 ? 'Needs input' : unallocated < 0 ? 'Over-allocated' : 'Fully allocated',
      prizes
    };
  }

  /**
   * Update prize entry
   */
  async updatePrize(
    id: string,
    data: { amount?: number; title?: string; isConfirmed?: boolean; notes?: string },
    adminUserId?: string,
    adminEmail?: string,
    adminRole?: string
  ) {
    const safeData = this.validatePrizeUpdate(data);

    const existing = await this.prisma.prize.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Prize ${id} not found`);

    const updated = await this.prisma.prize.update({
      where: { id },
      data: safeData
    });

    await this.auditService.logAction({
      actorId: adminUserId,
      actorEmail: adminEmail,
      actorRole: adminRole,
      action: 'UPDATE_PRIZE_ROW',
      entityType: 'Prize',
      entityId: id,
      beforeState: existing,
      afterState: updated
    });

    return updated;
  }

  /**
   * Whitelists and type-checks prize update fields; unknown fields are rejected so arbitrary
   * request bodies never reach Prisma.
   */
  private validatePrizeUpdate(input: any): { amount?: number; title?: string; isConfirmed?: boolean; notes?: string | null } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new BadRequestException('Prize update body must be an object');
    }
    const allowed = new Set(['amount', 'title', 'isConfirmed', 'notes']);
    const unknown = Object.keys(input).filter((k) => !allowed.has(k));
    if (unknown.length > 0) {
      throw new BadRequestException(`Unsupported prize fields: ${unknown.join(', ')}`);
    }

    const out: { amount?: number; title?: string; isConfirmed?: boolean; notes?: string | null } = {};
    if (input.amount !== undefined) {
      if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount < 0 || input.amount > 100_000_000) {
        throw new BadRequestException('amount must be a non-negative number');
      }
      out.amount = input.amount;
    }
    if (input.title !== undefined) {
      if (typeof input.title !== 'string' || input.title.trim().length === 0 || input.title.length > 200) {
        throw new BadRequestException('title must be a non-empty string (max 200 chars)');
      }
      out.title = sanitizeRichText(input.title.trim());
    }
    if (input.isConfirmed !== undefined) {
      if (typeof input.isConfirmed !== 'boolean') {
        throw new BadRequestException('isConfirmed must be a boolean');
      }
      out.isConfirmed = input.isConfirmed;
    }
    if (input.notes !== undefined) {
      if (input.notes !== null && (typeof input.notes !== 'string' || input.notes.length > 2000)) {
        throw new BadRequestException('notes must be a string (max 2000 chars) or null');
      }
      out.notes = input.notes === null ? null : sanitizeRichText(input.notes);
    }
    if (Object.keys(out).length === 0) {
      throw new BadRequestException('No updatable prize fields supplied');
    }
    return out;
  }

  /**
   * Operational readiness checklist before launch
   */
  async getOperationalChecklist() {
    const prizesData = await this.getPrizes();
    const settings = await this.prisma.siteSetting.findMany();
    const settingsMap = new Map(settings.map((s) => [s.key, s.value]));

    const hero = await this.prisma.contentSection.findUnique({ where: { key: 'hero' } });
    const events = await this.prisma.event.findMany({ take: 1 });

    const { unallocated, poolTotal } = prizesData;
    const inr = (amount: number) => `INR ${amount.toLocaleString('en-IN')}`;
    const prizesComplete = unallocated === 0;
    const event = events[0];
    const venueSet = !!event && !!event.venueName && event.venueName !== 'Needs input';
    const keyId = process.env.RAZORPAY_KEY_ID || '';
    const keyPresent = !!keyId && !keyId.includes('REPLACE');
    // Razorpay test keys (rzp_test_...) take no real money, so they do not satisfy the "live keys" item
    const testMode = keyPresent && keyId.startsWith('rzp_test_');
    const gatewayConfigured = keyPresent && !testMode;

    // Every item reports 'Complete' or 'Needs input' together with isComplete, so the console has one vocabulary
    const items = [
      {
        id: 'prizes_remainder',
        title: 'Prize Pool Allocation',
        status: prizesComplete ? 'Complete' : 'Needs input',
        isComplete: prizesComplete,
        detail: prizesComplete
          ? `The full prize pool of ${inr(poolTotal)} has been allocated.`
          : unallocated > 0
            ? `${inr(unallocated)} of the ${inr(poolTotal)} prize pool has not yet been allocated.`
            : `Confirmed prizes exceed the ${inr(poolTotal)} prize pool by ${inr(-unallocated)}.`
      },
      {
        id: 'event_dates_venue',
        title: 'Championship Dates and Venue',
        status: venueSet ? 'Complete' : 'Needs input',
        isComplete: venueSet,
        detail: venueSet ? event.venueName : 'The championship dates and venue have not yet been confirmed.'
      },
      {
        id: 'landing_hero_bg',
        title: 'Home Page Hero Content',
        status: hero ? 'Complete' : 'Needs input',
        isComplete: !!hero,
        detail: hero
          ? 'The home page hero text and background have been configured.'
          : 'The home page hero has not yet been configured.'
      },
      {
        id: 'gateway_credentials',
        title: 'Payment Gateway (Razorpay) Live Keys',
        status: gatewayConfigured ? 'Complete' : 'Needs input',
        isComplete: gatewayConfigured,
        detail: gatewayConfigured
          ? 'Live keys are configured for the collection of entry fees.'
          : testMode
            ? 'Test-mode keys are configured: payments are simulated. Live keys are required before real entry fees can be collected.'
            : 'Live keys are required before entry fees can be collected.'
      }
    ];

    const canGoLive = items.every((i) => i.isComplete);
    return { canGoLive, items };
  }

  /**
   * Media Asset Management with validation (MIME, size, alt text)
   */
  async createMediaAsset(
    file: { fileName: string; fileUrl: string; mimeType: string; sizeBytes: number; altText: string },
    adminUserId?: string,
    adminRole?: string
  ) {
    if (!file || typeof file !== 'object') {
      throw new BadRequestException('Media asset body is required');
    }
    // SVG is excluded: it can carry script and would be served from a first-party origin
    const allowedMime = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'];
    if (typeof file.mimeType !== 'string' || !allowedMime.includes(file.mimeType)) {
      throw new BadRequestException(`Unsupported media MIME type: ${file.mimeType}`);
    }

    if (typeof file.sizeBytes !== 'number' || !Number.isInteger(file.sizeBytes) || file.sizeBytes < 0) {
      throw new BadRequestException('sizeBytes must be a non-negative integer');
    }
    if (file.sizeBytes > 15 * 1024 * 1024) {
      throw new BadRequestException('File size exceeds 15MB limit');
    }

    if (typeof file.altText !== 'string' || file.altText.trim().length === 0) {
      throw new BadRequestException('Accessibility alt text is mandatory for all uploaded assets');
    }
    if (typeof file.fileName !== 'string' || file.fileName.trim().length === 0 || file.fileName.length > 255) {
      throw new BadRequestException('fileName is required (max 255 chars)');
    }
    if (typeof file.fileUrl !== 'string' || file.fileUrl.trim().length === 0) {
      throw new BadRequestException('fileUrl is required');
    }
    const safeUrl = sanitizeUrl(file.fileUrl);
    if (safeUrl.toLowerCase().startsWith('mailto:')) {
      throw new BadRequestException('fileUrl must be an http(s) or relative URL');
    }

    const asset = await this.prisma.mediaAsset.create({
      data: {
        fileName: sanitizeRichText(file.fileName).slice(0, 255),
        fileUrl: safeUrl,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        altText: sanitizeRichText(file.altText).slice(0, 500),
        uploadedBy: adminUserId
      }
    });

    await this.auditService.logAction({
      actorId: adminUserId,
      actorRole: adminRole,
      action: 'UPLOAD_MEDIA_ASSET',
      entityType: 'MediaAsset',
      entityId: asset.id,
      afterState: { fileName: asset.fileName, mimeType: asset.mimeType }
    });

    return asset;
  }

  async getAllMediaAssets(page: { take: number; skip: number } = { take: 100, skip: 0 }) {
    return this.prisma.mediaAsset.findMany({
      orderBy: { createdAt: 'desc' },
      take: page.take,
      skip: page.skip
    });
  }
}

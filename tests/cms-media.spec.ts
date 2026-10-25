import { BadRequestException } from '@nestjs/common';
import { CMSService } from '../apps/api/src/cms/cms.service';

describe('CMS, Versioning & Media Controls Verification (Execution Engine)', () => {
  let cmsService: CMSService;
  let mockPrisma: any;
  let mockAudit: any;
  let sectionsDb: Map<string, any>;
  let versionsDb: any[];
  let assetsDb: any[];

  beforeEach(() => {
    sectionsDb = new Map();
    versionsDb = [];
    assetsDb = [];

    mockAudit = {
      logAction: jest.fn().mockResolvedValue({})
    };

    mockPrisma = {
      contentSection: {
        findUnique: jest.fn(async ({ where }) => {
          const s = sectionsDb.get(where.key);
          if (!s) return null;
          return {
            ...s,
            versions: versionsDb.filter((v) => v.sectionId === s.id)
          };
        }),
        upsert: jest.fn(async ({ where, update, create }) => {
          const existing = sectionsDb.get(where.key);
          const data = existing
            ? { ...existing, ...update, id: existing.id }
            : { id: `sec-${sectionsDb.size + 1}`, ...create };
          sectionsDb.set(where.key, data);
          return data;
        }),
        update: jest.fn(async ({ where, data }) => {
          const existing = sectionsDb.get(where.key);
          const updated = { ...existing, ...data };
          sectionsDb.set(where.key, updated);
          return updated;
        })
      },
      contentVersion: {
        create: jest.fn(async ({ data }) => {
          const v = { id: `ver-${versionsDb.length + 1}`, ...data, createdAt: new Date() };
          versionsDb.push(v);
          return v;
        }),
        findMany: jest.fn(async ({ where }) => {
          return versionsDb.filter((v) => !where?.sectionId || v.sectionId === where.sectionId);
        }),
        findUnique: jest.fn(async ({ where }) => {
          if (where.sectionId_versionNumber) {
            return (
              versionsDb.find(
                (v) =>
                  v.sectionId === where.sectionId_versionNumber.sectionId &&
                  v.versionNumber === where.sectionId_versionNumber.versionNumber
              ) || null
            );
          }
          return null;
        })
      },
      mediaAsset: {
        create: jest.fn(async ({ data }) => {
          const a = { id: `asset-${assetsDb.length + 1}`, ...data, createdAt: new Date() };
          assetsDb.push(a);
          return a;
        }),
        findMany: jest.fn(async () => assetsDb)
      },
      prize: {
        findMany: jest.fn().mockResolvedValue([
          { amount: 31000, isConfirmed: true, category: 'D40', rank: 1 },
          { amount: 21000, isConfirmed: true, category: 'D40', rank: 2 },
          { amount: 21000, isConfirmed: true, category: 'D20', rank: 1 },
          { amount: 11000, isConfirmed: true, category: 'D20', rank: 2 }
        ])
      },
      siteSetting: {
        findMany: jest.fn().mockResolvedValue([{ key: 'gst_rate', value: 18 }]),
        findUnique: jest.fn().mockResolvedValue({ value: { amount: 100000 } })
      },
      event: {
        findMany: jest.fn().mockResolvedValue([])
      },
      $transaction: jest.fn(async (cb) => {
        if (typeof cb === 'function') return cb(mockPrisma);
        if (Array.isArray(cb)) return Promise.all(cb);
        return cb;
      })
    };

    cmsService = new CMSService(mockPrisma as any, mockAudit as any);
  });

  test('1. saveSectionDraft, publishSection, and rollbackSection cycle', async () => {
    // 1A. Save Draft
    const draftRes = await cmsService.saveSectionDraft(
      'hero',
      {
        heroBackground: {
          mediaUrl: 'https://images.gcdis.in/hero.jpg',
          mediaType: 'image',
          focusX: 50,
          focusY: 50,
          zoom: 120,
          overlayColor: '#000000',
          overlayOpacity: 0.5,
          blurPx: 2,
          brightnessPct: 90,
          parallaxEnabled: false,
          mobileCropFocusY: 50
        }
      },
      'BUILDING NEXT-GEN AERIAL DRONES',
      'National Drone Soccer Championship 2026',
      'admin-1',
      'admin@gcdis.org'
    );

    expect(draftRes.title).toBe('BUILDING NEXT-GEN AERIAL DRONES');

    // 1B. Publish Draft
    const publishRes = await cmsService.publishSection(
      'hero',
      'Initial official publish',
      'admin-1',
      'admin@gcdis.org'
    );
    expect(publishRes.section.title).toBe('BUILDING NEXT-GEN AERIAL DRONES');
    expect(publishRes.version.versionNumber).toBe(1);
    expect(versionsDb.length).toBe(1);

    // 1C. Modify and Save 2nd Draft
    await cmsService.saveSectionDraft(
      'hero',
      { test: 'modified data' },
      'ACCIDENTAL MISTAKE IN TITLE',
      undefined,
      'admin-1',
      'admin@gcdis.org'
    );
    await cmsService.publishSection('hero', 'Mistake published', 'admin-1', 'admin@gcdis.org');
    expect(versionsDb.length).toBe(2);

    // 1D. Rollback to version 1
    const rollbackRes = await cmsService.rollbackSection('hero', 1, 'admin-1', 'admin@gcdis.org');
    expect(rollbackRes.title).toBe('BUILDING NEXT-GEN AERIAL DRONES');
  });

  test('2. Operational checklist detects unallocated prize pool remainder', async () => {
    const checklist = await cmsService.getOperationalChecklist();
    expect(checklist.items).toBeDefined();

    // Sum of prizes is 31k + 21k + 21k + 11k = 84k. Out of 100k, 16k is unallocated.
    const prizeItem = checklist.items.find((c) => c.id === 'prizes_remainder');
    expect(prizeItem).toBeDefined();
    expect(prizeItem?.status).toBe('Needs input');
    expect(prizeItem?.detail).toContain('INR 16,000');
  });

  test('3. Media asset creation enforces mandatory alt text', async () => {
    await expect(
      cmsService.createMediaAsset({
        fileName: 'banner.jpg',
        fileUrl: 'https://storage.gcdis.in/banner.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        altText: '' // Empty alt text must be rejected
      })
    ).rejects.toThrow(BadRequestException);

    const asset = await cmsService.createMediaAsset({
      fileName: 'banner.jpg',
      fileUrl: 'https://storage.gcdis.in/banner.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      altText: 'Aerial Drone Soccer Arena Action Shot'
    });

    expect(asset.id).toBeDefined();
    expect(asset.altText).toBe('Aerial Drone Soccer Arena Action Shot');
  });
});

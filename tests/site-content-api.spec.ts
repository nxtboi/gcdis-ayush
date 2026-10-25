import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@gcdis/shared';
import {
  CreateGalleryImageDto,
  CreateSponsorDto,
  GallerySectionDto,
  ReorderDto,
  SiteInfoDto,
  SponsorsSectionDto,
  UpdateSponsorDto
} from '../apps/api/src/cms/dto/site-content.dto';
import { SiteContentService, compareSponsorsForPublic } from '../apps/api/src/cms/site-content.service';
import {
  DEFAULT_SITE_INFO,
  MAIN_EVENT_SLUG,
  SPONSOR_TIERS,
  SPONSOR_TIER_LABELS
} from '../apps/api/src/cms/site-content.defaults';
import { UploadsService, IMAGE_PURPOSE_LIMITS, PUBLIC_UPLOAD_PURPOSES } from '../apps/api/src/uploads/uploads.service';
import { UploadsController } from '../apps/api/src/uploads/uploads.controller';
import { readImageDimensions } from '../apps/api/src/common/utils/upload-validator.util';

const ROOT = path.join(__dirname, '..');
const UPLOAD = '/api/uploads/files/0b8f9c1e-1111-4222-8333-944455556666_abcdef0123456789.png';

async function errorsOf(cls: any, plain: any): Promise<string[]> {
  const inst = plainToInstance(cls, plain);
  const errs = await validate(inst as object, { whitelist: true, forbidNonWhitelisted: true });
  const flat: string[] = [];
  const walk = (list: any[], prefix = '') => {
    for (const e of list) {
      if (e.constraints) flat.push(`${prefix}${e.property}`);
      if (e.children?.length) walk(e.children, `${prefix}${e.property}.`);
    }
  };
  walk(errs);
  return flat;
}

function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

describe('Site content DTO validation', () => {
  const sponsor = { name: 'QA Sponsor', tier: 'GOLD', placements: ['HOME', 'EVENT'] };

  test('sponsor: tiers, placements and https-only website URLs', async () => {
    expect(await errorsOf(CreateSponsorDto, sponsor)).toEqual([]);
    expect(await errorsOf(CreateSponsorDto, { ...sponsor, tier: 'DIAMOND' })).toContain('tier');
    expect(await errorsOf(CreateSponsorDto, { ...sponsor, placements: ['HOME', 'HOME'] })).toContain('placements');
    expect(await errorsOf(CreateSponsorDto, { ...sponsor, placements: ['SIDEBAR'] })).toContain('placements');
    expect(await errorsOf(CreateSponsorDto, { ...sponsor, websiteUrl: 'http://example.com' })).toContain('websiteUrl');
    expect(await errorsOf(CreateSponsorDto, { ...sponsor, websiteUrl: 'javascript:alert(1)' })).toContain('websiteUrl');
    expect(await errorsOf(CreateSponsorDto, { ...sponsor, websiteUrl: 'https://example.com/x' })).toEqual([]);
    expect(await errorsOf(CreateSponsorDto, { ...sponsor, websiteUrl: '' })).toEqual([]); // '' clears
    expect(await errorsOf(CreateSponsorDto, { ...sponsor, logoUrl: UPLOAD })).toEqual([]);
    expect(await errorsOf(CreateSponsorDto, { ...sponsor, logoUrl: '/api/uploads/files/../../etc/passwd' })).toContain('logoUrl');
    expect(await errorsOf(CreateSponsorDto, { ...sponsor, name: 'x'.repeat(121) })).toContain('name');
    expect(await errorsOf(CreateSponsorDto, { ...sponsor, description: 'x'.repeat(1001) })).toContain('description');
    expect(await errorsOf(CreateSponsorDto, { ...sponsor, eventId: 'x' })).toContain('eventId');
    expect(await errorsOf(CreateSponsorDto, { ...sponsor, displayOrder: -1 })).toContain('displayOrder');
  });

  test('sponsor PATCH is partial but rejects null for required fields', async () => {
    expect(await errorsOf(UpdateSponsorDto, {})).toEqual([]);
    expect(await errorsOf(UpdateSponsorDto, { isActive: false })).toEqual([]);
    expect(await errorsOf(UpdateSponsorDto, { logoUrl: null, websiteUrl: null })).toEqual([]);
    expect(await errorsOf(UpdateSponsorDto, { name: null })).toContain('name');
    expect(await errorsOf(UpdateSponsorDto, { tier: null })).toContain('tier');
  });

  test('gallery images must come from an upload path', async () => {
    const ok = { imageUrl: UPLOAD, title: 'QA', altText: 'QA alt' };
    expect(await errorsOf(CreateGalleryImageDto, ok)).toEqual([]);
    expect(await errorsOf(CreateGalleryImageDto, { ...ok, imageUrl: 'https://example.com/a.png' })).toContain('imageUrl');
    expect(await errorsOf(CreateGalleryImageDto, { ...ok, altText: '' })).toContain('altText');
    expect(await errorsOf(CreateGalleryImageDto, { ...ok, isPublished: 'yes' })).toContain('isPublished');
  });

  test('reorder takes unique UUIDs', async () => {
    expect(await errorsOf(ReorderDto, { ids: ['0b8f9c1e-1111-4222-8333-944455556666'] })).toEqual([]);
    expect(await errorsOf(ReorderDto, { ids: ['nope'] })).toContain('ids');
    expect(await errorsOf(ReorderDto, { ids: [] })).toContain('ids');
    const dup = '0b8f9c1e-1111-4222-8333-944455556666';
    expect(await errorsOf(ReorderDto, { ids: [dup, dup] })).toContain('ids');
  });

  test('site information: email, tel pattern, https URLs, address and phone caps', async () => {
    const info = JSON.parse(JSON.stringify(DEFAULT_SITE_INFO));
    expect(await errorsOf(SiteInfoDto, info)).toEqual([]);
    expect(await errorsOf(SiteInfoDto, { ...info, email: 'not-an-email' })).toContain('email');
    expect(await errorsOf(SiteInfoDto, { ...info, phones: [{ display: 'x', tel: '12-34' }] })).toContain('phones.0.tel');
    expect(await errorsOf(SiteInfoDto, { ...info, phones: Array(5).fill({ display: 'x', tel: '+911234567' }) })).toContain('phones');
    expect(await errorsOf(SiteInfoDto, { ...info, addressLines: Array(7).fill('line') })).toContain('addressLines');
    expect(await errorsOf(SiteInfoDto, { ...info, mapUrl: 'http://maps.example.com' })).toContain('mapUrl');
    expect(await errorsOf(SiteInfoDto, { ...info, social: { linkedin: 'http://linkedin.com/x' } })).toContain('social.linkedin');
    expect(await errorsOf(SiteInfoDto, { ...info, social: { tiktok: 'https://t.example' } })).toContain('social.tiktok');
    expect(await errorsOf(SiteInfoDto, { ...info, aboutImageUrl: UPLOAD })).toEqual([]);
    expect(await errorsOf(SiteInfoDto, { ...info, aboutImageUrl: 'data:image/png;base64,AAAA' })).toContain('aboutImageUrl');
  });

  test('section settings', async () => {
    expect(await errorsOf(SponsorsSectionDto, { enabled: true, title: 'S', subtitle: '', showOn: { home: true, event: false, footer: true } })).toEqual([]);
    expect(await errorsOf(SponsorsSectionDto, { enabled: true, title: 'S', showOn: { home: true, event: false } })).toContain('showOn.footer');
    expect(await errorsOf(GallerySectionDto, { enabled: false, title: 'Gallery', subtitle: 'x' })).toEqual([]);
    expect(await errorsOf(GallerySectionDto, { enabled: false, title: '' })).toContain('title');
  });
});

describe('Site content defaults', () => {
  test('match the web constants in apps/web/src/lib/site.ts', () => {
    const site = fs.readFileSync(path.join(ROOT, 'apps/web/src/lib/site.ts'), 'utf8');
    expect(site).toContain(`'${DEFAULT_SITE_INFO.email}'`);
    for (const line of DEFAULT_SITE_INFO.addressLines) expect(site).toContain(`'${line}'`);
    for (const p of DEFAULT_SITE_INFO.phones) {
      expect(site).toContain(`display: '${p.display}'`);
      expect(site).toContain(`tel: '${p.tel}'`);
    }
  });

  test('tier order and labels follow the contract', () => {
    expect([...SPONSOR_TIERS]).toEqual(['TITLE', 'PLATINUM', 'GOLD', 'SILVER', 'PARTNER', 'ACADEMIC', 'MEDIA']);
    expect(SPONSOR_TIER_LABELS.ACADEMIC).toBe('Academic Partner');
  });

  test('seed creates the three settings without overwriting edited values', () => {
    const seed = fs.readFileSync(path.join(ROOT, 'apps/api/prisma/seed.ts'), 'utf8');
    expect(seed).toMatch(/SITE_SETTING_KEYS\.siteInfo/);
    expect(seed).toMatch(/SITE_SETTING_KEYS\.sponsorsSection/);
    expect(seed).toMatch(/SITE_SETTING_KEYS\.gallerySection/);
    expect(seed).toMatch(/update: \{\},\s*create: \{ key: s\.key, value: s\.value as any/);
  });

  test('schema and migration define gallery images, sponsor fields and session step-up columns', () => {
    const schema = fs.readFileSync(path.join(ROOT, 'apps/api/prisma/schema.prisma'), 'utf8');
    expect(schema).toMatch(/model GalleryImage \{/);
    expect(schema).toMatch(/placements\s+String\[\]\s+@default\(\["HOME", "EVENT", "FOOTER"\]\)/);
    expect(schema).toMatch(/stepUpAt\s+DateTime\?/);
    expect(schema).toMatch(/lastUsedAt\s+DateTime\?/);
    const sql = fs.readFileSync(
      path.join(ROOT, 'apps/api/prisma/migrations/20261012120000_site_content_and_step_up/migration.sql'),
      'utf8'
    );
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "gallery_images"');
    expect(sql).toContain('"stepUpAt"');
    expect(sql).not.toMatch(/\r/);
  });
});

describe('SiteContentService', () => {
  let prisma: any;
  let audit: any;
  let uploads: any;
  let svc: SiteContentService;
  const actor = { id: 'admin-1', email: 'qa@example.test', role: 'SUPER_ADMIN' };
  const row = (over: any = {}) => ({
    id: 's-' + Math.random().toString(16).slice(2),
    eventId: 'ev',
    name: 'QA',
    tier: 'GOLD',
    logoUrl: null,
    websiteUrl: null,
    description: null,
    placements: ['HOME', 'EVENT', 'FOOTER'],
    isActive: true,
    displayOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over
  });

  beforeEach(() => {
    prisma = {
      siteSetting: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
      sponsor: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }: any) => row(data)),
        update: jest.fn(async ({ where, data }: any) => row({ id: where.id, ...data })),
        delete: jest.fn().mockResolvedValue({}),
        aggregate: jest.fn().mockResolvedValue({ _max: { displayOrder: 4 } })
      },
      galleryImage: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }: any) => ({ id: 'g1', createdAt: new Date(), updatedAt: new Date(), ...data })),
        update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
        delete: jest.fn().mockResolvedValue({}),
        aggregate: jest.fn().mockResolvedValue({ _max: { displayOrder: null } })
      },
      event: { findUnique: jest.fn().mockResolvedValue({ id: 'ev-main' }), findFirst: jest.fn().mockResolvedValue(null) },
      mediaAsset: { findFirst: jest.fn().mockResolvedValue({ id: 'asset-1', width: 800, height: 600 }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(async (ops: any[]) => Promise.all(ops))
    };
    audit = { logAction: jest.fn().mockResolvedValue({}) };
    uploads = { deleteStoredFile: jest.fn().mockResolvedValue(true) };
    svc = new SiteContentService(prisma, audit, uploads as any);
  });

  const actions = () => audit.logAction.mock.calls.map((c: any[]) => c[0].action);

  test('public site returns defaults when nothing is saved and merges partial values', async () => {
    let site = await svc.getPublicSite();
    expect(site.siteInfo).toEqual(DEFAULT_SITE_INFO);
    expect(site.sponsorsSection).toEqual({ enabled: true, title: 'Sponsors and Partners', subtitle: '', showOn: { home: true, event: true, footer: true } });
    expect(site.gallerySection).toEqual({ enabled: true, title: 'Gallery', subtitle: '' });

    prisma.siteSetting.findMany.mockResolvedValue([{ key: 'sponsors_section', value: { enabled: false, showOn: { footer: false } } }]);
    site = await svc.getPublicSite();
    expect(site.sponsorsSection).toEqual({ enabled: false, title: 'Sponsors and Partners', subtitle: '', showOn: { home: true, event: true, footer: false } });
  });

  test('public sponsors: active only, placement filter, tier rank then displayOrder', async () => {
    prisma.sponsor.findMany.mockResolvedValue([
      row({ id: 'b', tier: 'GOLD', displayOrder: 0, name: 'B' }),
      row({ id: 'a', tier: 'TITLE', displayOrder: 5, name: 'A' }),
      row({ id: 'c', tier: 'GOLD', displayOrder: 1, name: 'C' })
    ]);
    const list = await svc.getPublicSponsors('home');
    expect(prisma.sponsor.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { isActive: true, placements: { has: 'HOME' } } }));
    expect(list.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(Object.keys(list[0]).sort()).toEqual(
      ['createdAt', 'description', 'displayOrder', 'id', 'isActive', 'logoUrl', 'name', 'placements', 'tier', 'updatedAt', 'websiteUrl'].sort()
    );
    await svc.getPublicSponsors(undefined);
    expect(prisma.sponsor.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { isActive: true } }));
    await expect(svc.getPublicSponsors('SIDEBAR')).rejects.toThrow(BadRequestException);
    expect(compareSponsorsForPublic({ tier: 'MEDIA', displayOrder: 0, name: 'x' }, { tier: 'ACADEMIC', displayOrder: 9, name: 'y' })).toBeGreaterThan(0);
  });

  test('create sponsor resolves the main event, sanitises text, appends to the order and audits', async () => {
    const created = await svc.createSponsor(
      { name: ' QA <b>Sponsor</b> ', tier: 'GOLD', placements: ['FOOTER', 'HOME'], description: '<script>x</script>Hi' } as any,
      actor
    );
    expect(prisma.event.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { slug: MAIN_EVENT_SLUG } }));
    const data = prisma.sponsor.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ eventId: 'ev-main', name: 'QA Sponsor', description: 'Hi', placements: ['HOME', 'FOOTER'], isActive: true, displayOrder: 5 });
    expect(created.placements).toEqual(['HOME', 'FOOTER']);
    expect(actions()).toEqual(['CREATE_SPONSOR']);
    expect(audit.logAction.mock.calls[0][0]).toMatchObject({ actorId: 'admin-1', entityType: 'Sponsor' });
  });

  test('create sponsor fails with 409 when the main event does not exist', async () => {
    prisma.event.findUnique.mockResolvedValue(null);
    await expect(svc.createSponsor({ name: 'QA', tier: 'GOLD', placements: [] } as any, actor)).rejects.toThrow(ConflictException);
  });

  test('uploaded logos must be public image uploads', async () => {
    prisma.mediaAsset.findFirst.mockResolvedValue(null);
    await expect(svc.createSponsor({ name: 'QA', tier: 'GOLD', placements: [], logoUrl: UPLOAD } as any, actor)).rejects.toThrow(BadRequestException);
    expect(prisma.mediaAsset.findFirst.mock.calls[0][0].where).toMatchObject({ fileUrl: UPLOAD, isPublic: true });
  });

  test('update / delete sponsor: 404 for unknown ids, audit for each write', async () => {
    prisma.sponsor.findUnique.mockResolvedValue(null);
    await expect(svc.updateSponsor('x', { isActive: false } as any, actor)).rejects.toThrow(NotFoundException);
    await expect(svc.deleteSponsor('x', actor)).rejects.toThrow(NotFoundException);

    prisma.sponsor.findUnique.mockResolvedValue(row({ id: 'sp1' }));
    const updated = await svc.updateSponsor('sp1', { isActive: false, websiteUrl: null } as any, actor);
    expect(updated.isActive).toBe(false);
    await expect(svc.updateSponsor('sp1', {} as any, actor)).rejects.toThrow(BadRequestException);
    await expect(svc.deleteSponsor('sp1', actor)).resolves.toMatchObject({ success: true, id: 'sp1' });
    expect(actions()).toEqual(expect.arrayContaining(['UPDATE_SPONSOR', 'DELETE_SPONSOR']));
  });

  test('deleting or replacing a sponsor logo cleans up the stored file when unused', async () => {
    const cleanup = jest.spyOn(svc, 'removeFileIfUnreferenced').mockResolvedValue(true);
    prisma.sponsor.findUnique.mockResolvedValue(row({ id: 'sp1', logoUrl: '/api/uploads/files/old-logo.png' }));
    await expect(svc.deleteSponsor('sp1', actor)).resolves.toEqual({ success: true, id: 'sp1', fileDeleted: true });
    expect(cleanup).toHaveBeenCalledWith('/api/uploads/files/old-logo.png', actor);

    cleanup.mockClear();
    prisma.sponsor.update.mockResolvedValue(row({ id: 'sp1', logoUrl: null }));
    await svc.updateSponsor('sp1', { logoUrl: null } as any, actor);
    expect(cleanup).toHaveBeenCalledWith('/api/uploads/files/old-logo.png', actor);
    cleanup.mockRestore();
  });

  test('reorder puts listed ids first, keeps the rest, rejects unknown ids', async () => {
    prisma.sponsor.findMany.mockResolvedValueOnce([
      { id: 'a', displayOrder: 0 },
      { id: 'b', displayOrder: 1 },
      { id: 'c', displayOrder: 2 }
    ]);
    await svc.reorderSponsors(['c', 'a'], actor);
    const updates = prisma.sponsor.update.mock.calls.map((c: any[]) => [c[0].where.id, c[0].data.displayOrder]);
    expect(updates).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2]
    ]); // unlisted b follows the listed ids
    expect(actions()).toContain('REORDER_SPONSORS');

    prisma.sponsor.findMany.mockResolvedValueOnce([{ id: 'a', displayOrder: 0 }]);
    await expect(svc.reorderSponsors(['zzz'], actor)).rejects.toThrow(BadRequestException);
  });

  test('gallery create requires a GALLERY_IMAGE upload and copies its dimensions', async () => {
    const img = await svc.createGalleryImage({ imageUrl: UPLOAD, title: 'QA', altText: 'QA alt', caption: '' as any } as any, actor);
    expect(prisma.mediaAsset.findFirst.mock.calls[0][0].where).toMatchObject({ purpose: { in: ['GALLERY_IMAGE'] } });
    expect(img).toMatchObject({ width: 800, height: 600, displayOrder: 0, isPublished: true, caption: null });
    expect(prisma.galleryImage.create.mock.calls[0][0].data).toMatchObject({ uploadedBy: 'admin-1', mediaAssetId: 'asset-1' });

    prisma.mediaAsset.findFirst.mockResolvedValue(null);
    await expect(svc.createGalleryImage({ imageUrl: UPLOAD, title: 'QA', altText: 'x' } as any, actor)).rejects.toThrow(BadRequestException);
  });

  test('gallery delete removes the stored file only when nothing else references it', async () => {
    prisma.galleryImage.findUnique.mockResolvedValue({ id: 'g1', imageUrl: UPLOAD, title: 'QA', altText: 'x' });
    let res = await svc.deleteGalleryImage('g1', actor);
    expect(res).toEqual({ success: true, id: 'g1', fileDeleted: true });
    expect(uploads.deleteStoredFile).toHaveBeenCalledWith(UPLOAD);
    expect(actions()).toEqual(['DELETE_GALLERY_IMAGE', 'DELETE_STORED_FILE']);

    // Still used by a sponsor logo
    uploads.deleteStoredFile.mockClear();
    prisma.sponsor.findFirst.mockResolvedValue({ id: 'sp' });
    res = await svc.deleteGalleryImage('g1', actor);
    expect(res.fileDeleted).toBe(false);
    expect(uploads.deleteStoredFile).not.toHaveBeenCalled();

    // Still referenced by a site setting / content section / hero (raw JSON search)
    prisma.sponsor.findFirst.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([{ n: 1 }]);
    res = await svc.deleteGalleryImage('g1', actor);
    expect(res.fileDeleted).toBe(false);
    expect(uploads.deleteStoredFile).not.toHaveBeenCalled();

    prisma.galleryImage.findUnique.mockResolvedValue(null);
    await expect(svc.deleteGalleryImage('g1', actor)).rejects.toThrow(NotFoundException);
  });

  test('replacing a gallery image cleans up the previous file when unused', async () => {
    const OTHER = UPLOAD.replace('abcdef', '123456');
    prisma.galleryImage.findUnique.mockResolvedValue({ id: 'g1', imageUrl: UPLOAD, title: 'QA', altText: 'x' });
    const res = await svc.updateGalleryImage('g1', { imageUrl: OTHER } as any, actor);
    expect(res.imageUrl).toBe(OTHER);
    expect(uploads.deleteStoredFile).toHaveBeenCalledWith(UPLOAD);
  });

  test('saving site information sanitises text and audits the setting', async () => {
    const info: any = JSON.parse(JSON.stringify(DEFAULT_SITE_INFO));
    info.organisationName = '<b>GCDIS</b> Centre';
    info.addressLines = ['Line 1', '   ', 'Line <i>2</i>'];
    info.social = { linkedin: 'https://linkedin.com/company/x', x: null };
    const saved = await svc.saveSiteInfo(info, actor);
    expect(saved.organisationName).toBe('GCDIS Centre');
    expect(saved.addressLines).toEqual(['Line 1', 'Line 2']);
    expect(saved.social).toEqual({ linkedin: 'https://linkedin.com/company/x' });
    expect(prisma.siteSetting.upsert.mock.calls[0][0].where).toEqual({ key: 'site_info' });
    expect(audit.logAction.mock.calls[0][0]).toMatchObject({ action: 'UPDATE_SITE_SETTING', entityId: 'site_info' });
  });
});

describe('Site image uploads', () => {
  let service: UploadsService;
  const prisma: any = {
    mediaAsset: { create: jest.fn(async ({ data }: any) => ({ id: 'asset', ...data })) }
  };
  beforeAll(() => {
    service = new UploadsService(prisma, { logAction: jest.fn() } as any);
  });

  test('new purposes are public and admin-only', async () => {
    expect(PUBLIC_UPLOAD_PURPOSES.has('GALLERY_IMAGE')).toBe(true);
    expect(PUBLIC_UPLOAD_PURPOSES.has('SITE_IMAGE')).toBe(true);
    for (const purpose of ['GALLERY_IMAGE', 'SITE_IMAGE', 'SPONSOR_LOGO']) {
      await expect(service.processUpload(png(4, 4), 'x.png', 'cap', UserRole.TEAM_CAPTAIN, purpose)).rejects.toThrow(ForbiddenException);
    }
  });

  test('JPEG / PNG / WebP only, with per-purpose size limits, and dimensions recorded', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64)]);
    await expect(service.processUpload(pdf, 'x.pdf', 'adm', UserRole.SUPER_ADMIN, 'SITE_IMAGE')).rejects.toThrow(BadRequestException);
    const tooBig = Buffer.concat([png(4, 4), Buffer.alloc(IMAGE_PURPOSE_LIMITS.SPONSOR_LOGO)]);
    await expect(service.processUpload(tooBig, 'x.png', 'adm', UserRole.SUPER_ADMIN, 'SPONSOR_LOGO')).rejects.toThrow(BadRequestException);
    expect(IMAGE_PURPOSE_LIMITS).toEqual({ SPONSOR_LOGO: 2 * 1024 * 1024, GALLERY_IMAGE: 8 * 1024 * 1024, SITE_IMAGE: 8 * 1024 * 1024 });

    const ok = await service.processUpload(png(30, 20), 'g.png', 'adm', UserRole.EVENT_ADMIN, 'GALLERY_IMAGE');
    expect(ok).toMatchObject({ isPublic: true, width: 30, height: 20, mimeType: 'image/png' });
    expect(ok.fileUrl).toMatch(/^\/api\/uploads\/files\//);

    // deleteStoredFile only touches upload URLs
    await expect(service.deleteStoredFile('/etc/passwd')).resolves.toBe(false);
    prisma.mediaAsset.deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    await expect(service.deleteStoredFile(ok.fileUrl)).resolves.toBe(true);
    expect(prisma.mediaAsset.deleteMany).toHaveBeenCalledWith({ where: { fileUrl: ok.fileUrl } });
  });

  test('readImageDimensions parses PNG, JPEG and WebP headers', () => {
    expect(readImageDimensions(png(7, 9), 'image/png')).toEqual({ width: 7, height: 9 });
    // Minimal JPEG: SOI, APP0, SOF0 (height 50, width 70)
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x32, 0x00, 0x46, 0x03,
      0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9
    ]);
    expect(readImageDimensions(jpeg, 'image/jpeg')).toEqual({ width: 70, height: 50 });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0);
    webp.write('WEBP', 8);
    webp.write('VP8X', 12);
    webp.writeUIntLE(99, 24, 3);
    webp.writeUIntLE(49, 27, 3);
    expect(readImageDimensions(webp, 'image/webp')).toEqual({ width: 100, height: 50 });
    expect(readImageDimensions(Buffer.alloc(30), 'image/png')).toBeNull();
  });
});

describe('Cross-Origin-Resource-Policy on served uploads', () => {
  const makeRes = () => {
    const headers: Record<string, string> = {};
    return { headers, setHeader: (k: string, v: string) => { headers[k] = v; } } as any;
  };
  const service: any = {
    isAssetPrivate: jest.fn(),
    verifySignedToken: jest.fn().mockReturnValue(true),
    getFileStream: jest.fn().mockResolvedValue({ stream: { pipe: jest.fn() }, mimeType: 'image/png', fileName: 'a.png' })
  };
  const controller = new UploadsController(service);

  test('public upload files are cross-origin readable', async () => {
    service.isAssetPrivate.mockResolvedValue(false);
    const res = makeRes();
    await controller.getFile('k.png', '', '', res);
    expect(res.headers['Cross-Origin-Resource-Policy']).toBe('cross-origin');
  });

  test('private files stay same-origin', async () => {
    service.isAssetPrivate.mockResolvedValue(true);
    const res = makeRes();
    await controller.getFile('k.pdf', 't', '99999999999', res);
    expect(res.headers['Cross-Origin-Resource-Policy']).toBe('same-origin');
  });
});

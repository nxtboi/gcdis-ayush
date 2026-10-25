import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { BadRequestException, ForbiddenException, HttpException, INestApplication, Injectable, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { Strategy as PassportStrategyBase } from 'passport-strategy';
import { UserRole } from '@gcdis/shared';
import { InMemoryPrisma } from './support/in-memory-prisma';
import { ChampionshipMediaController } from '../apps/api/src/cms/championship-media.controller';
import { ChampionshipMediaService } from '../apps/api/src/cms/championship-media.service';
import {
  CHAMPIONSHIP_GALLERY_MAX,
  ChampionshipMediaSchema,
  CreateChampionshipGalleryItemSchema,
  ReorderChampionshipGallerySchema,
  UpdateChampionshipGalleryItemSchema,
  UpdateChampionshipHeroSchema
} from '../apps/api/src/cms/dto/championship-media.schema';
import { SiteContentService, jsonContainsString } from '../apps/api/src/cms/site-content.service';
import { CHAMPIONSHIP_MEDIA_SETTING_KEY, SITE_SETTING_KEYS } from '../apps/api/src/cms/site-content.defaults';
import { UploadsController, parseByteRange, streamUploadLimit } from '../apps/api/src/uploads/uploads.controller';
import {
  ADMIN_ONLY_PURPOSES,
  PUBLIC_UPLOAD_PURPOSES,
  UPLOAD_PURPOSES,
  UploadsService,
  videoUploadMaxBytes
} from '../apps/api/src/uploads/uploads.service';
import { detectVideoMimeType, validateUploadedBuffer } from '../apps/api/src/common/utils/upload-validator.util';
import { PrismaService } from '../apps/api/src/prisma/prisma.service';
import { AuditService } from '../apps/api/src/audit/audit.service';
import { JwtAuthGuard } from '../apps/api/src/auth/jwt-auth.guard';
import { RolesGuard } from '../apps/api/src/auth/roles.guard';
import { StepUpGuard } from '../apps/api/src/auth/step-up.guard';
import { CsrfGuard } from '../apps/api/src/common/guards/csrf.guard';
import { AccountIpRateLimiterGuard } from '../apps/api/src/common/guards/rate-limiter.guard';
import { ROLES_KEY } from '../apps/api/src/auth/roles.decorator';

/**
 * Championship page media (feature): hero video + poster + drone / arena photo gallery stored in the
 * `championship_media` site setting; public read; staff endpoints (authorisation, CSRF, step-up, audit);
 * EVENT_VIDEO uploads (magic bytes, size limits, ClamAV); HTTP Range on public videos; file cleanup.
 */

const ROOT = path.join(__dirname, '..');
const MB = 1024 * 1024;
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

// ------------------------------------------------------------------------------------------------ fixtures

/** Minimal ISO-BMFF MP4: ftyp (isom, compatible iso2 / avc1 / mp41), free and mdat boxes; `total` bytes long. */
function mp4(total = 1024, major = 'isom', compatible = ['isom', 'iso2', 'avc1', 'mp41']): Buffer {
  const ftypBody = Buffer.concat([Buffer.from(major, 'latin1'), Buffer.from([0, 0, 2, 0]), ...compatible.map((b) => Buffer.from(b, 'latin1'))]);
  const ftyp = Buffer.alloc(8 + ftypBody.length);
  ftyp.writeUInt32BE(ftyp.length, 0);
  ftyp.write('ftyp', 4, 'latin1');
  ftypBody.copy(ftyp, 8);
  const free = Buffer.from([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]);
  const mdatLen = Math.max(total - ftyp.length - free.length, 8);
  const mdat = Buffer.alloc(mdatLen);
  mdat.writeUInt32BE(mdatLen, 0);
  mdat.write('mdat', 4, 'latin1');
  for (let i = 8; i < mdatLen; i++) mdat[i] = i % 251;
  return Buffer.concat([ftyp, free, mdat]);
}

/** Minimal WebM: EBML header with DocType `docType`, then a Segment element with filler. */
function webm(docType = 'webm', total = 512): Buffer {
  const el = (id: number[], data: Buffer) => Buffer.concat([Buffer.from(id), Buffer.from([0x80 | data.length]), data]);
  const body = Buffer.concat([
    el([0x42, 0x86], Buffer.from([1])),
    el([0x42, 0xf7], Buffer.from([1])),
    el([0x42, 0xf2], Buffer.from([4])),
    el([0x42, 0xf3], Buffer.from([8])),
    el([0x42, 0x82], Buffer.from(docType, 'latin1')),
    el([0x42, 0x87], Buffer.from([2])),
    el([0x42, 0x85], Buffer.from([2]))
  ]);
  const header = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | body.length]), body]);
  const filler = Buffer.alloc(Math.max(total - header.length - 5, 0), 0x11);
  return Buffer.concat([header, Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01]), filler]);
}

function png(w = 4, h = 3): Buffer {
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
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc((w * 3 + 1) * h))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const VIDEO_A = '/api/uploads/files/0b8f9c1e-1111-4222-8333-944455556666_aaaaaaaaaaaaaaaa.mp4';
const VIDEO_B = '/api/uploads/files/0b8f9c1e-1111-4222-8333-944455556666_bbbbbbbbbbbbbbbb.webm';
const IMG_A = '/api/uploads/files/0b8f9c1e-1111-4222-8333-944455556666_cccccccccccccccc.png';
const IMG_B = '/api/uploads/files/0b8f9c1e-1111-4222-8333-944455556666_dddddddddddddddd.webp';
const UUID_A = '6f1c3d2e-1111-4222-8333-944455556666';
const UUID_B = '6f1c3d2e-2222-4222-8333-944455556666';

const actor = { id: 'admin-1', email: 'event.admin@example.test', role: 'EVENT_ADMIN' };

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const out = fn();
    if (out && typeof (out as any).then === 'function') return (out as any).finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

// ======================================================================================================

describe('championship media: schema validation', () => {
  const item = { id: UUID_A, imageUrl: IMG_A, caption: 'Quad in the cage', kind: 'drone', published: true };
  const value = { heroVideoUrl: VIDEO_A, heroPosterUrl: IMG_A, gallery: [item] };

  test('a full value and the empty value pass; unknown keys are rejected at every level', () => {
    expect(ChampionshipMediaSchema.safeParse(value).success).toBe(true);
    expect(ChampionshipMediaSchema.safeParse({ heroVideoUrl: null, heroPosterUrl: null, gallery: [] }).success).toBe(true);
    expect(ChampionshipMediaSchema.safeParse({ ...value, extra: 1 }).success).toBe(false);
    expect(ChampionshipMediaSchema.safeParse({ ...value, gallery: [{ ...item, onclick: 'x' }] }).success).toBe(false);
    expect(CreateChampionshipGalleryItemSchema.safeParse({ imageUrl: IMG_A, kind: 'arena', id: UUID_A }).success).toBe(false);
    expect(UpdateChampionshipGalleryItemSchema.safeParse({ imageUrl: IMG_B }).success).toBe(false);
  });

  test('captions are plain text, at most 160 characters', () => {
    const ok = CreateChampionshipGalleryItemSchema.safeParse({ imageUrl: IMG_A, kind: 'drone', caption: '<b>Fast</b> <script>alert(1)</script>quad' });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.caption).not.toMatch(/[<>]/);
      expect(ok.data.caption).toContain('Fast');
    }
    expect(CreateChampionshipGalleryItemSchema.safeParse({ imageUrl: IMG_A, kind: 'drone', caption: 'x'.repeat(160) }).success).toBe(true);
    expect(CreateChampionshipGalleryItemSchema.safeParse({ imageUrl: IMG_A, kind: 'drone', caption: 'x'.repeat(161) }).success).toBe(false);
  });

  test('kind is drone, arena or event', () => {
    for (const kind of ['drone', 'arena', 'event']) expect(CreateChampionshipGalleryItemSchema.safeParse({ imageUrl: IMG_A, kind }).success).toBe(true);
    for (const kind of ['team', 'DRONE', '', undefined]) expect(CreateChampionshipGalleryItemSchema.safeParse({ imageUrl: IMG_A, kind }).success).toBe(false);
  });

  test('URLs are uploaded files or https only', () => {
    const ok = (url: unknown) => CreateChampionshipGalleryItemSchema.safeParse({ imageUrl: url, kind: 'event' }).success;
    expect(ok(IMG_A)).toBe(true);
    expect(ok('https://cdn.example.com/arena.jpg')).toBe(true);
    for (const bad of [
      'http://cdn.example.com/a.jpg',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      '//evil.example/a.png',
      '/api/uploads/files/../../etc/passwd',
      '/images/arena.jpg',
      '#gallery',
      `https://example.com/${'a'.repeat(600)}`
    ]) {
      expect({ bad, ok: ok(bad) }).toEqual({ bad, ok: false });
    }
    expect(UpdateChampionshipHeroSchema.safeParse({ heroVideoUrl: 'ftp://x.example/v.mp4' }).success).toBe(false);
  });

  test('at most 40 photos, ids unique; reorder lists unique UUIDs', () => {
    const many = Array.from({ length: CHAMPIONSHIP_GALLERY_MAX + 1 }, (_, i) => ({
      ...item,
      id: `6f1c3d2e-1111-4222-8333-${String(i).padStart(12, '0')}`
    }));
    expect(CHAMPIONSHIP_GALLERY_MAX).toBe(40);
    expect(ChampionshipMediaSchema.safeParse({ ...value, gallery: many.slice(0, 40) }).success).toBe(true);
    expect(ChampionshipMediaSchema.safeParse({ ...value, gallery: many }).success).toBe(false);
    expect(ChampionshipMediaSchema.safeParse({ ...value, gallery: [item, item] }).success).toBe(false);
    expect(ReorderChampionshipGallerySchema.safeParse({ ids: [UUID_A, UUID_B] }).success).toBe(true);
    expect(ReorderChampionshipGallerySchema.safeParse({ ids: [UUID_A, UUID_A] }).success).toBe(false);
    expect(ReorderChampionshipGallerySchema.safeParse({ ids: ['nope'] }).success).toBe(false);
    expect(ReorderChampionshipGallerySchema.safeParse({ ids: [] }).success).toBe(false);
  });

  test('hero updates need a field; empty string removes', () => {
    expect(UpdateChampionshipHeroSchema.safeParse({}).success).toBe(false);
    const cleared = UpdateChampionshipHeroSchema.safeParse({ heroPosterUrl: '' });
    expect(cleared.success && cleared.data.heroPosterUrl).toBeNull();
    expect(UpdateGalleryNeedsField()).toBe(false);
  });

  function UpdateGalleryNeedsField() {
    return UpdateChampionshipGalleryItemSchema.safeParse({}).success;
  }
});

// ======================================================================================================

function makeService() {
  const db = new InMemoryPrisma();
  db.reset({
    MediaAsset: [
      { fileName: 'a.mp4', fileUrl: VIDEO_A, mimeType: 'video/mp4', sizeBytes: 10, purpose: 'EVENT_VIDEO', isPublic: true },
      { fileName: 'b.webm', fileUrl: VIDEO_B, mimeType: 'video/webm', sizeBytes: 10, purpose: 'EVENT_VIDEO', isPublic: true },
      { fileName: 'a.png', fileUrl: IMG_A, mimeType: 'image/png', sizeBytes: 10, purpose: 'GALLERY_IMAGE', isPublic: true },
      { fileName: 'b.webp', fileUrl: IMG_B, mimeType: 'image/webp', sizeBytes: 10, purpose: 'SITE_IMAGE', isPublic: true }
    ]
  });
  const audit = { logAction: jest.fn().mockResolvedValue({}) };
  const siteContent = { removeFileIfUnreferenced: jest.fn().mockResolvedValue(true) };
  const svc = new ChampionshipMediaService(db as any, audit as any, siteContent as any);
  const stored = () => db.rows('SiteSetting').find((r) => r.key === CHAMPIONSHIP_MEDIA_SETTING_KEY)?.value;
  return { svc, db, audit, siteContent, stored };
}

describe('ChampionshipMediaService', () => {
  test('nothing set: nulls and an empty gallery (never an error)', async () => {
    const { svc } = makeService();
    await expect(svc.getPublic()).resolves.toEqual({ heroVideoUrl: null, heroPosterUrl: null, gallery: [], sections: {} });
    const admin = await svc.getAdmin();
    expect(admin.limits).toMatchObject({ galleryMax: 40, captionMax: 160, videoMaxBytes: 60 * MB, videoTypes: ['video/mp4', 'video/webm'] });
  });

  test('stored data that no longer validates falls back to the empty defaults', async () => {
    const { svc, db } = makeService();
    await (db as any).siteSetting.create({ data: { key: CHAMPIONSHIP_MEDIA_SETTING_KEY, value: { heroVideoUrl: 'javascript:alert(1)', heroPosterUrl: null, gallery: [] } } } as any);
    await expect(svc.getPublic()).resolves.toEqual({ heroVideoUrl: null, heroPosterUrl: null, gallery: [], sections: {} });
  });

  test('setting the first video and poster needs no step-up; replacing needs one and cleans up the old file', async () => {
    const { svc, siteContent, audit, stored } = makeService();
    await svc.updateHero({ heroVideoUrl: VIDEO_A, heroPosterUrl: IMG_B }, actor, false);
    expect(stored()).toMatchObject({ heroVideoUrl: VIDEO_A, heroPosterUrl: IMG_B });
    expect(audit.logAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'UPDATE_CHAMPIONSHIP_HERO_MEDIA', actorId: 'admin-1', afterState: { heroVideoUrl: VIDEO_A, heroPosterUrl: IMG_B } })
    );

    // Replace without step-up: 403 STEP_UP_REQUIRED, nothing changes, nothing is deleted
    const err = await svc.updateHero({ heroVideoUrl: VIDEO_B }, actor, false).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(stored()).toMatchObject({ heroVideoUrl: VIDEO_A });
    expect(siteContent.removeFileIfUnreferenced).not.toHaveBeenCalled();

    // Removing through PUT (null) is a replacement too
    await expect(svc.updateHero({ heroPosterUrl: null }, actor, false)).rejects.toBeInstanceOf(ForbiddenException);

    await svc.updateHero({ heroVideoUrl: VIDEO_B }, actor, true);
    expect(stored()).toMatchObject({ heroVideoUrl: VIDEO_B, heroPosterUrl: IMG_B });
    expect(siteContent.removeFileIfUnreferenced).toHaveBeenCalledWith(VIDEO_A, actor);
  });

  test('the video must be an EVENT_VIDEO upload and the poster an image upload', async () => {
    const { svc } = makeService();
    await expect(svc.updateHero({ heroVideoUrl: IMG_A }, actor, true)).rejects.toThrow(BadRequestException);
    await expect(svc.updateHero({ heroPosterUrl: VIDEO_A }, actor, true)).rejects.toThrow(BadRequestException);
    await expect(svc.updateHero({ heroVideoUrl: '/api/uploads/files/unknown_0000000000000000.mp4' }, actor, true)).rejects.toThrow(BadRequestException);
    await expect(svc.addGalleryItem({ imageUrl: VIDEO_A, kind: 'drone' }, actor)).rejects.toThrow(BadRequestException);
    // https URLs are accepted as they are
    await expect(svc.updateHero({ heroPosterUrl: 'https://cdn.example.com/poster.jpg' }, actor, true)).resolves.toMatchObject({
      heroPosterUrl: 'https://cdn.example.com/poster.jpg'
    });
  });

  test('clearHero removes the video or poster, audits and cleans up', async () => {
    const { svc, siteContent, audit, stored } = makeService();
    await svc.updateHero({ heroVideoUrl: VIDEO_A, heroPosterUrl: IMG_B }, actor, false);
    await svc.clearHero('video', actor);
    expect(stored()).toMatchObject({ heroVideoUrl: null, heroPosterUrl: IMG_B });
    expect(audit.logAction).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'REMOVE_CHAMPIONSHIP_HERO_VIDEO', beforeState: { heroVideoUrl: VIDEO_A } }));
    expect(siteContent.removeFileIfUnreferenced).toHaveBeenCalledWith(VIDEO_A, actor);
    await svc.clearHero('poster', actor);
    expect(siteContent.removeFileIfUnreferenced).toHaveBeenCalledWith(IMG_B, actor);
    // Nothing set: no write, no audit
    audit.logAction.mockClear();
    await svc.clearHero('video', actor);
    expect(audit.logAction).not.toHaveBeenCalled();
  });

  test('gallery: add, edit, publish, reorder and delete; the public view lists published photos in staff order', async () => {
    const { svc, siteContent, audit } = makeService();
    const a = (await svc.addGalleryItem({ imageUrl: IMG_A, kind: 'drone', caption: 'Drone A' }, actor)).gallery[0];
    const after = await svc.addGalleryItem({ imageUrl: IMG_B, kind: 'arena', caption: 'Arena', published: false }, actor);
    const b = after.gallery[1];
    expect(after.gallery.map((g) => g.id)).toEqual([a.id, b.id]);
    expect(audit.logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATE_CHAMPIONSHIP_GALLERY_ITEM', entityId: b.id }));

    expect((await svc.getPublic()).gallery).toEqual([{ id: a.id, imageUrl: IMG_A, caption: 'Drone A', kind: 'drone' }]);

    await svc.updateGalleryItem(b.id, { published: true, caption: 'The arena cage', kind: 'event' }, actor);
    expect(audit.logAction).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'UPDATE_CHAMPIONSHIP_GALLERY_ITEM', entityId: b.id }));
    await svc.reorderGallery({ ids: [b.id] }, actor);
    expect(audit.logAction).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'REORDER_CHAMPIONSHIP_GALLERY', afterState: [b.id, a.id] }));
    expect((await svc.getPublic()).gallery.map((g) => [g.id, g.kind, g.caption])).toEqual([
      [b.id, 'event', 'The arena cage'],
      [a.id, 'drone', 'Drone A']
    ]);

    await expect(svc.reorderGallery({ ids: [UUID_B] }, actor)).rejects.toThrow(BadRequestException);
    await expect(svc.updateGalleryItem(UUID_B, { caption: 'x' }, actor)).rejects.toThrow('Gallery photo not found');

    const deleted = await svc.deleteGalleryItem(a.id, actor);
    expect(deleted.fileDeleted).toBe(true);
    expect(deleted.gallery.map((g) => g.id)).toEqual([b.id]);
    expect(siteContent.removeFileIfUnreferenced).toHaveBeenCalledWith(IMG_A, actor);
    expect(audit.logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'DELETE_CHAMPIONSHIP_GALLERY_ITEM', entityId: a.id }));
  });

  test('a file still used by another photo of the page is not cleaned up', async () => {
    const { svc, siteContent } = makeService();
    const first = (await svc.addGalleryItem({ imageUrl: IMG_A, kind: 'drone' }, actor)).gallery[0];
    await svc.addGalleryItem({ imageUrl: IMG_A, kind: 'arena' }, actor);
    const res = await svc.deleteGalleryItem(first.id, actor);
    expect(res.fileDeleted).toBe(false);
    expect(siteContent.removeFileIfUnreferenced).not.toHaveBeenCalled();
  });

  test('the gallery holds at most 40 photos', async () => {
    const { svc } = makeService();
    for (let i = 0; i < 40; i++) await svc.addGalleryItem({ imageUrl: IMG_A, kind: 'event' }, actor);
    await expect(svc.addGalleryItem({ imageUrl: IMG_A, kind: 'event' }, actor)).rejects.toThrow('at most 40');
  });

  test('invalid bodies are 400 with field paths', async () => {
    const { svc } = makeService();
    const err = await svc.addGalleryItem({ imageUrl: IMG_A, kind: 'pilot', caption: 'x'.repeat(200) }, actor).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().message).toContain('kind');
    expect(err.getResponse().message).toContain('caption');
  });
});

describe('file cleanup: championship media counts as a reference', () => {
  function site(mediaValue: unknown) {
    const prisma: any = {
      galleryImage: { findFirst: jest.fn().mockResolvedValue(null) },
      sponsor: { findFirst: jest.fn().mockResolvedValue(null) },
      event: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      siteSetting: { findUnique: jest.fn().mockResolvedValue(mediaValue === undefined ? null : { value: mediaValue }) }
    };
    const uploads = { deleteStoredFile: jest.fn().mockResolvedValue(true) };
    const audit = { logAction: jest.fn().mockResolvedValue({}) };
    return { svc: new SiteContentService(prisma, audit as any, uploads as any), prisma, uploads, audit };
  }

  test('a URL used as hero video, poster or gallery photo is referenced; others are not', async () => {
    const media = { heroVideoUrl: VIDEO_A, heroPosterUrl: IMG_B, gallery: [{ id: UUID_A, imageUrl: IMG_A, caption: '', kind: 'drone', published: false }] };
    const { svc, prisma } = site(media);
    for (const url of [VIDEO_A, IMG_B, IMG_A]) await expect(svc.isUrlReferenced(url)).resolves.toBe(true);
    await expect(svc.isUrlReferenced(VIDEO_B)).resolves.toBe(false);
    expect(prisma.siteSetting.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { key: 'championship_media' } }));
    expect(jsonContainsString(media, IMG_A)).toBe(true);
    expect(jsonContainsString(media, IMG_A.slice(0, -2))).toBe(false);
  });

  test('removeFileIfUnreferenced keeps referenced files and deletes unreferenced ones (audited)', async () => {
    const used = site({ heroVideoUrl: VIDEO_A, heroPosterUrl: null, gallery: [] });
    await expect(used.svc.removeFileIfUnreferenced(VIDEO_A, actor)).resolves.toBe(false);
    expect(used.uploads.deleteStoredFile).not.toHaveBeenCalled();

    const unused = site(undefined);
    await expect(unused.svc.removeFileIfUnreferenced(VIDEO_A, actor)).resolves.toBe(true);
    expect(unused.uploads.deleteStoredFile).toHaveBeenCalledWith(VIDEO_A);
    expect(unused.audit.logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'DELETE_STORED_FILE', entityId: VIDEO_A }));
  });

  test('the setting key is separate from the public site settings', () => {
    expect(CHAMPIONSHIP_MEDIA_SETTING_KEY).toBe('championship_media');
    expect(Object.values(SITE_SETTING_KEYS)).not.toContain('championship_media');
  });
});

// ======================================================================================================

describe('EVENT_VIDEO uploads: purpose, magic bytes, size and scanning', () => {
  function uploadService(clamAv?: any) {
    const db = new InMemoryPrisma();
    const audit = { logAction: jest.fn().mockResolvedValue({}) };
    return { svc: new UploadsService(db as any, audit as any, clamAv), db, audit };
  }

  test('EVENT_VIDEO is a public, administrator-only purpose', () => {
    expect(UPLOAD_PURPOSES).toContain('EVENT_VIDEO');
    expect(PUBLIC_UPLOAD_PURPOSES.has('EVENT_VIDEO')).toBe(true);
    expect(ADMIN_ONLY_PURPOSES.has('EVENT_VIDEO')).toBe(true);
  });

  test('magic bytes: MP4 ftyp and WebM EBML are recognised; look-alikes are not', () => {
    expect(detectVideoMimeType(mp4())).toBe('video/mp4');
    expect(detectVideoMimeType(mp4(1024, 'mp42', ['mp42', 'isom']))).toBe('video/mp4');
    expect(detectVideoMimeType(webm())).toBe('video/webm');
    expect(detectVideoMimeType(webm('matroska'))).toBeNull(); // .mkv
    expect(detectVideoMimeType(mp4(1024, 'heic', ['mif1', 'heic']))).toBeNull(); // HEIC photo
    expect(detectVideoMimeType(mp4(1024, 'qt  ', ['qt  ']))).toBeNull(); // QuickTime .mov
    expect(detectVideoMimeType(mp4(1024, 'M4A ', ['M4A ', 'mp42']))).toBeNull(); // audio only
    expect(detectVideoMimeType(png())).toBeNull();
    expect(detectVideoMimeType(Buffer.from('ftyp is not at offset four'))).toBeNull();
  });

  test('admins upload MP4 and WebM: stored public, in plaintext, with the type extension', async () => {
    const { svc, audit } = uploadService();
    const res = await svc.processUpload(mp4(4096), 'Hero Clip.MOV', 'admin-1', UserRole.EVENT_ADMIN, 'EVENT_VIDEO');
    expect(res).toMatchObject({ mimeType: 'video/mp4', isPublic: true, sizeBytes: 4096 });
    expect(res.fileUrl).toMatch(/^\/api\/uploads\/files\/[0-9a-f-]+_[0-9a-f]{16}\.mp4$/);
    const onDisk = fs.readFileSync(path.join(process.env.STORAGE_LOCAL_DIR!, path.basename(res.fileUrl)));
    expect(onDisk.equals(mp4(4096))).toBe(true); // not re-encoded, not encrypted
    expect(audit.logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'FILE_UPLOAD', afterState: expect.objectContaining({ purpose: 'EVENT_VIDEO' }) }));
    await svc.deleteStoredFile(res.fileUrl);

    const w = await svc.processUpload(webm('webm', 2048), 'loop.webm', 'admin-1', UserRole.SUPER_ADMIN, 'EVENT_VIDEO');
    expect(w).toMatchObject({ mimeType: 'video/webm', isPublic: true });
    expect(w.fileUrl.endsWith('.webm')).toBe(true);
    await svc.deleteStoredFile(w.fileUrl);
  });

  test('captains, judges and inspectors cannot upload videos', async () => {
    const { svc, db } = uploadService();
    for (const role of [UserRole.TEAM_CAPTAIN, UserRole.JUDGE, UserRole.INSPECTOR]) {
      await expect(svc.processUpload(mp4(), 'a.mp4', 'u-1', role, 'EVENT_VIDEO')).rejects.toThrow(ForbiddenException);
    }
    expect(db.rows('MediaAsset')).toHaveLength(0);
  });

  test('renamed non-videos are refused; videos are refused for every other purpose', async () => {
    const { svc, db } = uploadService();
    await expect(svc.processUpload(png(), 'clip.mp4', 'admin-1', UserRole.EVENT_ADMIN, 'EVENT_VIDEO')).rejects.toThrow(/not permitted/);
    await expect(svc.processUpload(PDF, 'clip.webm', 'admin-1', UserRole.EVENT_ADMIN, 'EVENT_VIDEO')).rejects.toThrow(/not permitted/);
    await expect(svc.processUpload(Buffer.from('#!/bin/sh\necho owned\n'.repeat(10)), 'clip.mp4', 'admin-1', UserRole.EVENT_ADMIN, 'EVENT_VIDEO')).rejects.toThrow(/Magic-byte/);
    await expect(svc.processUpload(webm('matroska'), 'clip.webm', 'admin-1', UserRole.EVENT_ADMIN, 'EVENT_VIDEO')).rejects.toThrow(BadRequestException);
    for (const purpose of ['SITE_IMAGE', 'GALLERY_IMAGE', 'CMS_MEDIA', 'DOCUMENT']) {
      await expect(svc.processUpload(mp4(), 'clip.mp4', 'admin-1', UserRole.EVENT_ADMIN, purpose)).rejects.toThrow(BadRequestException);
    }
    expect(db.rows('MediaAsset')).toHaveLength(0);
    // The default allow-list (documents) never includes video
    expect(() => validateUploadedBuffer(mp4(), 'a.mp4')).toThrow(/not permitted/);
  });

  test('size limit: 60 MB by default, UPLOAD_VIDEO_MAX_MB overrides', async () => {
    expect(withEnv({ UPLOAD_VIDEO_MAX_MB: undefined }, () => videoUploadMaxBytes())).toBe(60 * MB);
    expect(withEnv({ UPLOAD_VIDEO_MAX_MB: '80' }, () => videoUploadMaxBytes())).toBe(80 * MB);
    expect(withEnv({ UPLOAD_VIDEO_MAX_MB: 'abc' }, () => videoUploadMaxBytes())).toBe(60 * MB);
    const { svc, db } = uploadService();
    await withEnv({ UPLOAD_VIDEO_MAX_MB: '1' }, async () => {
      await expect(svc.processUpload(mp4(MB + 1), 'big.mp4', 'admin-1', UserRole.EVENT_ADMIN, 'EVENT_VIDEO')).rejects.toThrow(/exceeds maximum allowed limit of 1.00 MB/);
    });
    expect(db.rows('MediaAsset')).toHaveLength(0);
  });

  test('every video is malware-scanned; infected files are refused and a scanner outage fails closed', async () => {
    const infected = { scan: jest.fn().mockResolvedValue({ status: 'infected', signature: 'Test.Sig' }) };
    const a = uploadService(infected);
    const err = await a.svc.processUpload(mp4(), 'a.mp4', 'admin-1', UserRole.EVENT_ADMIN, 'EVENT_VIDEO').catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(422);
    expect(infected.scan).toHaveBeenCalledWith(mp4());
    expect(a.db.rows('MediaAsset')).toHaveLength(0);

    // Real scanner client, clamd unreachable, CLAMAV_REQUIRED=true: 503
    const b = uploadService();
    await withEnv({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: '1', CLAMAV_REQUIRED: 'true', CLAMAV_TIMEOUT_MS: '2000' }, async () => {
      const outage = await b.svc.processUpload(mp4(), 'a.mp4', 'admin-1', UserRole.EVENT_ADMIN, 'EVENT_VIDEO').catch((e) => e);
      expect(outage).toBeInstanceOf(HttpException);
      expect(outage.getStatus()).toBe(503);
    });
    expect(b.db.rows('MediaAsset')).toHaveLength(0);
  });

  test('multipart limit: 25 MB, raised only for an administrator uploading EVENT_VIDEO', () => {
    const req = (role: string, purpose?: string) => ({ user: { role }, query: purpose ? { purpose } : {} });
    expect(streamUploadLimit(req('EVENT_ADMIN', 'EVENT_VIDEO'))).toBe(60 * MB);
    expect(streamUploadLimit(req('SUPER_ADMIN', 'EVENT_VIDEO'))).toBe(60 * MB);
    expect(streamUploadLimit(req('TEAM_CAPTAIN', 'EVENT_VIDEO'))).toBe(25 * MB);
    expect(streamUploadLimit(req('EVENT_ADMIN', 'SITE_IMAGE'))).toBe(25 * MB);
    expect(streamUploadLimit(req('EVENT_ADMIN'))).toBe(25 * MB);
    expect(streamUploadLimit({ user: { role: 'EVENT_ADMIN' }, query: { purpose: ['EVENT_VIDEO'] } })).toBe(25 * MB);
  });

  test('Range header parsing', () => {
    expect(parseByteRange(undefined, 100)).toBeNull();
    expect(parseByteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=50-5000', 100)).toEqual({ start: 50, end: 99 });
    expect(parseByteRange('bytes=0-1, 5-6', 100)).toBeNull(); // multi-range: whole file
    expect(parseByteRange('items=0-1', 100)).toBeNull(); // other unit: whole file
    for (const bad of ['bytes=100-', 'bytes=9-1', 'bytes=abc', 'bytes=-', 'bytes=-0', 'bytes=1e3-']) {
      expect({ bad, r: parseByteRange(bad, 100) }).toEqual({ bad, r: 'unsatisfiable' });
    }
  });
});

// ======================================================================================================

class HeaderStrategy extends PassportStrategyBase {
  name = 'jwt';
  authenticate(req: any) {
    const raw = req.headers['x-test-user'];
    if (!raw) return (this as any).fail(401);
    return (this as any).success(JSON.parse(String(raw)));
  }
}

@Injectable()
class TestJwtStrategy extends PassportStrategy(HeaderStrategy, 'jwt') {
  validate(user: unknown) {
    return user;
  }
}

describe('championship media over HTTP (real guards, in-memory database)', () => {
  // Real HTTP uploads (up to 27 MB) stay well inside this even when the whole suite runs in parallel
  jest.setTimeout(120_000);
  let app: INestApplication;
  let base: string;
  const db = new InMemoryPrisma();
  const audit = { logAction: jest.fn().mockResolvedValue({}) };
  const savedEnv: Record<string, string | undefined> = {};
  const uploaded: string[] = [];

  const now = () => new Date().toISOString();
  const users = {
    admin: { id: 'u-admin', email: 'event.admin@example.test', role: 'EVENT_ADMIN', aud: 'gcdis-admin', stepUpAt: null as string | null },
    adminStepUp: () => ({ id: 'u-admin', email: 'event.admin@example.test', role: 'EVENT_ADMIN', aud: 'gcdis-admin', stepUpAt: now() }),
    superStepUp: () => ({ id: 'u-super', email: 'super@example.test', role: 'SUPER_ADMIN', aud: 'gcdis-admin', stepUpAt: now() }),
    judge: { id: 'u-judge', email: 'judge@example.test', role: 'JUDGE', aud: 'gcdis-admin', stepUpAt: now() },
    inspector: { id: 'u-insp', email: 'inspector@example.test', role: 'INSPECTOR', aud: 'gcdis-admin', stepUpAt: now() },
    captain: { id: 'u-captain', email: 'captain@example.test', role: 'TEAM_CAPTAIN', aud: 'gcdis-public', emailVerified: true }
  };

  const call = async (
    method: string,
    url: string,
    opts: { user?: object; body?: unknown; origin?: string; form?: FormData; headers?: Record<string, string> } = {}
  ) => {
    const headers: Record<string, string> = { origin: opts.origin ?? 'http://localhost:3001', ...(opts.headers || {}) };
    if (!opts.form) headers['content-type'] = 'application/json';
    if (opts.user) headers['x-test-user'] = JSON.stringify(opts.user);
    const res = await fetch(`${base}/api${url}`, {
      method,
      headers,
      body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body))
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let json: any = null;
    try {
      json = JSON.parse(buf.toString('utf-8'));
    } catch {
      json = null;
    }
    return { status: res.status, json, buf, headers: res.headers };
  };

  const upload = async (user: object, file: Buffer, name: string, purpose: string, opts: { query?: string } = {}) => {
    const form = new FormData();
    form.append('purpose', purpose);
    form.append('file', new Blob([new Uint8Array(file)]), name);
    const res = await call('POST', `/uploads/stream${opts.query === undefined ? `?purpose=${purpose}` : opts.query}`, { user, form });
    if (res.status === 201 && res.json?.fileUrl) uploaded.push(res.json.fileUrl);
    return res;
  };

  const fileOnDisk = (url: string) => fs.existsSync(path.join(process.env.STORAGE_LOCAL_DIR!, path.basename(url)));

  beforeAll(async () => {
    for (const k of ['UPLOAD_SIGNING_SECRET', 'JWT_SECRET', 'CLAMAV_HOST', 'UPLOAD_VIDEO_MAX_MB']) savedEnv[k] = process.env[k];
    process.env.UPLOAD_SIGNING_SECRET = process.env.UPLOAD_SIGNING_SECRET || 'test-upload-signing-secret-for-championship-media';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-championship-media-spec-only';
    process.env.CLAMAV_HOST = '';
    delete process.env.UPLOAD_VIDEO_MAX_MB;

    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [ChampionshipMediaController, UploadsController],
      providers: [
        TestJwtStrategy,
        { provide: PrismaService, useValue: db },
        { provide: AuditService, useValue: audit },
        UploadsService,
        SiteContentService,
        ChampionshipMediaService,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard }
      ]
    })
      .overrideGuard(AccountIpRateLimiterGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  });

  afterAll(async () => {
    await app?.close();
    for (const url of uploaded) {
      try {
        fs.unlinkSync(path.join(process.env.STORAGE_LOCAL_DIR!, path.basename(url)));
      } catch {
        // already removed by the cleanup under test
      }
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('guards on every admin route: roles, CSRF on writes, step-up on deletions', () => {
    const proto = ChampionshipMediaController.prototype as any;
    const guardsOf = (name: string) => (Reflect.getMetadata(GUARDS_METADATA, proto[name]) || []) as any[];
    const admin = [
      'getChampionshipMedia',
      'updateChampionshipHero',
      'removeChampionshipHeroVideo',
      'removeChampionshipHeroPoster',
      'addChampionshipGalleryItem',
      'reorderChampionshipGallery',
      'updateChampionshipGalleryItem',
      'deleteChampionshipGalleryItem'
    ];
    for (const name of admin) {
      expect(guardsOf(name)).toEqual(expect.arrayContaining([RolesGuard]));
      expect(Reflect.getMetadata(ROLES_KEY, proto[name])).toEqual(['SUPER_ADMIN', 'EVENT_ADMIN']);
    }
    for (const name of admin.slice(1)) expect(guardsOf(name)).toEqual(expect.arrayContaining([CsrfGuard]));
    for (const name of ['removeChampionshipHeroVideo', 'removeChampionshipHeroPoster', 'deleteChampionshipGalleryItem']) {
      expect(guardsOf(name)).toEqual(expect.arrayContaining([StepUpGuard]));
    }
  });

  test('public endpoint: anonymous, cached about 30 s, empty defaults (never a 404)', async () => {
    const res = await call('GET', '/cms/public/championship-media');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age=30');
    expect(res.json).toEqual({ heroVideoUrl: null, heroPosterUrl: null, gallery: [], sections: {} });
  });

  test('anonymous visitors, captains, judges and inspectors are denied every staff route', async () => {
    const routes: Array<[string, string, unknown]> = [
      ['GET', '/cms/admin/championship-media', undefined],
      ['PUT', '/cms/admin/championship-media/hero', { heroPosterUrl: null }],
      ['DELETE', '/cms/admin/championship-media/hero/video', undefined],
      ['DELETE', '/cms/admin/championship-media/hero/poster', undefined],
      ['POST', '/cms/admin/championship-media/gallery', { imageUrl: IMG_A, kind: 'drone' }],
      ['PUT', '/cms/admin/championship-media/gallery/order', { ids: [UUID_A] }],
      ['PATCH', `/cms/admin/championship-media/gallery/${UUID_A}`, { published: false }],
      ['DELETE', `/cms/admin/championship-media/gallery/${UUID_A}`, undefined]
    ];
    for (const [method, url, body] of routes) {
      expect({ method, url, s: (await call(method, url, { body })).status }).toEqual({ method, url, s: 401 });
      for (const who of ['captain', 'judge', 'inspector'] as const) {
        expect({ who, method, url, s: (await call(method, url, { body, user: users[who] })).status }).toEqual({ who, method, url, s: 403 });
      }
    }
    expect(db.rows('SiteSetting')).toHaveLength(0);
  });

  test('uploads: captains cannot upload videos; a renamed non-video is refused', async () => {
    expect((await upload(users.captain, mp4(), 'a.mp4', 'EVENT_VIDEO')).status).toBe(403);
    const renamed = await upload(users.admin, png(), 'clip.mp4', 'EVENT_VIDEO');
    expect(renamed.status).toBe(400);
    const mismatch = await upload(users.admin, mp4(), 'clip.mp4', 'SITE_IMAGE', { query: '?purpose=EVENT_VIDEO' });
    expect(mismatch.status).toBe(400);
    expect(db.rows('MediaAsset')).toHaveLength(0);
  });

  test('uploads: files over 25 MB pass only as EVENT_VIDEO (query purpose), up to the video limit', async () => {
    const big = mp4(26 * MB);
    // Form purpose only (no URL purpose): the multipart limit stays 25 MB
    expect((await upload(users.admin, big, 'big.mp4', 'EVENT_VIDEO', { query: '' })).status).toBe(413);
    // Other purposes keep 25 MB
    expect((await upload(users.admin, big, 'big.pdf', 'DOCUMENT')).status).toBe(413);
    // Administrator, EVENT_VIDEO on the URL: accepted
    const ok = await upload(users.admin, big, 'big.mp4', 'EVENT_VIDEO');
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ mimeType: 'video/mp4', isPublic: true });
    // Above UPLOAD_VIDEO_MAX_MB: refused by multer before the body is kept
    process.env.UPLOAD_VIDEO_MAX_MB = '26';
    try {
      expect((await upload(users.admin, mp4(27 * MB), 'huge.mp4', 'EVENT_VIDEO')).status).toBe(413);
    } finally {
      delete process.env.UPLOAD_VIDEO_MAX_MB;
    }
    // Clean up the large test file through the regular path
    await app.get(UploadsService).deleteStoredFile(ok.json.fileUrl);
  });

  let video1 = '';
  let video2 = '';
  let poster = '';
  const VIDEO_SIZE = 3000;

  test('staff set the hero video and poster; the public endpoint returns them', async () => {
    const v = await upload(users.admin, mp4(VIDEO_SIZE), 'hero.mp4', 'EVENT_VIDEO');
    expect(v.status).toBe(201);
    video1 = v.json.fileUrl;
    const p = await upload(users.admin, png(16, 9), 'poster.png', 'SITE_IMAGE');
    expect(p.status).toBe(201);
    poster = p.json.fileUrl;

    // CSRF: foreign origin refused
    expect((await call('PUT', '/cms/admin/championship-media/hero', { user: users.admin, origin: 'https://evil.example', body: { heroVideoUrl: video1 } })).status).toBe(403);

    const set = await call('PUT', '/cms/admin/championship-media/hero', { user: users.admin, body: { heroVideoUrl: video1, heroPosterUrl: poster } });
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ heroVideoUrl: video1, heroPosterUrl: poster, gallery: [] });
    expect(audit.logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'UPDATE_CHAMPIONSHIP_HERO_MEDIA', actorId: 'u-admin', actorEmail: 'event.admin@example.test' }));

    const pub = await call('GET', '/cms/public/championship-media');
    expect(pub.json).toEqual({ heroVideoUrl: video1, heroPosterUrl: poster, gallery: [], sections: {} });

    // zod validation over HTTP
    const bad = await call('PUT', '/cms/admin/championship-media/hero', { user: users.admin, body: { heroVideoUrl: 'javascript:alert(1)', extra: 1 } });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toContain('heroVideoUrl');
  });

  test('Range requests on the public video: 206 with the right headers, 416 for an invalid range', async () => {
    const key = path.basename(video1);
    const full = await call('GET', `/uploads/files/${key}`);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('content-length')).toBe(String(VIDEO_SIZE));
    expect(full.headers.get('content-type')).toBe('video/mp4');
    expect(full.buf.equals(mp4(VIDEO_SIZE))).toBe(true);

    const part = await call('GET', `/uploads/files/${key}`, { headers: { range: 'bytes=0-1' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-1/${VIDEO_SIZE}`);
    expect(part.headers.get('content-length')).toBe('2');
    expect(part.headers.get('accept-ranges')).toBe('bytes');
    expect(part.headers.get('content-type')).toBe('video/mp4');
    expect(part.headers.get('x-content-type-options')).toBe('nosniff');
    expect(part.headers.get('cache-control')).toBe('public, max-age=86400, immutable');
    expect(part.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(part.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(part.buf.equals(mp4(VIDEO_SIZE).subarray(0, 2))).toBe(true);

    const tail = await call('GET', `/uploads/files/${key}`, { headers: { range: 'bytes=-100' } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get('content-range')).toBe(`bytes ${VIDEO_SIZE - 100}-${VIDEO_SIZE - 1}/${VIDEO_SIZE}`);
    expect(tail.buf.equals(mp4(VIDEO_SIZE).subarray(VIDEO_SIZE - 100))).toBe(true);

    const mid = await call('GET', `/uploads/files/${key}`, { headers: { range: 'bytes=1000-1999' } });
    expect(mid.status).toBe(206);
    expect(mid.buf.equals(mp4(VIDEO_SIZE).subarray(1000, 2000))).toBe(true);

    for (const range of [`bytes=${VIDEO_SIZE}-`, 'bytes=50-10', 'bytes=abc']) {
      const bad = await call('GET', `/uploads/files/${key}`, { headers: { range } });
      expect({ range, status: bad.status }).toEqual({ range, status: 416 });
      expect(bad.headers.get('content-range')).toBe(`bytes */${VIDEO_SIZE}`);
    }
  });

  test('images and private files keep their behaviour (no ranges; signed token and decryption for private files)', async () => {
    const img = await call('GET', `/uploads/files/${path.basename(poster)}`, { headers: { range: 'bytes=0-1' } });
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('content-range')).toBeNull();
    expect(img.headers.get('cache-control')).toBe('public, max-age=86400, immutable');

    const doc = await upload(users.captain, PDF, 'insurance.pdf', 'DOCUMENT');
    expect(doc.status).toBe(201);
    expect(doc.json.isPublic).toBe(false);
    const key = path.basename(doc.json.fileUrl);
    // Stored encrypted
    expect(fs.readFileSync(path.join(process.env.STORAGE_LOCAL_DIR!, key)).includes(PDF)).toBe(false);
    expect((await call('GET', `/uploads/files/${key}`, { headers: { range: 'bytes=0-1' } })).status).toBe(403);
    const signed = await app.get(UploadsService).generateSignedUrl(doc.json.assetId, users.captain.id, 'TEAM_CAPTAIN');
    const res = await call('GET', signed.url.replace(/^\/api/, ''), { headers: { range: 'bytes=0-1' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('accept-ranges')).toBeNull();
    expect(res.buf.equals(PDF)).toBe(true);
    await app.get(UploadsService).deleteStoredFile(doc.json.fileUrl);
  });

  test('replacing the video needs a step-up; afterwards the old file is deleted', async () => {
    const v = await upload(users.admin, webm('webm', 1500), 'hero2.webm', 'EVENT_VIDEO');
    expect(v.status).toBe(201);
    video2 = v.json.fileUrl;

    const without = await call('PUT', '/cms/admin/championship-media/hero', { user: users.admin, body: { heroVideoUrl: video2 } });
    expect(without.status).toBe(403);
    expect(without.json.code).toBe('STEP_UP_REQUIRED');
    expect(fileOnDisk(video1)).toBe(true);

    const withStepUp = await call('PUT', '/cms/admin/championship-media/hero', { user: users.adminStepUp(), body: { heroVideoUrl: video2 } });
    expect(withStepUp.status).toBe(200);
    expect(withStepUp.json.heroVideoUrl).toBe(video2);
    expect(fileOnDisk(video1)).toBe(false);
    expect(db.rows('MediaAsset').some((a) => a.fileUrl === video1)).toBe(false);
    expect(audit.logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'DELETE_STORED_FILE', entityId: video1 }));

    // The WebM is served with ranges too
    const part = await call('GET', `/uploads/files/${path.basename(video2)}`, { headers: { range: 'bytes=0-3' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-type')).toBe('video/webm');
    expect(part.buf.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe(true);
  });

  test('gallery over HTTP: add several, caption / kind, publish, reorder; delete needs a step-up and removes the file', async () => {
    const ids: string[] = [];
    const files: string[] = [];
    for (const [i, kind] of (['drone', 'arena', 'event'] as const).entries()) {
      const up = await upload(users.admin, png(8 + i, 6), `photo-${i}.png`, 'GALLERY_IMAGE');
      expect(up.status).toBe(201);
      files.push(up.json.fileUrl);
      const res = await call('POST', '/cms/admin/championship-media/gallery', {
        user: users.admin,
        body: { imageUrl: up.json.fileUrl, kind, caption: `Photo ${i}`, published: i !== 2 }
      });
      expect(res.status).toBe(201);
      ids.push(res.json.gallery[res.json.gallery.length - 1].id);
    }
    let pub = await call('GET', '/cms/public/championship-media');
    expect(pub.json.gallery.map((g: any) => g.id)).toEqual([ids[0], ids[1]]);
    expect(Object.keys(pub.json.gallery[0]).sort()).toEqual(['caption', 'id', 'imageUrl', 'kind']);

    expect((await call('POST', '/cms/admin/championship-media/gallery', { user: users.admin, body: { imageUrl: files[0], kind: 'pilots' } })).status).toBe(400);
    expect((await call('PATCH', `/cms/admin/championship-media/gallery/not-a-uuid`, { user: users.admin, body: { published: true } })).status).toBe(400);

    expect((await call('PATCH', `/cms/admin/championship-media/gallery/${ids[2]}`, { user: users.admin, body: { published: true, caption: 'Finals' } })).status).toBe(200);
    expect((await call('PUT', '/cms/admin/championship-media/gallery/order', { user: users.admin, body: { ids: [ids[2], ids[0]] } })).status).toBe(200);
    pub = await call('GET', '/cms/public/championship-media');
    expect(pub.json.gallery.map((g: any) => [g.id, g.caption])).toEqual([
      [ids[2], 'Finals'],
      [ids[0], 'Photo 0'],
      [ids[1], 'Photo 1']
    ]);

    const noStepUp = await call('DELETE', `/cms/admin/championship-media/gallery/${ids[0]}`, { user: users.admin });
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.json.code).toBe('STEP_UP_REQUIRED');
    expect(fileOnDisk(files[0])).toBe(true);

    const del = await call('DELETE', `/cms/admin/championship-media/gallery/${ids[0]}`, { user: users.superStepUp() });
    expect(del.status).toBe(200);
    expect(del.json.fileDeleted).toBe(true);
    expect(fileOnDisk(files[0])).toBe(false);
    expect(audit.logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'DELETE_CHAMPIONSHIP_GALLERY_ITEM', entityId: ids[0], actorId: 'u-super' }));
    expect((await call('DELETE', `/cms/admin/championship-media/gallery/${ids[0]}`, { user: users.superStepUp() })).status).toBe(404);
  });

  test('removing the video and poster needs a step-up and deletes the files', async () => {
    for (const [field, url] of [
      ['video', video2],
      ['poster', poster]
    ] as const) {
      const without = await call('DELETE', `/cms/admin/championship-media/hero/${field}`, { user: users.admin });
      expect(without.status).toBe(403);
      expect(without.json.code).toBe('STEP_UP_REQUIRED');
      const ok = await call('DELETE', `/cms/admin/championship-media/hero/${field}`, { user: users.adminStepUp() });
      expect(ok.status).toBe(200);
      expect(fileOnDisk(url)).toBe(false);
    }
    const pub = await call('GET', '/cms/public/championship-media');
    expect(pub.json.heroVideoUrl).toBeNull();
    expect(pub.json.heroPosterUrl).toBeNull();
  });
});

// ======================================================================================================

describe('infrastructure and staff console', () => {
  test('nginx: 64M only on /api/uploads/stream; 25M stays on /api/uploads', () => {
    const nginx = read('infra/nginx/nginx.conf');
    const block = nginx.slice(nginx.indexOf('location = /api/uploads/stream {'), nginx.indexOf('}', nginx.indexOf('location = /api/uploads/stream {')));
    expect(block).toContain('client_max_body_size 64M;');
    expect(block).toContain('proxy_pass http://gcdis-api:4000;');
    expect((nginx.match(/client_max_body_size 64M;/g) || []).length).toBe(1);
    expect((nginx.match(/client_max_body_size 25M;/g) || []).length).toBe(1);
  });

  test('clamd scans a maximum-size video instead of rejecting it', () => {
    const conf = read('infra/clamav/clamd.conf');
    const mb = (name: string) => Number(new RegExp(`^${name} (\\d+)M$`, 'm').exec(conf)?.[1]);
    expect(mb('StreamMaxLength')).toBeGreaterThanOrEqual(64);
    expect(mb('MaxFileSize')).toBeGreaterThanOrEqual(64);
    expect(mb('MaxScanSize')).toBeGreaterThanOrEqual(mb('MaxFileSize'));
  });

  test('UPLOAD_VIDEO_MAX_MB is documented in both .env examples, compose and the production checklist', () => {
    expect(read('.env.example')).toMatch(/^UPLOAD_VIDEO_MAX_MB=60$/m);
    expect(read('apps/api/.env.example')).toMatch(/^UPLOAD_VIDEO_MAX_MB=60$/m);
    expect(read('docker-compose.prod.yml')).toContain('- UPLOAD_VIDEO_MAX_MB=${UPLOAD_VIDEO_MAX_MB:-60}');
    expect(read('docs/security/production-checklist.md')).toContain('UPLOAD_VIDEO_MAX_MB');
  });

  test('admin CSP allows video previews from the console and the API origin', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildContentSecurityPolicy } = require('../apps/admin/src/lib/csp');
    const policy: string = buildContentSecurityPolicy('bm9uY2U=');
    const media = policy.split('; ').find((d) => d.startsWith('media-src '))!;
    expect(media.split(' ')).toEqual(expect.arrayContaining(["'self'", 'http://localhost:4000']));
    expect(media).not.toContain('*');
  });

  test('console: Championship Page tab in the Website group for SUPER_ADMIN / EVENT_ADMIN', () => {
    const page = read('apps/admin/src/app/page.tsx');
    expect(page).toMatch(/\{ id: 'championship_media', label: 'Championship Page', [^}]*group: 'website'/);
    expect(page).toContain("activeTab === 'championship_media' && <ChampionshipMediaTab");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { canOpenTab, validateVideoFile } = require('../apps/admin/src/app/_components/contentTypes');
    expect(canOpenTab('championship_media', 'SUPER_ADMIN')).toBe(true);
    expect(canOpenTab('championship_media', 'EVENT_ADMIN')).toBe(true);
    for (const role of ['JUDGE', 'INSPECTOR', 'TEAM_CAPTAIN', undefined]) expect(canOpenTab('championship_media', role)).toBe(false);
    expect(validateVideoFile({ name: 'a.mp4', type: 'video/mp4', size: 10 * MB })).toBeNull();
    expect(validateVideoFile({ name: 'a.webm', type: 'video/webm', size: 10 * MB })).toBeNull();
    expect(validateVideoFile({ name: 'a.mov', type: 'video/quicktime', size: MB })).toMatch(/not a supported video/);
    expect(validateVideoFile({ name: 'a.mp4', type: 'video/mp4', size: 61 * MB })).toMatch(/largest accepted video is 60 MB/);
  });

  test('console tab: progress bar, video preview, step-up removals, guidance note, gallery controls', () => {
    const tab = read('apps/admin/src/app/_components/ChampionshipMediaTab.tsx');
    expect(tab).toContain("uploadAdminFile(file, 'EVENT_VIDEO'");
    expect(tab).toContain('role="progressbar"');
    expect(tab).toMatch(/<video[\s\S]*?muted[\s\S]*?playsInline/);
    expect(tab).toContain('10 to 30 seconds');
    expect(tab).toContain('1920 × 1080');
    expect(tab).toContain('No audio is needed');
    expect(tab).toContain('<ImageUploadField');
    expect(tab).toContain('ReorderButtons');
    expect(tab).toContain('ConfirmDialog');
    expect(tab).toMatch(/method: 'DELETE'/);
    const client = read('apps/admin/src/lib/api-client.ts');
    expect(client).toContain('/uploads/stream?purpose=${encodeURIComponent(purpose)}');
  });

  test('new files use LF line endings', () => {
    for (const f of [
      'apps/api/src/cms/championship-media.controller.ts',
      'apps/api/src/cms/championship-media.service.ts',
      'apps/api/src/cms/dto/championship-media.schema.ts',
      'apps/admin/src/app/_components/ChampionshipMediaTab.tsx',
      'tests/championship-media.spec.ts'
    ]) {
      expect({ f, crlf: read(f).includes('\r') }).toEqual({ f, crlf: false });
    }
  });
});

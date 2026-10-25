import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { BadRequestException, ForbiddenException, INestApplication, Injectable, NotFoundException, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { Strategy as PassportStrategyBase } from 'passport-strategy';
import { InMemoryPrisma } from './support/in-memory-prisma';
import { ChampionshipMediaController } from '../apps/api/src/cms/championship-media.controller';
import { ChampionshipMediaService, sectionUrls } from '../apps/api/src/cms/championship-media.service';
import {
  CHAMPIONSHIP_SECTION_ITEMS,
  CHAMPIONSHIP_SECTION_KEYS,
  ChampionshipMediaSchema,
  UpdateChampionshipSectionMediaSchema
} from '../apps/api/src/cms/dto/championship-media.schema';
import { SiteContentService } from '../apps/api/src/cms/site-content.service';
import { CHAMPIONSHIP_MEDIA_SETTING_KEY } from '../apps/api/src/cms/site-content.defaults';
import { UploadsController } from '../apps/api/src/uploads/uploads.controller';
import { UploadsService } from '../apps/api/src/uploads/uploads.service';
import { PrismaService } from '../apps/api/src/prisma/prisma.service';
import { AuditService } from '../apps/api/src/audit/audit.service';
import { JwtAuthGuard } from '../apps/api/src/auth/jwt-auth.guard';
import { RolesGuard } from '../apps/api/src/auth/roles.guard';
import { StepUpGuard } from '../apps/api/src/auth/step-up.guard';
import { CsrfGuard } from '../apps/api/src/common/guards/csrf.guard';
import { AccountIpRateLimiterGuard } from '../apps/api/src/common/guards/rate-limiter.guard';
import { ROLES_KEY } from '../apps/api/src/auth/roles.decorator';

/**
 * Championship page section media: an independent image and video for every section of the page and for the
 * D20 / D40 category cards, the two programme days and the D20 / D40 prize cards, stored in `sections` of the
 * `championship_media` setting. Schema, service rules (step-up, audit, cleanup), HTTP guards, the public
 * shape, and the web rendering contracts.
 */

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

function mp4(total = 1024): Buffer {
  const ftypBody = Buffer.concat([Buffer.from('isom', 'latin1'), Buffer.from([0, 0, 2, 0]), ...['isom', 'iso2', 'avc1', 'mp41'].map((b) => Buffer.from(b, 'latin1'))]);
  const ftyp = Buffer.alloc(8 + ftypBody.length);
  ftyp.writeUInt32BE(ftyp.length, 0);
  ftyp.write('ftyp', 4, 'latin1');
  ftypBody.copy(ftyp, 8);
  const mdatLen = Math.max(total - ftyp.length, 8);
  const mdat = Buffer.alloc(mdatLen);
  mdat.writeUInt32BE(mdatLen, 0);
  mdat.write('mdat', 4, 'latin1');
  return Buffer.concat([ftyp, mdat]);
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

const VIDEO_A = '/api/uploads/files/0b8f9c1e-1111-4222-8333-944455556666_aaaaaaaaaaaaaaaa.mp4';
const VIDEO_B = '/api/uploads/files/0b8f9c1e-1111-4222-8333-944455556666_bbbbbbbbbbbbbbbb.webm';
const IMG_A = '/api/uploads/files/0b8f9c1e-1111-4222-8333-944455556666_cccccccccccccccc.png';
const IMG_B = '/api/uploads/files/0b8f9c1e-1111-4222-8333-944455556666_dddddddddddddddd.webp';
const PRIVATE_IMG = '/api/uploads/files/0b8f9c1e-1111-4222-8333-944455556666_eeeeeeeeeeeeeeee.png';
const actor = { id: 'admin-1', email: 'event.admin@example.test', role: 'EVENT_ADMIN' };

// ======================================================================================================

describe('section media: schema', () => {
  test('the section and item whitelists', () => {
    expect([...CHAMPIONSHIP_SECTION_KEYS]).toEqual(['facts', 'takePart', 'categories', 'programme', 'prizes', 'rules', 'teams', 'scores', 'venue', 'finalCta']);
    expect(CHAMPIONSHIP_SECTION_ITEMS).toEqual({ categories: ['d20', 'd40'], programme: ['day1', 'day2'], prizes: ['d20', 'd40'] });
  });

  test('stored values without sections (earlier data) and with full sections are valid', () => {
    const base = { heroVideoUrl: null, heroPosterUrl: null, gallery: [] };
    expect(ChampionshipMediaSchema.safeParse(base).success).toBe(true);
    const full = {
      ...base,
      sections: {
        facts: { imageUrl: IMG_A, videoUrl: VIDEO_A, imageAlt: 'Arena' },
        categories: { items: { d20: { imageUrl: IMG_A }, d40: { videoUrl: VIDEO_A } } },
        programme: { imageUrl: IMG_B, items: { day1: { imageUrl: IMG_A }, day2: { imageUrl: null, videoUrl: null } } },
        prizes: { items: { d20: { imageUrl: IMG_A } } },
        finalCta: { videoUrl: VIDEO_B }
      }
    };
    expect(ChampionshipMediaSchema.safeParse(full).success).toBe(true);
  });

  test('unknown sections, items and keys are rejected (strict at every level)', () => {
    const base = { heroVideoUrl: null, heroPosterUrl: null, gallery: [] };
    for (const sections of [
      { hero: { imageUrl: IMG_A } },
      { facts: { imageUrl: IMG_A, onclick: 'x' } },
      { facts: { items: { d20: { imageUrl: IMG_A } } } },
      { categories: { items: { d30: { imageUrl: IMG_A } } } },
      { programme: { items: { day3: { imageUrl: IMG_A } } } },
      { categories: { items: { d20: { imageUrl: IMG_A, extra: 1 } } } }
    ]) {
      expect({ sections, ok: ChampionshipMediaSchema.safeParse({ ...base, sections }).success }).toEqual({ sections, ok: false });
    }
  });

  test('section media must be site uploads: no external URLs, schemes or traversal', () => {
    const ok = (v: unknown) => UpdateChampionshipSectionMediaSchema.safeParse({ imageUrl: v }).success;
    expect(ok(IMG_A)).toBe(true);
    for (const bad of [
      'https://cdn.example.com/a.jpg',
      'http://cdn.example.com/a.jpg',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      '//evil.example/a.png',
      '/api/uploads/files/../../etc/passwd',
      '/images/arena.jpg',
      'https://www.youtube.com/embed/abc'
    ]) {
      expect({ bad, ok: ok(bad) }).toEqual({ bad, ok: false });
      expect(UpdateChampionshipSectionMediaSchema.safeParse({ videoUrl: bad }).success).toBe(false);
    }
  });

  test('update bodies: need a field, empty string clears, alt text is plain text capped at 200', () => {
    expect(UpdateChampionshipSectionMediaSchema.safeParse({}).success).toBe(false);
    expect(UpdateChampionshipSectionMediaSchema.safeParse({ imageUrl: IMG_A, x: 1 }).success).toBe(false);
    const cleared = UpdateChampionshipSectionMediaSchema.safeParse({ videoUrl: '' });
    expect(cleared.success && cleared.data.videoUrl).toBeNull();
    const alt = UpdateChampionshipSectionMediaSchema.safeParse({ imageAlt: '<img src=x onerror=alert(1)>Drone <b>ball</b>' });
    expect(alt.success).toBe(true);
    if (alt.success) expect(alt.data.imageAlt).not.toMatch(/[<>]/);
    expect(UpdateChampionshipSectionMediaSchema.safeParse({ imageAlt: 'x'.repeat(200) }).success).toBe(true);
    expect(UpdateChampionshipSectionMediaSchema.safeParse({ imageAlt: 'x'.repeat(201) }).success).toBe(false);
  });
});

// ======================================================================================================

function makeService() {
  const db = new InMemoryPrisma();
  db.reset({
    MediaAsset: [
      { fileName: 'a.mp4', fileUrl: VIDEO_A, mimeType: 'video/mp4', sizeBytes: 10, purpose: 'EVENT_VIDEO', isPublic: true },
      { fileName: 'b.webm', fileUrl: VIDEO_B, mimeType: 'video/webm', sizeBytes: 10, purpose: 'EVENT_VIDEO', isPublic: true },
      { fileName: 'a.png', fileUrl: IMG_A, mimeType: 'image/png', sizeBytes: 10, purpose: 'SITE_IMAGE', isPublic: true },
      { fileName: 'b.webp', fileUrl: IMG_B, mimeType: 'image/webp', sizeBytes: 10, purpose: 'GALLERY_IMAGE', isPublic: true },
      { fileName: 'p.png', fileUrl: PRIVATE_IMG, mimeType: 'image/png', sizeBytes: 10, purpose: 'DOCUMENT', isPublic: false }
    ]
  });
  const audit = { logAction: jest.fn().mockResolvedValue({}) };
  const siteContent = { removeFileIfUnreferenced: jest.fn().mockResolvedValue(true) };
  const svc = new ChampionshipMediaService(db as any, audit as any, siteContent as any);
  const stored = () => db.rows('SiteSetting').find((r) => r.key === CHAMPIONSHIP_MEDIA_SETTING_KEY)?.value;
  return { svc, db, audit, siteContent, stored };
}

describe('section media: service', () => {
  test('public shape: sections is {} when nothing is set; the existing fields are unchanged', async () => {
    const { svc } = makeService();
    await expect(svc.getPublic()).resolves.toEqual({ heroVideoUrl: null, heroPosterUrl: null, gallery: [], sections: {} });
    const admin = await svc.getAdmin();
    expect(admin.sections).toEqual({});
    expect(admin.limits).toMatchObject({ sectionKeys: CHAMPIONSHIP_SECTION_KEYS, sectionItems: CHAMPIONSHIP_SECTION_ITEMS, imageAltMax: 200 });
  });

  test('image and video are independent; first set needs no step-up; the public map lists only slots with media', async () => {
    const { svc, audit, stored, siteContent } = makeService();
    await svc.updateSectionMedia('facts', null, { imageUrl: IMG_A, imageAlt: 'The arena' }, actor, false);
    await svc.updateSectionMedia('facts', null, { videoUrl: VIDEO_A }, actor, false);
    await svc.updateSectionMedia('categories', 'd40', { videoUrl: VIDEO_B }, actor, false);
    await svc.updateSectionMedia('programme', 'day2', { imageUrl: IMG_B }, actor, false);
    await svc.updateSectionMedia('prizes', 'd20', { imageAlt: 'Trophy' }, actor, false);
    expect(stored().sections).toEqual({
      facts: { imageUrl: IMG_A, videoUrl: VIDEO_A, imageAlt: 'The arena' },
      categories: { items: { d40: { videoUrl: VIDEO_B } } },
      programme: { items: { day2: { imageUrl: IMG_B } } },
      prizes: { items: { d20: { imageAlt: 'Trophy' } } }
    });
    expect((await svc.getPublic()).sections).toEqual({
      facts: { imageUrl: IMG_A, videoUrl: VIDEO_A, imageAlt: 'The arena' },
      categories: { items: { d40: { imageUrl: null, videoUrl: VIDEO_B, imageAlt: '' } } },
      programme: { items: { day2: { imageUrl: IMG_B, videoUrl: null, imageAlt: '' } } }
    });
    expect(audit.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE_CHAMPIONSHIP_SECTION_MEDIA',
        entityType: 'ChampionshipMedia',
        entityId: 'section:categories.d40',
        actorId: 'admin-1',
        beforeState: { imageUrl: null, videoUrl: null, imageAlt: '' },
        afterState: { imageUrl: null, videoUrl: VIDEO_B, imageAlt: '' }
      })
    );
    // The hero and gallery stay untouched
    expect(stored()).toMatchObject({ heroVideoUrl: null, heroPosterUrl: null, gallery: [] });
    expect(siteContent.removeFileIfUnreferenced).not.toHaveBeenCalled();
  });

  test('replacing or clearing through PUT needs a step-up; then the old file is cleaned up', async () => {
    const { svc, stored, siteContent } = makeService();
    await svc.updateSectionMedia('venue', null, { imageUrl: IMG_A, videoUrl: VIDEO_A }, actor, false);
    for (const body of [{ imageUrl: IMG_B }, { videoUrl: null }, { videoUrl: '' }]) {
      const err = await svc.updateSectionMedia('venue', null, body, actor, false).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    }
    expect(stored().sections.venue).toEqual({ imageUrl: IMG_A, videoUrl: VIDEO_A });
    // Alt text alone needs no step-up
    await svc.updateSectionMedia('venue', null, { imageAlt: 'Campus' }, actor, false);
    await svc.updateSectionMedia('venue', null, { imageUrl: IMG_B }, actor, true);
    expect(stored().sections.venue).toEqual({ imageUrl: IMG_B, videoUrl: VIDEO_A, imageAlt: 'Campus' });
    expect(siteContent.removeFileIfUnreferenced).toHaveBeenCalledWith(IMG_A, actor);
    expect(siteContent.removeFileIfUnreferenced).not.toHaveBeenCalledWith(VIDEO_A, actor);
  });

  test('clearSectionMedia removes one field, audits, cleans up and drops empty slots', async () => {
    const { svc, stored, audit, siteContent } = makeService();
    await svc.updateSectionMedia('categories', 'd20', { imageUrl: IMG_A, videoUrl: VIDEO_A }, actor, false);
    await svc.clearSectionMedia('categories', 'd20', 'video', actor);
    expect(stored().sections).toEqual({ categories: { items: { d20: { imageUrl: IMG_A } } } });
    expect(audit.logAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'REMOVE_CHAMPIONSHIP_SECTION_VIDEO', entityId: 'section:categories.d20', beforeState: { videoUrl: VIDEO_A } })
    );
    expect(siteContent.removeFileIfUnreferenced).toHaveBeenCalledWith(VIDEO_A, actor);
    await svc.clearSectionMedia('categories', 'd20', 'image', actor);
    expect(stored().sections).toEqual({});
    expect(audit.logAction).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'REMOVE_CHAMPIONSHIP_SECTION_IMAGE' }));
    // Nothing set: no write, no audit
    audit.logAction.mockClear();
    await svc.clearSectionMedia('categories', 'd20', 'image', actor);
    expect(audit.logAction).not.toHaveBeenCalled();
  });

  test('a file still used elsewhere on the page (hero, gallery, another section) is not cleaned up', async () => {
    const { svc, siteContent } = makeService();
    await svc.updateHero({ heroPosterUrl: IMG_A }, actor, false);
    await svc.updateSectionMedia('rules', null, { imageUrl: IMG_A }, actor, false);
    await svc.updateSectionMedia('teams', null, { videoUrl: VIDEO_A }, actor, false);
    await svc.updateSectionMedia('scores', null, { videoUrl: VIDEO_A }, actor, false);
    await svc.clearSectionMedia('rules', null, 'image', actor);
    await svc.clearSectionMedia('teams', null, 'video', actor);
    expect(siteContent.removeFileIfUnreferenced).not.toHaveBeenCalled();
    await svc.clearSectionMedia('scores', null, 'video', actor);
    expect(siteContent.removeFileIfUnreferenced).toHaveBeenCalledWith(VIDEO_A, actor);
  });

  test('uploads are checked: video must be a public EVENT_VIDEO, image a public SITE / GALLERY image', async () => {
    const { svc, stored } = makeService();
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ videoUrl: IMG_A }, 'videoUrl'],
      [{ imageUrl: VIDEO_A }, 'imageUrl'],
      [{ imageUrl: PRIVATE_IMG }, 'imageUrl'],
      [{ imageUrl: '/api/uploads/files/unknown_0000000000000000.png' }, 'imageUrl'],
      [{ imageUrl: 'https://cdn.example.com/a.jpg' }, 'imageUrl']
    ];
    for (const [body, field] of bad) {
      const err = await svc.updateSectionMedia('facts', null, body, actor, true).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(JSON.stringify(err.getResponse())).toContain(field);
    }
    expect(stored()).toBeUndefined();
  });

  test('unknown sections, items and fields are 404', async () => {
    const { svc } = makeService();
    for (const [section, item] of [
      ['hero', null],
      ['__proto__', null],
      ['facts', 'd20'],
      ['categories', 'd30'],
      ['programme', 'constructor']
    ] as const) {
      await expect(svc.updateSectionMedia(section, item, { imageUrl: IMG_A }, actor, true)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.clearSectionMedia(section, item, 'image', actor)).rejects.toBeInstanceOf(NotFoundException);
    }
    await expect(svc.clearSectionMedia('facts', null, 'poster', actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  test('sectionUrls lists every section and item file (used by cleanup)', () => {
    expect(
      sectionUrls({ facts: { imageUrl: IMG_A, videoUrl: VIDEO_A }, prizes: { items: { d40: { imageUrl: IMG_B } } }, finalCta: { videoUrl: VIDEO_B } }).sort()
    ).toEqual([IMG_A, IMG_B, VIDEO_A, VIDEO_B].sort());
    expect(sectionUrls(undefined)).toEqual([]);
  });

  test('stored section data that no longer validates falls back to the empty defaults', async () => {
    const { svc, db } = makeService();
    await (db as any).siteSetting.create({
      data: { key: CHAMPIONSHIP_MEDIA_SETTING_KEY, value: { heroVideoUrl: null, heroPosterUrl: null, gallery: [], sections: { facts: { imageUrl: 'https://evil.example/x.png' } } } }
    } as any);
    await expect(svc.getPublic()).resolves.toEqual({ heroVideoUrl: null, heroPosterUrl: null, gallery: [], sections: {} });
  });
});

describe('file cleanup: section media counts as a reference', () => {
  test('isUrlReferenced finds a URL nested in sections / items', async () => {
    const value = { heroVideoUrl: null, heroPosterUrl: null, gallery: [], sections: { programme: { items: { day1: { videoUrl: VIDEO_A } } } } };
    const prisma: any = {
      galleryImage: { findFirst: jest.fn().mockResolvedValue(null) },
      sponsor: { findFirst: jest.fn().mockResolvedValue(null) },
      event: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      siteSetting: { findUnique: jest.fn().mockResolvedValue({ value }) }
    };
    const svc = new SiteContentService(prisma, { logAction: jest.fn() } as any, { deleteStoredFile: jest.fn() } as any);
    await expect(svc.isUrlReferenced(VIDEO_A)).resolves.toBe(true);
    await expect(svc.isUrlReferenced(VIDEO_B)).resolves.toBe(false);
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

describe('section media over HTTP (real guards, in-memory database)', () => {
  jest.setTimeout(60_000);
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
    judge: { id: 'u-judge', email: 'judge@example.test', role: 'JUDGE', aud: 'gcdis-admin', stepUpAt: now() },
    inspector: { id: 'u-insp', email: 'inspector@example.test', role: 'INSPECTOR', aud: 'gcdis-admin', stepUpAt: now() },
    captain: { id: 'u-captain', email: 'captain@example.test', role: 'TEAM_CAPTAIN', aud: 'gcdis-public', emailVerified: true }
  };

  const call = async (method: string, url: string, opts: { user?: object; body?: unknown; origin?: string; form?: FormData } = {}) => {
    const headers: Record<string, string> = { origin: opts.origin ?? 'http://localhost:3001' };
    if (!opts.form) headers['content-type'] = 'application/json';
    if (opts.user) headers['x-test-user'] = JSON.stringify(opts.user);
    const res = await fetch(`${base}/api${url}`, { method, headers, body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)) });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };

  const upload = async (user: object, file: Buffer, name: string, purpose: string) => {
    const form = new FormData();
    form.append('purpose', purpose);
    form.append('file', new Blob([new Uint8Array(file)]), name);
    const res = await call('POST', `/uploads/stream?purpose=${purpose}`, { user, form });
    if (res.status === 201 && res.json?.fileUrl) uploaded.push(res.json.fileUrl);
    return res;
  };
  const fileOnDisk = (url: string) => fs.existsSync(path.join(process.env.STORAGE_LOCAL_DIR!, path.basename(url)));

  beforeAll(async () => {
    for (const k of ['UPLOAD_SIGNING_SECRET', 'JWT_SECRET', 'CLAMAV_HOST']) savedEnv[k] = process.env[k];
    process.env.UPLOAD_SIGNING_SECRET = process.env.UPLOAD_SIGNING_SECRET || 'test-upload-signing-secret-for-section-media';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-section-media-spec-only';
    process.env.CLAMAV_HOST = '';
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

  test('route guards: roles on all, CSRF on writes, step-up on removals', () => {
    const proto = ChampionshipMediaController.prototype as any;
    const guardsOf = (name: string) => (Reflect.getMetadata(GUARDS_METADATA, proto[name]) || []) as any[];
    for (const name of ['updateChampionshipSectionMedia', 'updateChampionshipSectionItemMedia', 'removeChampionshipSectionMedia', 'removeChampionshipSectionItemMedia']) {
      expect(guardsOf(name)).toEqual(expect.arrayContaining([RolesGuard, CsrfGuard]));
      expect(Reflect.getMetadata(ROLES_KEY, proto[name])).toEqual(['SUPER_ADMIN', 'EVENT_ADMIN']);
    }
    for (const name of ['removeChampionshipSectionMedia', 'removeChampionshipSectionItemMedia']) expect(guardsOf(name)).toEqual(expect.arrayContaining([StepUpGuard]));
  });

  test('anonymous visitors, captains, judges and inspectors are denied every section route', async () => {
    const routes: Array<[string, string, unknown]> = [
      ['PUT', '/cms/admin/championship-media/sections/facts', { imageAlt: 'x' }],
      ['PUT', '/cms/admin/championship-media/sections/categories/items/d20', { imageAlt: 'x' }],
      ['DELETE', '/cms/admin/championship-media/sections/facts/image', undefined],
      ['DELETE', '/cms/admin/championship-media/sections/categories/items/d20/video', undefined]
    ];
    for (const [method, url, body] of routes) {
      expect({ url, s: (await call(method, url, { body })).status }).toEqual({ url, s: 401 });
      for (const who of ['captain', 'judge', 'inspector'] as const) {
        expect({ who, url, s: (await call(method, url, { body, user: users[who] })).status }).toEqual({ who, url, s: 403 });
      }
    }
    expect(db.rows('SiteSetting')).toHaveLength(0);
  });

  test('set, replace (step-up), remove (step-up) with real uploads; files cleaned up; public shape', async () => {
    const img1 = (await upload(users.admin, png(16, 9), 'd20.png', 'SITE_IMAGE')).json.fileUrl;
    const img2 = (await upload(users.admin, png(20, 9), 'd20b.png', 'GALLERY_IMAGE')).json.fileUrl;
    const vid = (await upload(users.admin, mp4(2000), 'd20.mp4', 'EVENT_VIDEO')).json.fileUrl;
    expect([img1, img2, vid].every(Boolean)).toBe(true);

    // CSRF: a foreign origin is refused
    expect((await call('PUT', '/cms/admin/championship-media/sections/categories/items/d20', { user: users.admin, origin: 'https://evil.example', body: { imageUrl: img1 } })).status).toBe(403);

    const set = await call('PUT', '/cms/admin/championship-media/sections/categories/items/d20', { user: users.admin, body: { imageUrl: img1, videoUrl: vid, imageAlt: 'D20 drone' } });
    expect(set.status).toBe(200);
    expect(set.json.sections).toEqual({ categories: { items: { d20: { imageUrl: img1, videoUrl: vid, imageAlt: 'D20 drone' } } } });
    expect(audit.logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'UPDATE_CHAMPIONSHIP_SECTION_MEDIA', entityId: 'section:categories.d20', actorEmail: 'event.admin@example.test' }));

    let pub = await call('GET', '/cms/public/championship-media');
    expect(pub.json).toEqual({
      heroVideoUrl: null,
      heroPosterUrl: null,
      gallery: [],
      sections: { categories: { items: { d20: { imageUrl: img1, videoUrl: vid, imageAlt: 'D20 drone' } } } }
    });

    // Validation over HTTP
    expect((await call('PUT', '/cms/admin/championship-media/sections/facts', { user: users.admin, body: { imageUrl: 'https://cdn.example.com/x.jpg' } })).status).toBe(400);
    expect((await call('PUT', '/cms/admin/championship-media/sections/facts', { user: users.admin, body: { videoUrl: img1 } })).status).toBe(400);
    expect((await call('PUT', '/cms/admin/championship-media/sections/nope', { user: users.admin, body: { imageAlt: 'x' } })).status).toBe(404);
    expect((await call('PUT', '/cms/admin/championship-media/sections/facts/items/d20', { user: users.admin, body: { imageAlt: 'x' } })).status).toBe(404);

    // Replace without step-up: refused, file kept
    const without = await call('PUT', '/cms/admin/championship-media/sections/categories/items/d20', { user: users.admin, body: { imageUrl: img2 } });
    expect(without.status).toBe(403);
    expect(without.json.code).toBe('STEP_UP_REQUIRED');
    expect(fileOnDisk(img1)).toBe(true);
    const replaced = await call('PUT', '/cms/admin/championship-media/sections/categories/items/d20', { user: users.adminStepUp(), body: { imageUrl: img2 } });
    expect(replaced.status).toBe(200);
    expect(fileOnDisk(img1)).toBe(false);
    expect(audit.logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'DELETE_STORED_FILE', entityId: img1 }));

    // Remove the video: step-up required, then the file is deleted
    const noStepUp = await call('DELETE', '/cms/admin/championship-media/sections/categories/items/d20/video', { user: users.admin });
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.json.code).toBe('STEP_UP_REQUIRED');
    expect((await call('DELETE', '/cms/admin/championship-media/sections/categories/items/d20/poster', { user: users.adminStepUp() })).status).toBe(404);
    const removed = await call('DELETE', '/cms/admin/championship-media/sections/categories/items/d20/video', { user: users.adminStepUp() });
    expect(removed.status).toBe(200);
    expect(fileOnDisk(vid)).toBe(false);
    pub = await call('GET', '/cms/public/championship-media');
    expect(pub.json.sections).toEqual({ categories: { items: { d20: { imageUrl: img2, videoUrl: null, imageAlt: 'D20 drone' } } } });

    // A section's own image
    const own = await call('PUT', '/cms/admin/championship-media/sections/finalCta', { user: users.admin, body: { imageUrl: img2 } });
    expect(own.status).toBe(200);
    const clear = await call('DELETE', '/cms/admin/championship-media/sections/finalCta/image', { user: users.adminStepUp() });
    expect(clear.status).toBe(200);
    // Still used by the D20 card: kept
    expect(fileOnDisk(img2)).toBe(true);
  });
});

// ======================================================================================================

describe('section media: web rendering contracts', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const media = require('../apps/web/src/lib/championship-media') as typeof import('../apps/web/src/lib/championship-media');
  const sections = read('apps/web/src/app/events/[slug]/_components/ChampionshipSections.tsx');
  const component = read('apps/web/src/app/events/[slug]/_components/SectionMedia.tsx');
  const page = read('apps/web/src/app/events/[slug]/page.tsx');

  test('normaliseSectionMedia keeps whitelisted uploads only and re-validates every URL', () => {
    const out = media.normaliseSectionMedia({
      facts: { imageUrl: '/api/uploads/files/a_1.png', videoUrl: 'https://cdn.example.com/x.mp4', imageAlt: ' Arena ' },
      hero: { imageUrl: '/api/uploads/files/a_1.png' },
      takePart: { imageUrl: 'javascript:alert(1)', videoUrl: '//evil.example/x.mp4' },
      categories: { items: { d20: { videoUrl: '/api/uploads/files/v_1.mp4' }, d30: { imageUrl: '/api/uploads/files/a_1.png' } } },
      programme: { items: { day1: { imageUrl: '/api/uploads/files/../x' } } }
    });
    expect(Object.keys(out).sort()).toEqual(media.safeUploadUrl('/api/uploads/files/a_1.png') ? ['categories', 'facts'] : []);
    if (out.facts) {
      expect(out.facts.own).toMatchObject({ videoUrl: null, imageAlt: 'Arena' });
      expect(out.facts.own?.imageUrl).toMatch(/^https?:\/\/[^/]+\/api\/uploads\/files\/a_1\.png$/);
      expect(Object.keys(out.categories!.items)).toEqual(['d20']);
    }
    expect(media.normaliseSectionMedia(undefined)).toEqual({});
    expect(media.normaliseSectionMedia([])).toEqual({});
    expect(media.safeUploadUrl('https://cdn.example.com/a.png')).toBeNull();
    expect(media.safeUploadUrl('data:image/png;base64,AAAA')).toBeNull();
  });

  test('no media: the page passes an empty map and every slot renders nothing', () => {
    expect(media.normaliseChampionshipMedia(undefined).sections).toEqual({});
    expect(page).toContain('sectionMedia={media.sections}');
    expect(component).toContain('if (!hasMedia(media)) return null;');
    expect(sections).toContain('<SectionMediaProvider value={sectionMedia}>');
  });

  test('every section and item is wired to its media', () => {
    for (const key of ['facts', 'takePart', 'categories', 'programme', 'prizes', 'rules', 'teams', 'scores', 'venue', 'finalCta']) {
      expect(sections).toContain(`useSectionMedia('${key}')`);
    }
    expect(sections).toContain('media={media.items.d20}');
    expect(sections).toContain('media={media.items.d40}');
    expect(sections).toContain('media.items[`day${i + 1}`]');
    expect(sections).toContain('media.items[spec.id]');
    expect(sections).toContain('<MediaBackdrop media={media.own}');
  });

  test('video: muted, loop, playsInline, poster = image, plays only in view, static with reduced motion / saveData; no layout shift', () => {
    for (const attr of ['muted', 'loop', 'playsInline', 'poster={imageUrl ?? undefined}', 'IntersectionObserver', 'video.pause()', 'saveData', 'useReduce()']) {
      expect(component).toContain(attr);
    }
    expect(component).not.toContain('autoPlay');
    expect(component).toContain('aspect-[16/9]');
    expect(component).not.toMatch(/<iframe|youtube|vimeo/i);
  });

  test('console: section media panel with independent image and video controls', () => {
    const tab = read('apps/admin/src/app/_components/ChampionshipMediaTab.tsx');
    expect(tab).toContain('<SectionMediaPanel');
    expect(tab).toContain("uploadAdminFile(file, field === 'image' ? SECTION_IMAGE_PURPOSE : 'EVENT_VIDEO'");
    expect(tab).toContain('validateVideoFile(file, videoMaxBytes)');
    expect(tab).toContain('validateImageFile(file, SECTION_IMAGE_PURPOSE)');
    expect(tab).toContain('role="progressbar"');
    expect(tab).toMatch(/\/sections\/\$\{encodeURIComponent\(section\)\}/);
    for (const key of ['facts', 'takePart', 'categories', 'programme', 'prizes', 'rules', 'teams', 'scores', 'venue', 'finalCta', 'd20', 'd40', 'day1', 'day2']) {
      expect(tab).toContain(`'${key}'`);
    }
  });

  test('new and changed files use LF line endings', () => {
    for (const f of [
      'apps/api/src/cms/championship-media.controller.ts',
      'apps/api/src/cms/championship-media.service.ts',
      'apps/api/src/cms/dto/championship-media.schema.ts',
      'apps/admin/src/app/_components/ChampionshipMediaTab.tsx',
      'apps/web/src/app/events/[slug]/_components/SectionMedia.tsx',
      'apps/web/src/app/events/[slug]/_components/ChampionshipSections.tsx',
      'apps/web/src/lib/championship-media.ts',
      'tests/championship-section-media.spec.ts'
    ]) {
      expect({ f, crlf: read(f).includes('\r') }).toEqual({ f, crlf: false });
    }
  });
});

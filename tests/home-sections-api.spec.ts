import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, Injectable, INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { Strategy as PassportStrategyBase } from 'passport-strategy';
import { HomeContentController } from '../apps/api/src/cms/home-content.controller';
import {
  HomeContentService,
  collectUploadPaths,
  orderHomeSections,
  showHomePlaceholders,
  stripPlaceholders
} from '../apps/api/src/cms/home-content.service';
import {
  DEFAULT_HOME_CONTENT,
  HOME_SECTION_KEYS,
  ORDERABLE_HOME_SECTIONS,
  PINNED_HOME_SECTIONS,
  defaultHomeSectionContent
} from '../apps/api/src/cms/home-content.defaults';
import { HOME_SECTION_SCHEMAS, isSafeHref } from '../apps/api/src/cms/dto/home-content.schema';
import { SiteContentService } from '../apps/api/src/cms/site-content.service';
import { JwtAuthGuard } from '../apps/api/src/auth/jwt-auth.guard';
import { RolesGuard } from '../apps/api/src/auth/roles.guard';
import { StepUpGuard } from '../apps/api/src/auth/step-up.guard';
import { CsrfGuard } from '../apps/api/src/common/guards/csrf.guard';
import { ROLES_KEY } from '../apps/api/src/auth/roles.decorator';
import { HOME_CONTENT } from '../apps/web/src/lib/home-content';
import { linksToHiddenSection, normaliseHomePage, safeHref } from '../apps/web/src/lib/home-sections';

/**
 * Home page sections (feature): storage, strict per-section validation, public read with placeholder
 * stripping, staff toggle / reorder / edit / reset (authorisation, CSRF, step-up, audit) and image cleanup.
 */

const ROOT = path.join(__dirname, '..');
const UPLOAD_A = '/api/uploads/files/0b8f9c1e-1111-4222-8333-944455556666_aaaaaaaaaaaaaaaa.png';
const UPLOAD_B = '/api/uploads/files/0b8f9c1e-1111-4222-8333-944455556666_bbbbbbbbbbbbbbbb.webp';
const UPLOAD_UNKNOWN = '/api/uploads/files/0b8f9c1e-1111-4222-8333-944455556666_cccccccccccccccc.png';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const parse = (key: keyof typeof HOME_SECTION_SCHEMAS, value: unknown) => HOME_SECTION_SCHEMAS[key].safeParse(value);
const issuePaths = (key: keyof typeof HOME_SECTION_SCHEMAS, value: unknown): string[] => {
  const r = parse(key, value);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

/** In-memory Prisma double for the home_sections table and media assets. */
function fakePrisma() {
  const rows = new Map<string, any>();
  const assets = new Set<string>([UPLOAD_A, UPLOAD_B]);
  const prisma: any = {
    homeSection: {
      findMany: jest.fn(async () => [...rows.values()].map((r) => clone(r))),
      findUnique: jest.fn(async ({ where }: any) => (rows.has(where.key) ? clone(rows.get(where.key)) : null)),
      upsert: jest.fn(async ({ where, update, create }: any) => {
        const existing = rows.get(where.key);
        const next = existing ? { ...existing, ...update, updatedAt: new Date().toISOString() } : { ...create, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        rows.set(where.key, clone(next));
        return clone(next);
      })
    },
    mediaAsset: {
      findMany: jest.fn(async ({ where }: any) => (where.fileUrl.in as string[]).filter((u) => assets.has(u)).map((fileUrl) => ({ fileUrl })))
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops))
  };
  return { prisma, rows, assets };
}

function makeService() {
  const { prisma, rows } = fakePrisma();
  const audit = { logAction: jest.fn().mockResolvedValue({}) };
  const siteContent = { removeFileIfUnreferenced: jest.fn().mockResolvedValue(true) };
  const svc = new HomeContentService(prisma, audit as any, siteContent as any);
  return { svc, prisma, rows, audit, siteContent };
}

const actor = { id: 'admin-1', email: 'event.admin@example.test', role: 'EVENT_ADMIN' };

// ======================================================================================================

describe('home sections: defaults, schema and migration', () => {
  test('every section has a schema, and every default passes it unchanged', () => {
    expect(Object.keys(HOME_SECTION_SCHEMAS).sort()).toEqual([...HOME_SECTION_KEYS].sort());
    for (const key of HOME_SECTION_KEYS) {
      const r = parse(key, defaultHomeSectionContent(key));
      expect({ key, ok: r.success, issues: r.success ? [] : r.error.issues }).toEqual({ key, ok: true, issues: [] });
      if (r.success) expect(r.data).toEqual(DEFAULT_HOME_CONTENT[key]);
    }
  });

  test('API defaults mirror the web fallback content (no invented facts, same samples)', () => {
    for (const key of HOME_SECTION_KEYS) {
      expect({ key, value: clone(DEFAULT_HOME_CONTENT[key]) }).toEqual({ key, value: clone((HOME_CONTENT as any)[key]) });
    }
  });

  test('pinned and orderable sections', () => {
    expect(PINNED_HOME_SECTIONS).toEqual(['hero', 'ticker', 'footer']);
    expect(ORDERABLE_HOME_SECTIONS).not.toContain('hero');
    expect(ORDERABLE_HOME_SECTIONS).toHaveLength(HOME_SECTION_KEYS.length - 3);
  });

  test('schema, migration and create-only seed', () => {
    const schema = fs.readFileSync(path.join(ROOT, 'apps/api/prisma/schema.prisma'), 'utf-8');
    expect(schema).toMatch(/model HomeSection \{[\s\S]*key\s+String\s+@id[\s\S]*enabled\s+Boolean[\s\S]*sortOrder\s+Int[\s\S]*content\s+Json[\s\S]*@@map\("home_sections"\)/);
    const migration = fs.readFileSync(path.join(ROOT, 'apps/api/prisma/migrations/20261015120000_home_sections/migration.sql'), 'utf-8');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "home_sections"');
    expect(migration).toContain('"content" JSONB NOT NULL');
    const seed = fs.readFileSync(path.join(ROOT, 'apps/api/prisma/seed.ts'), 'utf-8');
    expect(seed).toMatch(/homeSection\.upsert\(\{\s*where: \{ key \},\s*update: \{\},/);
  });

  test('stored files referenced by home sections are never deleted by other cleanups', async () => {
    const queries: string[] = [];
    const prisma: any = {
      galleryImage: { findFirst: jest.fn().mockResolvedValue(null) },
      sponsor: { findFirst: jest.fn().mockResolvedValue(null) },
      event: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
        queries.push(strings.join('?'));
        return [{ n: 1 }];
      })
    };
    const site = new SiteContentService(prisma, { logAction: jest.fn() } as any, { deleteStoredFile: jest.fn() } as any);
    await expect(site.isUrlReferenced(UPLOAD_A)).resolves.toBe(true);
    expect(queries[0]).toContain('FROM "home_sections" WHERE strpos("content"::text');
  });
});

describe('home sections: content validation', () => {
  test('unknown fields are rejected at every level', () => {
    expect(issuePaths('partners', { ...DEFAULT_HOME_CONTENT.partners, extra: 'x' })).toEqual(['']);
    const about = clone(DEFAULT_HOME_CONTENT.about) as any;
    about.stats[0].onClick = 'x';
    expect(issuePaths('about', about)).toEqual(['stats.0']);
  });

  test('text is plain (markup stripped) and length-capped; required text may not be empty', () => {
    const r = parse('partners', { ...DEFAULT_HOME_CONTENT.partners, title: '<b>Partners</b><script>alert(1)</script>' });
    expect(r.success && (r.data as any).title).toBe('Partners');
    expect(issuePaths('partners', { ...DEFAULT_HOME_CONTENT.partners, title: 'x'.repeat(81) })).toEqual(['title']);
    expect(issuePaths('partners', { ...DEFAULT_HOME_CONTENT.partners, title: '   ' })).toEqual(['title']);
    expect(issuePaths('partners', { ...DEFAULT_HOME_CONTENT.partners, title: '<i></i>' })).toEqual(['title']);
    expect(issuePaths('ticker', { items: ['ok', 42] })).toEqual(['items.1']);
  });

  test('links: site paths, anchors and https only', () => {
    for (const ok of ['/portal', '/events/drone-soccer-2026#rules', '#about', 'https://example.org/x']) expect({ ok, safe: isSafeHref(ok) }).toEqual({ ok, safe: true });
    for (const bad of ['javascript:alert(1)', '//evil.example', '/\\evil.example', 'http://example.org', 'data:text/html,x', '#', 'mailto:a@b.c', '/a b']) {
      expect({ bad, safe: isSafeHref(bad) }).toEqual({ bad, safe: false });
    }
    const hero = clone(DEFAULT_HOME_CONTENT.hero) as any;
    hero.primaryCta.href = 'javascript:alert(1)';
    expect(issuePaths('hero', hero)).toEqual(['primaryCta.href']);
    const mous = clone(DEFAULT_HOME_CONTENT.mous) as any;
    mous.items[0].documentUrl = '';
    const r = parse('mous', mous);
    expect(r.success && (r.data as any).items[0].documentUrl).toBeNull(); // '' clears an optional link
  });

  test('images must be uploaded files; crops, dates, enums and numbers are checked', () => {
    const centres = clone(DEFAULT_HOME_CONTENT.centres) as any;
    centres.items[0].imageUrl = 'https://example.org/a.png';
    centres.items[1].imagePosition = '50%';
    expect(issuePaths('centres', centres)).toEqual(['items.0.imageUrl', 'items.1.imagePosition']);
    centres.items[0].imageUrl = UPLOAD_A;
    centres.items[1].imagePosition = '100% 0%';
    expect(issuePaths('centres', centres)).toEqual([]);

    const news = clone(DEFAULT_HOME_CONTENT.news) as any;
    news.items[0].date = '2026-13-01';
    news.items[1].category = 'gossip';
    news.nextEvent.endsAt = '2026-11-01T09:00:00+05:30';
    expect(issuePaths('news', news).sort()).toEqual(['items.0.date', 'items.1.category', 'nextEvent.endsAt'].sort());

    const about = clone(DEFAULT_HOME_CONTENT.about) as any;
    about.stats[0].ring = 101;
    about.stats[1].icon = 'rocket';
    expect(issuePaths('about', about).sort()).toEqual(['stats.0.ring', 'stats.1.icon']);
  });

  test('list sizes are capped and entry ids must be unique slugs', () => {
    const awards = clone(DEFAULT_HOME_CONTENT.awards) as any;
    awards.items.push({ id: 'award-5', title: 'Fifth', badge: '', detail: '' });
    expect(issuePaths('awards', awards)).toEqual(['items']);
    const services = clone(DEFAULT_HOME_CONTENT.services) as any;
    services.items[1].id = services.items[0].id;
    services.items[2].id = 'Not A Slug';
    expect(issuePaths('services', services).sort()).toEqual(['items.1.id', 'items.2.id']);
    const mission = clone(DEFAULT_HOME_CONTENT.mission) as any;
    mission.tabs = [];
    expect(issuePaths('mission', mission)).toEqual(['tabs']);
  });

  test('optional blocks may be removed (null)', () => {
    const news = clone(DEFAULT_HOME_CONTENT.news) as any;
    news.nextEvent = null;
    expect(issuePaths('news', news)).toEqual([]);
    const t = clone(DEFAULT_HOME_CONTENT.testimonials) as any;
    t.storyVideo = null;
    t.visitors = [];
    expect(issuePaths('testimonials', t)).toEqual([]);
  });
});

describe('home sections: placeholders', () => {
  test('sample entries are published outside production only (or with the explicit flag)', () => {
    expect(showHomePlaceholders({ NODE_ENV: 'development' })).toBe(true);
    expect(showHomePlaceholders({ NODE_ENV: 'test' })).toBe(true);
    expect(showHomePlaceholders({ NODE_ENV: 'production' })).toBe(false);
    expect(showHomePlaceholders({ NODE_ENV: 'production', SHOW_PLACEHOLDER_CONTENT: 'true' })).toBe(true);
  });

  test('stripPlaceholders drops sample entries and blocks without mutating its input', () => {
    const about = clone(DEFAULT_HOME_CONTENT.about);
    const before = JSON.stringify(about);
    const out: any = stripPlaceholders(about);
    expect(JSON.stringify(about)).toBe(before);
    expect(out.video).toBeNull();
    expect(out.stats.map((s: any) => s.id)).toEqual(['centres', 'training-areas', 'arena', 'prize-pool', 'classes', 'days']);
    const programmes: any = stripPlaceholders(clone(DEFAULT_HOME_CONTENT.programmes));
    expect(programmes.items.every((p: any) => p.details === null)).toBe(true);
    expect(JSON.stringify(stripPlaceholders(clone(DEFAULT_HOME_CONTENT)))).not.toContain('"placeholder":true');
  });

  test('the public endpoint strips samples in production and keeps them in development', async () => {
    const { svc } = makeService();
    const original = process.env.NODE_ENV;
    try {
      (process.env as any).NODE_ENV = 'production';
      const prod = await svc.getPublicHome();
      expect(JSON.stringify(prod)).not.toContain('"placeholder":true');
      const mous = prod.sections.find((s) => s.key === 'mous')!;
      expect((mous.content as any).items).toEqual([]);
      (process.env as any).NODE_ENV = 'development';
      const dev = await svc.getPublicHome();
      expect(((dev.sections.find((s) => s.key === 'mous')!.content as any).items as any[]).length).toBe(4);
    } finally {
      (process.env as any).NODE_ENV = original;
    }
  });
});

describe('HomeContentService', () => {
  test('lists every section with defaults, in page order', async () => {
    const { svc } = makeService();
    const list = await svc.listSections();
    expect(list.map((s) => s.key)).toEqual([...HOME_SECTION_KEYS]);
    expect(list.every((s) => s.enabled && s.isDefault)).toBe(true);
    expect(list.find((s) => s.key === 'hero')).toMatchObject({ pinned: true, canDisable: false });
    expect(list.find((s) => s.key === 'ticker')).toMatchObject({ pinned: true, canDisable: true });
    expect(list.find((s) => s.key === 'news')).toMatchObject({ pinned: false, canDisable: true, anchor: 'news' });
  });

  test('toggle: a disabled section disappears from the public response; audited', async () => {
    const { svc, audit } = makeService();
    const view = await svc.updateSection('news', { enabled: false }, actor);
    expect(view.enabled).toBe(false);
    expect(view.content).toEqual(DEFAULT_HOME_CONTENT.news);
    const pub = await svc.getPublicHome();
    expect(pub.sections.map((s) => s.key)).not.toContain('news');
    expect(audit.logAction.mock.calls[0][0]).toMatchObject({ action: 'DISABLE_HOME_SECTION', entityType: 'HomeSection', entityId: 'news', actorId: 'admin-1' });
    await svc.updateSection('news', { enabled: true }, actor);
    expect((await svc.getPublicHome()).sections.map((s) => s.key)).toContain('news');
    expect(audit.logAction.mock.calls[1][0].action).toBe('ENABLE_HOME_SECTION');
  });

  test('the hero and the footer cannot be hidden; unknown sections are 404; empty bodies are 400', async () => {
    const { svc } = makeService();
    await expect(svc.updateSection('hero', { enabled: false }, actor)).rejects.toThrow(BadRequestException);
    await expect(svc.updateSection('footer', { enabled: false }, actor)).rejects.toThrow(BadRequestException);
    await expect(svc.updateSection('sidebar', { enabled: false }, actor)).rejects.toThrow(NotFoundException);
    await expect(svc.updateSection('news', {}, actor)).rejects.toThrow(BadRequestException);
    await expect(svc.updateSection('news', { enabled: 'no' }, actor)).rejects.toThrow(BadRequestException);
    await expect(svc.updateSection('news', { enabled: true, extra: 1 }, actor)).rejects.toThrow(BadRequestException);
  });

  test('content edits are validated, sanitised, stored and audited with before / after', async () => {
    const { svc, rows, audit } = makeService();
    const content = clone(DEFAULT_HOME_CONTENT.marquee) as any;
    content.items = ['<b>Robotics</b>', 'Drone pilot training'];
    const view = await svc.updateSection('marquee', { content }, actor);
    expect(view.content).toEqual({ items: ['Robotics', 'Drone pilot training'] });
    expect(rows.get('marquee').content).toEqual({ items: ['Robotics', 'Drone pilot training'] });
    expect(rows.get('marquee').updatedBy).toBe('event.admin@example.test');
    expect(audit.logAction.mock.calls[0][0]).toMatchObject({ action: 'UPDATE_HOME_SECTION', entityId: 'marquee' });
    expect(audit.logAction.mock.calls[0][0].beforeState.content).toEqual(DEFAULT_HOME_CONTENT.marquee);

    const bad = clone(DEFAULT_HOME_CONTENT.hero) as any;
    bad.secondaryCta.href = '//evil.example';
    await expect(svc.updateSection('hero', { content: bad }, actor)).rejects.toThrow(BadRequestException);
  });

  test('reorder: listed sections first, the rest keep their order; fixed and unknown sections rejected', async () => {
    const { svc, audit } = makeService();
    const list = await svc.reorderSections({ keys: ['news', 'about'] }, actor);
    const body = list.filter((s) => !s.pinned).map((s) => s.key);
    expect(body.slice(0, 3)).toEqual(['news', 'about', 'partners']);
    expect(body).toHaveLength(ORDERABLE_HOME_SECTIONS.length);
    expect(list[0].key).toBe('hero');
    expect(list[1].key).toBe('ticker');
    expect(list[list.length - 1].key).toBe('footer');
    const pub = await svc.getPublicHome();
    expect(pub.sections.map((s) => s.key).slice(0, 4)).toEqual(['hero', 'ticker', 'news', 'about']);
    expect(audit.logAction.mock.calls[0][0]).toMatchObject({ action: 'REORDER_HOME_SECTIONS', entityType: 'HomeSection' });

    await expect(svc.reorderSections({ keys: ['hero', 'news'] }, actor)).rejects.toThrow(BadRequestException);
    await expect(svc.reorderSections({ keys: ['news', 'news'] }, actor)).rejects.toThrow(BadRequestException);
    await expect(svc.reorderSections({ keys: ['sidebar'] }, actor)).rejects.toThrow(BadRequestException);
    await expect(svc.reorderSections({ keys: [] }, actor)).rejects.toThrow(BadRequestException);
  });

  test('orderHomeSections pins the hero and ticker first and the footer last', () => {
    const out = orderHomeSections([
      { key: 'footer', sortOrder: 0 },
      { key: 'news', sortOrder: 5 },
      { key: 'hero', sortOrder: 999 },
      { key: 'about', sortOrder: 1 },
      { key: 'ticker', sortOrder: 500 }
    ] as any);
    expect(out.map((s) => s.key)).toEqual(['hero', 'ticker', 'about', 'news', 'footer']);
  });

  test('images must be uploaded site images', async () => {
    const { svc, prisma } = makeService();
    const about = clone(DEFAULT_HOME_CONTENT.about) as any;
    about.imageUrl = UPLOAD_UNKNOWN;
    await expect(svc.updateSection('about', { content: about }, actor)).rejects.toThrow(/uploaded site images/);
    expect(prisma.mediaAsset.findMany.mock.calls[0][0].where).toMatchObject({
      isPublic: true,
      purpose: { in: ['SITE_IMAGE', 'GALLERY_IMAGE'] },
      mimeType: { in: ['image/jpeg', 'image/png', 'image/webp'] }
    });
    about.imageUrl = UPLOAD_A;
    await expect(svc.updateSection('about', { content: about }, actor)).resolves.toMatchObject({ content: { imageUrl: UPLOAD_A } });
  });

  test('replaced and removed images are cleaned up when nothing else uses them', async () => {
    const { svc, siteContent } = makeService();
    const centres = clone(DEFAULT_HOME_CONTENT.centres) as any;
    centres.items[0].imageUrl = UPLOAD_A;
    centres.items[1].imageUrl = UPLOAD_B;
    await svc.updateSection('centres', { content: centres }, actor);
    expect(siteContent.removeFileIfUnreferenced).not.toHaveBeenCalled();

    // Replace A with B (B stays referenced), so only A is a cleanup candidate
    centres.items[0].imageUrl = UPLOAD_B;
    await svc.updateSection('centres', { content: centres }, actor);
    expect(siteContent.removeFileIfUnreferenced.mock.calls.map((c: any[]) => c[0])).toEqual([UPLOAD_A]);
    expect(siteContent.removeFileIfUnreferenced.mock.calls[0][1]).toMatchObject({ id: 'admin-1' });

    // Deleting the entries removes the last references to B
    siteContent.removeFileIfUnreferenced.mockClear();
    centres.items = centres.items.slice(2);
    await svc.updateSection('centres', { content: centres }, actor);
    expect(siteContent.removeFileIfUnreferenced.mock.calls.map((c: any[]) => c[0])).toEqual([UPLOAD_B]);

    // Toggling never touches files
    siteContent.removeFileIfUnreferenced.mockClear();
    await svc.updateSection('centres', { enabled: false }, actor);
    expect(siteContent.removeFileIfUnreferenced).not.toHaveBeenCalled();
  });

  test('reset restores the defaults, keeps the enabled flag and cleans up images', async () => {
    const { svc, siteContent, audit } = makeService();
    const awards = clone(DEFAULT_HOME_CONTENT.awards) as any;
    awards.items = [{ id: 'gold-2026', badge: 'Award · 2026', title: 'Gold', detail: '', imageUrl: UPLOAD_A }];
    await svc.updateSection('awards', { content: awards, enabled: false }, actor);
    const view = await svc.resetSection('awards', actor);
    expect(view.content).toEqual(DEFAULT_HOME_CONTENT.awards);
    expect(view.enabled).toBe(false);
    expect(siteContent.removeFileIfUnreferenced.mock.calls.map((c: any[]) => c[0])).toEqual([UPLOAD_A]);
    expect(audit.logAction.mock.calls.map((c: any[]) => c[0].action)).toContain('RESET_HOME_SECTION');
  });

  test('stored content that no longer validates falls back to the defaults', async () => {
    const { svc, rows } = makeService();
    rows.set('partners', { key: 'partners', enabled: true, sortOrder: 20, content: { title: 42 } });
    expect((await svc.getSection('partners')).content).toEqual(DEFAULT_HOME_CONTENT.partners);
  });

  test('collectUploadPaths finds upload paths anywhere in a value', () => {
    expect([...collectUploadPaths({ a: [UPLOAD_A, { b: UPLOAD_B, c: 'https://x.example' }], d: '/portal' })].sort()).toEqual([UPLOAD_A, UPLOAD_B].sort());
  });
});

// ======================================================================================================
// HTTP: the real controller, global guards, CSRF and step-up, with a test authentication strategy

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

describe('home sections over HTTP: authorisation and behaviour', () => {
  let app: INestApplication;
  let base: string;
  const ctx = makeService();

  const users = {
    admin: { id: 'u-admin', email: 'event.admin@example.test', role: 'EVENT_ADMIN', aud: 'gcdis-admin', stepUpAt: null as string | null },
    judge: { id: 'u-judge', email: 'judge@example.test', role: 'JUDGE', aud: 'gcdis-admin' },
    captain: { id: 'u-captain', email: 'captain@example.test', role: 'TEAM_CAPTAIN', aud: 'gcdis-public' },
    superStepUp: { id: 'u-super', email: 'super@example.test', role: 'SUPER_ADMIN', aud: 'gcdis-admin', stepUpAt: new Date().toISOString() }
  };

  const call = async (method: string, url: string, opts: { user?: object; body?: unknown; origin?: string } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', origin: opts.origin ?? 'http://localhost:3001' };
    if (opts.user) headers['x-test-user'] = JSON.stringify(opts.user);
    const res = await fetch(`${base}/api/cms${url}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [HomeContentController],
      providers: [
        TestJwtStrategy,
        { provide: HomeContentService, useValue: ctx.svc },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard }
      ]
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  test('guards on every admin route: roles, CSRF on writes, step-up on reset', () => {
    const proto = HomeContentController.prototype as any;
    const guardsOf = (name: string) => (Reflect.getMetadata(GUARDS_METADATA, proto[name]) || []) as any[];
    for (const name of ['listSections', 'getSection', 'updateSection', 'reorderSections', 'resetSection']) {
      expect(guardsOf(name)).toEqual(expect.arrayContaining([RolesGuard]));
      expect(Reflect.getMetadata(ROLES_KEY, proto[name])).toEqual(['SUPER_ADMIN', 'EVENT_ADMIN']);
    }
    for (const name of ['updateSection', 'reorderSections', 'resetSection']) expect(guardsOf(name)).toEqual(expect.arrayContaining([CsrfGuard]));
    expect(guardsOf('resetSection')).toEqual(expect.arrayContaining([StepUpGuard]));
    expect(guardsOf('updateSection')).not.toContain(StepUpGuard);
  });

  test('public read: anonymous, cached briefly, enabled sections only', async () => {
    const res = await call('GET', '/public/home');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age=30');
    expect(res.json.sections.map((s: any) => s.key)).toEqual([...HOME_SECTION_KEYS]);
  });

  test('anonymous visitors, participants and non-content staff are denied', async () => {
    for (const [method, url, body] of [
      ['GET', '/admin/home/sections', undefined],
      ['GET', '/admin/home/sections/news', undefined],
      ['PATCH', '/admin/home/sections/news', { enabled: false }],
      ['PUT', '/admin/home/sections/order', { keys: ['news'] }],
      ['POST', '/admin/home/sections/news/reset', undefined]
    ] as const) {
      expect({ url, method, status: (await call(method, url, { body })).status }).toEqual({ url, method, status: 401 });
      expect({ url, method, status: (await call(method, url, { body, user: users.captain })).status }).toEqual({ url, method, status: 403 });
      expect({ url, method, status: (await call(method, url, { body, user: users.judge })).status }).toEqual({ url, method, status: 403 });
    }
    // Nothing changed
    expect((await call('GET', '/public/home')).json.sections.map((s: any) => s.key)).toContain('news');
  });

  test('writes from a foreign origin are rejected (CSRF)', async () => {
    const res = await call('PATCH', '/admin/home/sections/news', { user: users.admin, body: { enabled: false }, origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  test('staff toggle a section: hidden from the public response, shown again', async () => {
    const off = await call('PATCH', '/admin/home/sections/news', { user: users.admin, body: { enabled: false } });
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ key: 'news', enabled: false });
    expect((await call('GET', '/public/home')).json.sections.map((s: any) => s.key)).not.toContain('news');
    expect((await call('PATCH', '/admin/home/sections/hero', { user: users.admin, body: { enabled: false } })).status).toBe(400);
    const on = await call('PATCH', '/admin/home/sections/news', { user: users.admin, body: { enabled: true } });
    expect(on.json.enabled).toBe(true);
  });

  test('staff edit content: validation errors are 400 with field paths', async () => {
    const hero = clone(DEFAULT_HOME_CONTENT.hero) as any;
    hero.primaryCta.href = 'javascript:alert(1)';
    hero.facts.push({ label: 'Fourth', value: 'x' });
    const bad = await call('PATCH', '/admin/home/sections/hero', { user: users.admin, body: { content: hero } });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toContain('primaryCta.href');
    expect(bad.json.message).toContain('facts');

    const good = clone(DEFAULT_HOME_CONTENT.hero) as any;
    good.headlineHighlight = 'Drone Engineers';
    const ok = await call('PATCH', '/admin/home/sections/hero', { user: users.admin, body: { content: good } });
    expect(ok.status).toBe(200);
    const pub = await call('GET', '/public/home');
    expect(pub.json.sections[0].content.headlineHighlight).toBe('Drone Engineers');
    expect((await call('PATCH', '/admin/home/sections/sidebar', { user: users.admin, body: { enabled: true } })).status).toBe(404);
  });

  test('staff reorder sections', async () => {
    const res = await call('PUT', '/admin/home/sections/order', { user: users.admin, body: { keys: ['testimonials', 'about'] } });
    expect(res.status).toBe(200);
    const pub = await call('GET', '/public/home');
    expect(pub.json.sections.map((s: any) => s.key).slice(0, 4)).toEqual(['hero', 'ticker', 'testimonials', 'about']);
    expect((await call('PUT', '/admin/home/sections/order', { user: users.admin, body: { keys: ['footer'] } })).status).toBe(400);
  });

  test('reset requires a recent step-up', async () => {
    const without = await call('POST', '/admin/home/sections/hero/reset', { user: users.admin });
    expect(without.status).toBe(403);
    expect(without.json.code).toBe('STEP_UP_REQUIRED');
    const withStepUp = await call('POST', '/admin/home/sections/hero/reset', { user: users.superStepUp });
    expect(withStepUp.status).toBe(200);
    expect(withStepUp.json.content).toEqual(DEFAULT_HOME_CONTENT.hero);
  });
});

// ======================================================================================================

describe('web: home sections data layer', () => {
  test('unreachable API: bundled defaults with every section', () => {
    for (const raw of [undefined, null, 'x', { nope: true }]) {
      const page = normaliseHomePage(raw);
      expect(page.fromApi).toBe(false);
      expect(page.order).toContain('news');
      expect(page.hiddenAnchors).toEqual([]);
      expect(page.content).toBe(HOME_CONTENT);
    }
  });

  test('admin order is followed; missing sections are hidden and their anchors reported', () => {
    const sections = [
      { key: 'hero', sortOrder: 0, content: DEFAULT_HOME_CONTENT.hero },
      { key: 'news', sortOrder: 20, content: DEFAULT_HOME_CONTENT.news },
      { key: 'about', sortOrder: 30, content: DEFAULT_HOME_CONTENT.about },
      { key: 'footer', sortOrder: 99, content: DEFAULT_HOME_CONTENT.footer }
    ];
    const page = normaliseHomePage({ sections });
    expect(page.fromApi).toBe(true);
    expect(page.order).toEqual(['news', 'about']);
    expect(page.showTicker).toBe(false);
    expect(page.hiddenAnchors).toEqual(expect.arrayContaining(['programmes', 'services', 'mission', 'centres']));
    expect(page.hiddenAnchors).not.toContain('news');
    expect(page.hiddenAnchors).not.toContain('contact');
  });

  test('malformed sections fall back to their defaults; unsafe links are neutralised', () => {
    const hero = clone(DEFAULT_HOME_CONTENT.hero) as any;
    hero.primaryCta.href = 'javascript:alert(1)';
    hero.headlineHighlight = 'Edited';
    const about = { eyebrow: 1 };
    const centres = clone(DEFAULT_HOME_CONTENT.centres) as any;
    centres.items[0].imageUrl = 'data:image/png;base64,AAAA';
    const page = normaliseHomePage({
      sections: [
        { key: 'hero', content: hero },
        { key: 'about', content: about },
        { key: 'centres', content: centres }
      ]
    });
    expect(page.content.hero.headlineHighlight).toBe('Edited');
    expect(page.content.hero.primaryCta.href).toBe('#');
    expect(page.content.about).toEqual(HOME_CONTENT.about);
    expect(page.content.centres.items[0].imageUrl).toBeNull();
    expect(safeHref('//evil.example')).toBeNull();
    expect(safeHref('/portal')).toBe('/portal');
  });

  test('links to hidden sections are recognised', () => {
    expect(linksToHiddenSection('#news', ['news'])).toBe(true);
    expect(linksToHiddenSection('/#news', ['news'])).toBe(true);
    expect(linksToHiddenSection('/events/x#news', ['news'])).toBe(false);
    expect(linksToHiddenSection('#about', ['news'])).toBe(false);
  });
});

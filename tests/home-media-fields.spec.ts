import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BadRequestException, ForbiddenException, Injectable, INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { Strategy as PassportStrategyBase } from 'passport-strategy';
import { HomeContentController } from '../apps/api/src/cms/home-content.controller';
import { HomeContentService, collectMediaFields, removedVideos } from '../apps/api/src/cms/home-content.service';
import { DEFAULT_HOME_CONTENT, HOME_SECTION_KEYS, defaultHomeSectionContent } from '../apps/api/src/cms/home-content.defaults';
import { HOME_SECTION_SCHEMAS } from '../apps/api/src/cms/dto/home-content.schema';
import { JwtAuthGuard } from '../apps/api/src/auth/jwt-auth.guard';
import { RolesGuard } from '../apps/api/src/auth/roles.guard';
import { StepUpGuard } from '../apps/api/src/auth/step-up.guard';
import { CsrfGuard } from '../apps/api/src/common/guards/csrf.guard';
import { ROLES_KEY } from '../apps/api/src/auth/roles.decorator';
import { HOME_CONTENT } from '../apps/web/src/lib/home-content';
import { normaliseHomePage, safeVideoUrl, sanitiseHomeLinks } from '../apps/web/src/lib/home-sections';
import { HOME_SECTION_SPECS, MEDIA_KEY, type FieldSpec } from '../apps/admin/src/app/_components/homeSectionSpecs';

// The web effects and tokens modules import through the Next.js "@/" alias (not resolvable here): stub them with
// the same contract (LabPhoto shows `src`, or the laboratory photograph when empty).
jest.mock('../apps/web/src/components/home-bento/Effects', () => ({
  LAB_PHOTO: '/images/gcdis-drone-lab.jpg',
  LabPhoto: ({ src, alt }: { src?: string | null; alt?: string }) =>
    require('react').createElement('img', { src: src || '/images/gcdis-drone-lab.jpg', alt: alt ?? '' })
}));
jest.mock('../apps/web/src/components/home-bento/tokens', () => ({
  cx: (...parts: unknown[]) => parts.filter(Boolean).join(' ')
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Media = require('../apps/web/src/components/home-bento/Media') as typeof import('../apps/web/src/components/home-bento/Media');

/**
 * Image and video control for every home page section and card (feature): strict schema acceptance and rejection,
 * the EVENT_VIDEO / public / MIME checks of the service, step-up for replacing or removing a live video, the web
 * sanitiser, the staff console field specs, the rendering contracts of the web media components and unchanged
 * authorisation of the admin routes.
 */

const ROOT = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf-8');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const IMG = '/api/uploads/files/0b8f9c1e-1111-4222-8333-944455556666_aaaaaaaaaaaaaaaa.webp';
const IMG_2 = '/api/uploads/files/0b8f9c1e-1111-4222-8333-944455556666_bbbbbbbbbbbbbbbb.png';
const VID = '/api/uploads/files/0b8f9c1e-1111-4222-8333-944455556666_cccccccccccccccc.mp4';
const VID_2 = '/api/uploads/files/0b8f9c1e-1111-4222-8333-944455556666_dddddddddddddddd.webm';
const VID_PRIVATE = '/api/uploads/files/0b8f9c1e-1111-4222-8333-944455556666_eeeeeeeeeeeeeeee.mp4';
const VID_WRONG_PURPOSE = '/api/uploads/files/0b8f9c1e-1111-4222-8333-944455556666_ffffffffffffffff.mp4';

/** Sections that carry media (all but the text-only ticker and marquee bands). */
const MEDIA_SECTIONS = HOME_SECTION_KEYS.filter((k) => k !== 'ticker' && k !== 'marquee');

/** Card / tile lists that carry media, as [section, list key]. */
const MEDIA_LISTS: Array<[string, string]> = [
  ['mission', 'tabs'],
  ['centres', 'items'],
  ['programmes', 'items'],
  ['mous', 'items'],
  ['services', 'items'],
  ['news', 'items'],
  ['awards', 'items'],
  ['testimonials', 'visitors'],
  ['testimonials', 'stories']
];
/** Lists that are not cards (filters, links, short text tiles, accordion points): no media by design. */
const NON_CARD_LISTS = new Set(['hero.facts', 'about.stats', 'mission.tabs.points', 'centres.filters', 'programmes.categories', 'news.filters', 'footer.quickLinks', 'footer.programmeLinks']);

const parse = (key: string, value: unknown) => (HOME_SECTION_SCHEMAS as any)[key].safeParse(value);

// ------------------------------------------------------------------------------------------------ Prisma double

interface Asset {
  fileUrl: string;
  isPublic: boolean;
  purpose: string;
  mimeType: string;
}

function fakePrisma() {
  const rows = new Map<string, any>();
  const assets: Asset[] = [
    { fileUrl: IMG, isPublic: true, purpose: 'SITE_IMAGE', mimeType: 'image/webp' },
    { fileUrl: IMG_2, isPublic: true, purpose: 'GALLERY_IMAGE', mimeType: 'image/png' },
    { fileUrl: VID, isPublic: true, purpose: 'EVENT_VIDEO', mimeType: 'video/mp4' },
    { fileUrl: VID_2, isPublic: true, purpose: 'EVENT_VIDEO', mimeType: 'video/webm' },
    { fileUrl: VID_PRIVATE, isPublic: false, purpose: 'EVENT_VIDEO', mimeType: 'video/mp4' },
    { fileUrl: VID_WRONG_PURPOSE, isPublic: true, purpose: 'CMS_BACKGROUND', mimeType: 'video/mp4' }
  ];
  const prisma: any = {
    homeSection: {
      findMany: jest.fn(async () => [...rows.values()].map((r) => clone(r))),
      findUnique: jest.fn(async ({ where }: any) => (rows.has(where.key) ? clone(rows.get(where.key)) : null)),
      upsert: jest.fn(async ({ where, update, create }: any) => {
        const existing = rows.get(where.key);
        const next = existing ? { ...existing, ...update, updatedAt: new Date().toISOString() } : { ...create, updatedAt: new Date().toISOString() };
        rows.set(where.key, clone(next));
        return clone(next);
      })
    },
    // Honours the filter exactly like the database would (fileUrl in, isPublic, purpose in, mimeType in)
    mediaAsset: {
      findMany: jest.fn(async ({ where }: any) =>
        assets
          .filter(
            (a) =>
              where.fileUrl.in.includes(a.fileUrl) &&
              (where.isPublic === undefined || a.isPublic === where.isPublic) &&
              where.purpose.in.includes(a.purpose) &&
              where.mimeType.in.includes(a.mimeType)
          )
          .map((a) => ({ fileUrl: a.fileUrl }))
      )
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops))
  };
  return { prisma, rows };
}

function makeService() {
  const { prisma, rows } = fakePrisma();
  const audit = { logAction: jest.fn().mockResolvedValue({}) };
  const siteContent = { removeFileIfUnreferenced: jest.fn().mockResolvedValue(true) };
  const svc = new HomeContentService(prisma, audit as any, siteContent as any);
  return { svc, prisma, rows, audit, siteContent };
}

const actor = { id: 'admin-1', email: 'event.admin@example.test', role: 'EVENT_ADMIN' };

// ================================================================================================ Schema

describe('home media fields: schema', () => {
  test('existing content stays valid: every default (no media fields) still passes unchanged', () => {
    for (const key of HOME_SECTION_KEYS) {
      const r = parse(key, defaultHomeSectionContent(key));
      expect({ key, ok: r.success }).toEqual({ key, ok: true });
      if (r.success) expect(r.data).toEqual(DEFAULT_HOME_CONTENT[key]);
    }
  });

  test('every media section accepts an image, a video and a description at section level', () => {
    for (const key of MEDIA_SECTIONS) {
      const content = { ...clone(DEFAULT_HOME_CONTENT[key]), imageUrl: IMG, videoUrl: VID, imageAlt: 'Students flying a drone' };
      const r = parse(key, content);
      expect({ key, ok: r.success, issues: r.success ? [] : r.error.issues }).toEqual({ key, ok: true, issues: [] });
      expect(r.data).toMatchObject({ imageUrl: IMG, videoUrl: VID, imageAlt: 'Students flying a drone' });
    }
  });

  test('text-only bands (ticker, marquee) stay strict: no media fields', () => {
    for (const key of ['ticker', 'marquee']) {
      expect(parse(key, { ...clone(DEFAULT_HOME_CONTENT[key as 'ticker']), videoUrl: VID }).success).toBe(false);
    }
  });

  test('every card list entry accepts an image and a video', () => {
    for (const [section, list] of MEDIA_LISTS) {
      const content = clone(DEFAULT_HOME_CONTENT[section as 'news']) as any;
      if (content[list].length === 0) content[list].push(section === 'testimonials' ? { id: 'x', quote: 'Q', name: 'N', role: '' } : null);
      content[list] = content[list].map((item: any) => ({ ...item, imageUrl: IMG, videoUrl: VID, imageAlt: 'alt' }));
      const r = parse(section, content);
      expect({ section, list, ok: r.success, issues: r.success ? [] : r.error.issues }).toEqual({ section, list, ok: true, issues: [] });
    }
    // Video teaser cards (about video, success story video)
    const about = { ...clone(DEFAULT_HOME_CONTENT.about), video: { title: 'Tour', meta: '', url: null, imageUrl: IMG, videoUrl: VID } };
    expect(parse('about', about).success).toBe(true);
  });

  test('empty strings clear media (image and video to null, description dropped)', () => {
    const r = parse('services', { ...clone(DEFAULT_HOME_CONTENT.services), imageUrl: '', videoUrl: ' ', imageAlt: '' });
    expect(r.success).toBe(true);
    expect(r.data.imageUrl).toBeNull();
    expect(r.data.videoUrl).toBeNull();
    expect(r.data.imageAlt).toBeUndefined();
  });

  test.each([
    ['an external https video', 'https://www.youtube.com/watch?v=abc'],
    ['an embed', 'https://www.youtube.com/embed/abc'],
    ['javascript:', 'javascript:alert(1)'],
    ['a protocol-relative URL', '//evil.example/a.mp4'],
    ['a data: URL', 'data:video/mp4;base64,AAAA'],
    ['a path outside the uploads', '/api/admin/x.mp4'],
    ['path traversal', '/api/uploads/files/../secret.mp4'],
    ['a non-string', 42]
  ])('videoUrl rejects %s', (_label, bad) => {
    expect(parse('news', { ...clone(DEFAULT_HOME_CONTENT.news), videoUrl: bad }).success).toBe(false);
    const items = clone(DEFAULT_HOME_CONTENT.centres.items as any[]).map((c) => ({ ...c, videoUrl: bad }));
    expect(parse('centres', { ...clone(DEFAULT_HOME_CONTENT.centres), items }).success).toBe(false);
  });

  test('imageUrl stays upload-only; unknown media keys and long descriptions are rejected', () => {
    expect(parse('about', { ...clone(DEFAULT_HOME_CONTENT.about), imageUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(parse('about', { ...clone(DEFAULT_HOME_CONTENT.about), videoEmbed: '<iframe>' }).success).toBe(false);
    expect(parse('about', { ...clone(DEFAULT_HOME_CONTENT.about), imageAlt: 'x'.repeat(201) }).success).toBe(false);
    // Markup in the description is stripped (plain text)
    const r = parse('about', { ...clone(DEFAULT_HOME_CONTENT.about), imageAlt: '<b>Lab</b><script>x</script>' });
    expect(r.success).toBe(true);
    expect(r.data.imageAlt).not.toMatch(/[<>]/);
  });
});

// ================================================================================================ Service

describe('home media fields: service checks', () => {
  test('a video URL must be a public EVENT_VIDEO upload of an accepted video type', async () => {
    const { svc } = makeService();
    const withVideo = (url: string) => ({ content: { ...clone(DEFAULT_HOME_CONTENT.services), videoUrl: url } });
    // Points at an image (right path shape, wrong purpose and type)
    await expect(svc.updateSection('services', withVideo(IMG), actor)).rejects.toThrow(BadRequestException);
    // Private upload
    await expect(svc.updateSection('services', withVideo(VID_PRIVATE), actor)).rejects.toThrow(BadRequestException);
    // Video, but not uploaded as EVENT_VIDEO
    await expect(svc.updateSection('services', withVideo(VID_WRONG_PURPOSE), actor)).rejects.toThrow(BadRequestException);
    // Unknown file
    await expect(svc.updateSection('services', withVideo('/api/uploads/files/unknown.mp4'), actor)).rejects.toThrow(BadRequestException);
    // A video cannot be used as an image either
    await expect(
      svc.updateSection('services', { content: { ...clone(DEFAULT_HOME_CONTENT.services), imageUrl: VID } }, actor)
    ).rejects.toThrow(BadRequestException);

    const ok = await svc.updateSection('services', withVideo(VID), actor);
    expect(ok.content.videoUrl).toBe(VID);
  });

  test('item videos are checked too', async () => {
    const { svc } = makeService();
    const content = clone(DEFAULT_HOME_CONTENT.programmes) as any;
    content.items[0].videoUrl = IMG_2;
    await expect(svc.updateSection('programmes', { content }, actor)).rejects.toThrow(/EVENT_VIDEO/);
    content.items[0].videoUrl = VID_2;
    content.items[0].imageUrl = IMG;
    const saved = await svc.updateSection('programmes', { content }, actor);
    expect((saved.content as any).items[0]).toMatchObject({ videoUrl: VID_2, imageUrl: IMG });
  });

  test('adding a video needs no step-up; replacing or removing a live one does, and the old file is cleaned up', async () => {
    const { svc, siteContent } = makeService();
    const base = clone(DEFAULT_HOME_CONTENT.hero) as any;
    await svc.updateSection('hero', { content: { ...base, videoUrl: VID, imageUrl: IMG } }, actor, false);

    let err: unknown;
    try {
      await svc.updateSection('hero', { content: { ...base, videoUrl: VID_2, imageUrl: IMG } }, actor, false);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(svc.updateSection('hero', { content: { ...base, videoUrl: null, imageUrl: IMG } }, actor, false)).rejects.toThrow(ForbiddenException);
    // Editing other fields while keeping the video needs no step-up
    await svc.updateSection('hero', { content: { ...base, eyebrow: 'Changed', videoUrl: VID, imageUrl: IMG } }, actor, false);

    const replaced = await svc.updateSection('hero', { content: { ...base, videoUrl: VID_2, imageUrl: IMG } }, actor, true);
    expect(replaced.content.videoUrl).toBe(VID_2);
    expect(siteContent.removeFileIfUnreferenced).toHaveBeenCalledWith(VID, expect.anything());
    // Toggling visibility does not touch content, so never needs a step-up
    await svc.updateSection('news', { enabled: false }, actor, false);
  });

  test('helpers collect media fields anywhere in a value', () => {
    const value = { videoUrl: VID, items: [{ videoUrl: VID_2, imageUrl: IMG }, { video: { videoUrl: null } }] };
    expect([...collectMediaFields(value, 'videoUrl')].sort()).toEqual([VID, VID_2].sort());
    expect([...collectMediaFields(value, 'imageUrl')]).toEqual([IMG]);
    expect(removedVideos(value, { videoUrl: VID })).toEqual([VID_2]);
    expect(removedVideos({}, value)).toEqual([]);
  });

  test('unreferenced-file cleanup already covers home_sections (no new storage location)', () => {
    const src = read('apps/api/src/cms/site-content.service.ts');
    expect(src).toMatch(/FROM "home_sections" WHERE strpos\("content"::text/);
  });
});

// ================================================================================================ Web sanitiser

describe('home media fields: web sanitiser', () => {
  test('safeVideoUrl keeps API uploads only', () => {
    expect(safeVideoUrl(VID)).toMatch(/\/api\/uploads\/files\/0b8f9c1e-1111-4222-8333-944455556666_cccccccccccccccc\.mp4$/);
    for (const bad of ['https://www.youtube.com/embed/x', 'https://cdn.example/x.mp4', '//evil/x.mp4', 'javascript:alert(1)', 'data:video/mp4;base64,AA', 'blob:x', '/api/uploads/files/../x', '', null, 3]) {
      expect({ bad, out: safeVideoUrl(bad) }).toEqual({ bad, out: null });
    }
  });

  test('sanitiseHomeLinks re-validates videoUrl and imageAlt everywhere', () => {
    const out = sanitiseHomeLinks({
      videoUrl: 'https://www.youtube.com/embed/x',
      imageAlt: 'a'.repeat(500),
      items: [{ videoUrl: VID }, { videoUrl: 'javascript:alert(1)' }]
    }) as any;
    expect(out.videoUrl).toBeNull();
    expect(out.imageAlt).toHaveLength(200);
    expect(out.items[0].videoUrl).toMatch(/cccccccccccccccc\.mp4$/);
    expect(out.items[1].videoUrl).toBeNull();
  });

  test('API content with media passes the template check and is sanitised; content without media is unchanged', () => {
    const news = clone(HOME_CONTENT.news) as any;
    news.videoUrl = 'https://evil.example/x.mp4';
    news.items[0] = { ...news.items[0], videoUrl: VID, imageAlt: 'Card' };
    const page = normaliseHomePage({ sections: [{ key: 'hero', sortOrder: 0, content: HOME_CONTENT.hero }, { key: 'news', sortOrder: 1, content: news }] });
    expect(page.content.news.videoUrl).toBeNull();
    expect(page.content.news.items[0].videoUrl).toMatch(/\.mp4$/);
    expect(page.content.news.items[0].imageAlt).toBe('Card');

    const plain = normaliseHomePage({ sections: HOME_SECTION_KEYS.map((key, i) => ({ key, sortOrder: i, content: DEFAULT_HOME_CONTENT[key] })) });
    expect(plain.content.hero.videoUrl).toBeUndefined();
    expect(plain.content.about.imageUrl ?? null).toBeNull();
  });
});

// ================================================================================================ Staff console

function findField(fields: FieldSpec[], key: string): FieldSpec | undefined {
  return fields.find((f) => f.key === key);
}
const hasMediaField = (fields: FieldSpec[]) => fields.some((f) => f.kind === 'media' && f.key === MEDIA_KEY);

describe('home media fields: staff console specs', () => {
  test('every media section has a media field at section level', () => {
    for (const key of MEDIA_SECTIONS) {
      expect({ key, media: hasMediaField(HOME_SECTION_SPECS[key].fields) }).toEqual({ key, media: true });
    }
    expect(hasMediaField(HOME_SECTION_SPECS.ticker.fields)).toBe(false);
    expect(hasMediaField(HOME_SECTION_SPECS.marquee.fields)).toBe(false);
  });

  test('every card list and video card has a media field; other lists are known non-card lists', () => {
    for (const [section, list] of MEDIA_LISTS) {
      const spec = findField(HOME_SECTION_SPECS[section as 'news'].fields, list);
      expect(spec?.kind).toBe('list');
      expect({ section, list, media: hasMediaField((spec as any).fields) }).toEqual({ section, list, media: true });
    }
    for (const [section, group] of [['about', 'video'], ['testimonials', 'storyVideo']] as const) {
      const spec = findField(HOME_SECTION_SPECS[section].fields, group) as any;
      expect({ section, group, media: hasMediaField(spec.fields) }).toEqual({ section, group, media: true });
    }

    const covered = new Set(MEDIA_LISTS.map(([s, l]) => `${s}.${l}`));
    const walk = (fields: FieldSpec[], prefix: string) => {
      for (const f of fields) {
        if (f.kind === 'list') {
          const id = `${prefix}.${f.key}`;
          expect({ id, known: covered.has(id) || NON_CARD_LISTS.has(id) }).toEqual({ id, known: true });
          walk(f.fields, id);
        } else if (f.kind === 'group') walk(f.fields, `${prefix}.${f.key}`);
      }
    };
    for (const key of HOME_SECTION_KEYS) walk(HOME_SECTION_SPECS[key].fields, key);
  });

  test('no plain image-only field is left: every picture slot offers image and video', () => {
    const kinds: string[] = [];
    const walk = (fields: FieldSpec[]) =>
      fields.forEach((f) => {
        kinds.push(f.kind);
        if (f.kind === 'list' || f.kind === 'group') walk(f.fields);
      });
    for (const key of HOME_SECTION_KEYS) walk(HOME_SECTION_SPECS[key].fields);
    expect(kinds).not.toContain('image');
  });

  test('MediaUploadField: SITE_IMAGE image, EVENT_VIDEO video with ?purpose=, checks, progress, preview, replace and remove', () => {
    const src = read('apps/admin/src/app/_components/MediaUploadField.tsx');
    expect(src).toContain("MEDIA_IMAGE_PURPOSE = 'SITE_IMAGE'");
    expect(src).toContain("MEDIA_VIDEO_PURPOSE = 'EVENT_VIDEO'");
    expect(src).toContain('uploadAdminFile(file, MEDIA_VIDEO_PURPOSE, setVideoProgress)');
    expect(src).toContain('validateVideoFile(file, videoMaxBytes)');
    expect(src).toContain('<ImageUploadField');
    expect(src).toMatch(/<video[\s\S]*muted[\s\S]*playsInline/);
    expect(src).toContain('role="progressbar"');
    expect(src).toContain('Replace Video');
    expect(src).toContain('Remove Video');
    expect(src).toContain('accept={VIDEO_ACCEPT}');
    // The upload client sends the purpose on the URL (video size limit chosen before the body is read)
    expect(read('apps/admin/src/lib/api-client.ts')).toContain('/uploads/stream?purpose=${encodeURIComponent(purpose)}');
    // Used by the home sections editor and the Home Page Hero tab
    expect(read('apps/admin/src/app/_components/HomeSectionsTab.tsx')).toContain("spec.kind === 'media'");
    const hero = read('apps/admin/src/app/_components/CmsHeroTab.tsx');
    expect(hero).toContain('<MediaUploadField');
    expect(hero).toContain("adminFetch('/cms/admin/home/sections/hero', { method: 'PATCH'");
  });
});

// ================================================================================================ Rendering contracts

describe('home media fields: web rendering contracts', () => {
  const html = (el: React.ReactElement) => renderToStaticMarkup(el);

  test('AmbientVideo: muted, looped, inline, poster first, lazy, hidden from assistive tech, no embeds', () => {
    const out = html(React.createElement(Media.AmbientVideo, { src: 'https://api.example/api/uploads/files/v.mp4', poster: 'https://api.example/p.webp' }));
    expect(out).toMatch(/^<video /);
    expect(out).toContain('loop=""');
    expect(out).toContain('playsInline=""');
    expect(out).toContain('poster="https://api.example/p.webp"');
    expect(out).toContain('preload="none"');
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain('opacity-0'); // transparent until it actually plays: the image underneath shows first
    expect(out).not.toContain('autoPlay');
    expect(out).not.toMatch(/<iframe/);
    const hero = html(React.createElement(Media.AmbientVideo, { src: '/v.mp4', eager: true }));
    expect(hero).toContain('autoPlay=""');
    expect(hero).toContain('preload="auto"');
    const src = read('apps/web/src/components/home-bento/Media.tsx');
    expect(src).toContain('video.muted = true');
  });

  test('first render (server, before the motion / data-saving checks) shows the image only, never the video', () => {
    const out = html(React.createElement(Media.MediaFill, { media: { imageUrl: 'https://api.example/i.webp', videoUrl: '/api/uploads/files/v.mp4', imageAlt: 'Lab' }, sizes: '100vw' }));
    expect(out).toContain('src="https://api.example/i.webp"');
    expect(out).toContain('alt="Lab"');
    expect(out).not.toContain('<video');
  });

  test('sections without media render nothing extra (unchanged design)', () => {
    expect(html(React.createElement(Media.SectionMedia, { media: {} }))).toBe('');
    expect(html(React.createElement(Media.SectionMedia, { media: { imageUrl: null, videoUrl: null } }))).toBe('');
    expect(html(React.createElement(Media.ItemMedia, { media: undefined }))).toBe('');
    const withImage = html(React.createElement(Media.SectionMedia, { media: { imageUrl: 'https://api.example/i.webp' } }));
    expect(withImage).toContain('aspect-video'); // fixed aspect box: no layout shift
    expect(withImage).toContain('data-section-media');
  });

  test('reduced motion and data saving: no video, the image is shown; video plays only while in view', () => {
    expect(Media.prefersSaveData({ connection: { saveData: true } })).toBe(true);
    expect(Media.prefersSaveData({ connection: { saveData: false } })).toBe(false);
    expect(Media.prefersSaveData({})).toBe(false);
    expect(Media.prefersSaveData(undefined)).toBe(false);
    const src = read('apps/web/src/components/home-bento/Media.tsx');
    expect(src).toMatch(/useReducedMotion\(\)/);
    expect(src).toMatch(/return allowed && !reduce;/);
    expect(src).toMatch(/if \(!allowed \|\| !videoUrl\) return null;/);
    expect(src).toContain('new IntersectionObserver(');
    expect(src).toMatch(/if \(entry\?\.isIntersecting\) play\(\);\s*else video\.pause\(\);/);
  });

  test('every section and card renders its media through the shared components', () => {
    const bento = (f: string) => read('apps/web/src/components/home-bento', f);
    const uses: Record<string, RegExp[]> = {
      'AboutSection.tsx': [/<MediaFill media=\{content\}/, /videoUrl: content\.video\.videoUrl/],
      'CentresSection.tsx': [/<MediaFill media=\{centre\}/, /<SectionMedia media=\{content\}/],
      'ProgrammesSection.tsx': [/<MediaFill media=\{programme\}[\s\S]*<MediaFill media=\{programme\}/, /<SectionMedia media=\{content\}/],
      'NewsSection.tsx': [/<MediaFill media=\{item\}/, /<SectionMedia media=\{content\}/],
      'AwardsSection.tsx': [/<VideoLayer videoUrl=\{tile\.videoUrl\}/, /<SectionMedia media=\{content\}/],
      'MissionSection.tsx': [/<MediaFill media=\{current\}/, /<SectionMedia media=\{content\}/],
      'ServicesSection.tsx': [/<ItemMedia media=\{service\}[\s\S]*<ItemMedia media=\{service\}/, /<SectionMedia media=\{content\}/],
      'MouStrip.tsx': [/<ItemMedia media=\{mou\}/, /<SectionMedia media=\{content\}/],
      'TestimonialsSection.tsx': [/media=\{current\}/, /<MediaFill media=\{video\}/, /<SectionMedia media=\{content\}/],
      'PartnersStrip.tsx': [/<SectionMedia media=\{content\}/],
      'BentoFooter.tsx': [/<SectionMedia media=\{content\}/]
    };
    for (const [file, patterns] of Object.entries(uses)) {
      const src = bento(file);
      for (const p of patterns) expect({ file, pattern: String(p), ok: p.test(src) }).toEqual({ file, pattern: String(p), ok: true });
      expect({ file, iframe: /<iframe/i.test(src) }).toEqual({ file, iframe: false });
    }
  });

  test('hero: background video over the poster, overlay kept, CMS "video" values never used as an image', () => {
    const src = read('apps/web/src/components/home/PublicHomePage.tsx');
    expect(src).toContain("<VideoLayer videoUrl={hero.videoUrl} poster={heroStill ?? '/images/gcdis-drone-lab.jpg'} eager />");
    expect(src).toContain("heroBg.mediaType !== 'video'");
    expect(src).toMatch(/Legibility overlays/);
  });
});

// ================================================================================================ Authorisation (HTTP)

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

describe('home media fields: authorisation unchanged', () => {
  let app: INestApplication;
  let base: string;
  const ctx = makeService();
  const users = {
    admin: { id: 'u-admin', email: 'event.admin@example.test', role: 'EVENT_ADMIN', aud: 'gcdis-admin', stepUpAt: null as string | null },
    judge: { id: 'u-judge', email: 'judge@example.test', role: 'JUDGE', aud: 'gcdis-admin' },
    inspector: { id: 'u-insp', email: 'inspector@example.test', role: 'INSPECTOR', aud: 'gcdis-admin' },
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
    return { status: res.status, json };
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

  test('route guards are unchanged: SUPER_ADMIN / EVENT_ADMIN, CSRF on writes, step-up on reset', () => {
    const proto = HomeContentController.prototype as any;
    const guardsOf = (name: string) => (Reflect.getMetadata(GUARDS_METADATA, proto[name]) || []) as any[];
    expect(guardsOf('updateSection')).toEqual(expect.arrayContaining([RolesGuard, CsrfGuard]));
    expect(Reflect.getMetadata(ROLES_KEY, proto.updateSection)).toEqual(['SUPER_ADMIN', 'EVENT_ADMIN']);
    expect(guardsOf('resetSection')).toEqual(expect.arrayContaining([StepUpGuard]));
  });

  test('media edits: denied to anonymous visitors, participants and other staff; CSRF enforced', async () => {
    const body = { content: { ...clone(DEFAULT_HOME_CONTENT.services), videoUrl: VID } };
    expect((await call('PATCH', '/admin/home/sections/services', { body })).status).toBe(401);
    for (const user of [users.captain, users.judge, users.inspector]) {
      expect((await call('PATCH', '/admin/home/sections/services', { body, user })).status).toBe(403);
    }
    expect((await call('PATCH', '/admin/home/sections/services', { body, user: users.admin, origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('GET', '/public/home')).json.sections.find((s: any) => s.key === 'services').content.videoUrl).toBeUndefined();
  });

  test('staff add a video; replacing it needs a step-up (STEP_UP_REQUIRED), then succeeds after one', async () => {
    const services = clone(DEFAULT_HOME_CONTENT.services) as any;
    const add = await call('PATCH', '/admin/home/sections/services', { user: users.admin, body: { content: { ...services, videoUrl: VID, imageUrl: IMG } } });
    expect(add.status).toBe(200);
    expect(add.json.content).toMatchObject({ videoUrl: VID, imageUrl: IMG });
    const pub = (await call('GET', '/public/home')).json.sections.find((s: any) => s.key === 'services');
    expect(pub.content).toMatchObject({ videoUrl: VID, imageUrl: IMG });

    const swap = { content: { ...services, videoUrl: VID_2, imageUrl: IMG } };
    const denied = await call('PATCH', '/admin/home/sections/services', { user: users.admin, body: swap });
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe('STEP_UP_REQUIRED');
    const allowed = await call('PATCH', '/admin/home/sections/services', { user: users.superStepUp, body: swap });
    expect(allowed.status).toBe(200);
    expect(allowed.json.content.videoUrl).toBe(VID_2);

    const bad = await call('PATCH', '/admin/home/sections/services', { user: users.superStepUp, body: { content: { ...services, videoUrl: IMG } } });
    expect(bad.status).toBe(400);
  });
});

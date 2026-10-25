import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_GALLERY_SECTION as API_DEFAULT_GALLERY_SECTION,
  DEFAULT_SPONSORS_SECTION as API_DEFAULT_SPONSORS_SECTION,
  SPONSOR_PLACEMENTS as API_SPONSOR_PLACEMENTS,
  SPONSOR_TIERS as API_SPONSOR_TIERS,
  SPONSOR_TIER_LABELS as API_SPONSOR_TIER_LABELS
} from '../apps/api/src/cms/site-content.defaults';
import { IMAGE_PURPOSE_LIMITS, SITE_IMAGE_MIME_TYPES } from '../apps/api/src/uploads/uploads.service';
import {
  DEFAULT_GALLERY_SECTION,
  DEFAULT_SPONSORS_SECTION,
  EMPTY_SITE_INFO,
  IMAGE_MIME_TYPES,
  SPONSOR_PLACEMENTS,
  SPONSOR_TIERS,
  SPONSOR_TIER_LABELS,
  TAB_ROLES,
  UPLOAD_LIMITS,
  canOpenTab,
  isHttpsUrl,
  moveItem,
  moveSponsor,
  siteInfoPayload,
  sortSponsors,
  sponsorsForPlacement,
  summariseUserAgent,
  validateGalleryDetails,
  validateImageFile,
  validateSiteInfo,
  validateSponsor,
  type SiteInfo,
  type Sponsor
} from '../apps/admin/src/app/_components/contentTypes';

const adminDir = path.join(__dirname, '..', 'apps', 'admin', 'src');
const read = (...parts: string[]) => fs.readFileSync(path.join(adminDir, ...parts), 'utf-8');

const sponsor = (id: string, tier: Sponsor['tier'], displayOrder: number, extra: Partial<Sponsor> = {}): Sponsor => ({
  id,
  name: `QA ${id}`,
  tier,
  logoUrl: null,
  websiteUrl: null,
  description: null,
  placements: ['HOME'],
  isActive: true,
  displayOrder,
  ...extra
});

const validSiteInfo = (): SiteInfo => ({
  organisationName: 'Galgotias Centre for Drone Innovation and Sports',
  shortName: 'GCDIS',
  universityName: 'Galgotias University',
  addressLines: ['Plot No. 2, Sector 17-A', 'Greater Noida'],
  phones: [{ display: '0120-4806827', tel: '+911204806827' }],
  email: 'office@example.org',
  mapUrl: 'https://maps.example.org/place',
  social: { linkedin: 'https://www.linkedin.com/company/example' },
  aboutImageUrl: null,
  aboutImageAlt: ''
});

describe('Staff console: site content contract mirrors', () => {
  test('sponsor tiers, labels and placements match the API', () => {
    expect([...SPONSOR_TIERS]).toEqual([...API_SPONSOR_TIERS]);
    expect(SPONSOR_TIER_LABELS).toEqual({ ...API_SPONSOR_TIER_LABELS });
    expect([...SPONSOR_PLACEMENTS]).toEqual([...API_SPONSOR_PLACEMENTS]);
  });

  test('section defaults match the API defaults', () => {
    expect(DEFAULT_SPONSORS_SECTION).toEqual({ ...API_DEFAULT_SPONSORS_SECTION, showOn: { ...API_DEFAULT_SPONSORS_SECTION.showOn } });
    expect(DEFAULT_GALLERY_SECTION).toEqual({ ...API_DEFAULT_GALLERY_SECTION });
  });

  test('image upload types and size limits match the API', () => {
    expect([...IMAGE_MIME_TYPES]).toEqual(SITE_IMAGE_MIME_TYPES);
    for (const purpose of ['SPONSOR_LOGO', 'GALLERY_IMAGE', 'SITE_IMAGE'] as const) {
      expect(UPLOAD_LIMITS[purpose]).toBe(IMAGE_PURPOSE_LIMITS[purpose]);
    }
  });

  test('validateImageFile rejects SVG and oversized files with formal messages', () => {
    expect(validateImageFile({ name: 'qa.png', type: 'image/png', size: 1000 }, 'SPONSOR_LOGO')).toBeNull();
    expect(validateImageFile({ name: 'qa.svg', type: 'image/svg+xml', size: 1000 }, 'GALLERY_IMAGE')).toMatch(/not a supported image/);
    expect(validateImageFile({ name: 'qa.jpg', type: 'image/jpeg', size: 3 * 1024 * 1024 }, 'SPONSOR_LOGO')).toMatch(/larger than the permitted 2 MB\.$/);
    expect(validateImageFile({ name: 'qa.jpg', type: 'image/jpeg', size: 3 * 1024 * 1024 }, 'GALLERY_IMAGE')).toBeNull();
  });
});

describe('Staff console: sponsors ordering and validation', () => {
  test('sorts by tier rank, then display order, as the public site does', () => {
    const list = [sponsor('a', 'GOLD', 0), sponsor('b', 'TITLE', 5), sponsor('c', 'GOLD', -1), sponsor('d', 'MEDIA', 0)];
    expect(sortSponsors(list).map((s) => s.id)).toEqual(['b', 'c', 'a', 'd']);
  });

  test('moves only within a tier and renumbers the display order', () => {
    const list = [sponsor('t', 'TITLE', 0), sponsor('g1', 'GOLD', 1), sponsor('g2', 'GOLD', 2)];
    expect(moveSponsor(list, 'g1', -1)).toBeNull(); // would cross into the Title tier
    const moved = moveSponsor(list, 'g2', -1);
    expect(moved?.map((s) => s.id)).toEqual(['t', 'g2', 'g1']);
    expect(moved?.map((s) => s.displayOrder)).toEqual([0, 1, 2]);
    expect(moveSponsor(list, 'g2', 1)).toBeNull();
  });

  test('placement preview lists active sponsors for that placement only', () => {
    const list = [
      sponsor('home', 'GOLD', 0),
      sponsor('footer', 'GOLD', 1, { placements: ['FOOTER'] }),
      sponsor('inactive', 'GOLD', 2, { isActive: false })
    ];
    expect(sponsorsForPlacement(list, 'HOME').map((s) => s.id)).toEqual(['home']);
    expect(sponsorsForPlacement(list, 'FOOTER').map((s) => s.id)).toEqual(['footer']);
  });

  test('sponsor validation requires a name, an https website and a placement', () => {
    expect(validateSponsor({ name: 'QA Sponsor', tier: 'GOLD', placements: ['HOME'], websiteUrl: 'https://example.org' })).toEqual({});
    const errors = validateSponsor({ name: ' ', tier: 'GOLD', placements: [], websiteUrl: 'http://example.org' });
    expect(Object.keys(errors).sort()).toEqual(['name', 'placements', 'websiteUrl']);
  });

  test('moveItem swaps neighbours and refuses moves past either end', () => {
    const list = [{ id: '1' }, { id: '2' }, { id: '3' }];
    expect(moveItem(list, '3', -1)?.map((i) => i.id)).toEqual(['1', '3', '2']);
    expect(moveItem(list, '1', -1)).toBeNull();
    expect(moveItem(list, '3', 1)).toBeNull();
  });

  test('gallery details require a title and alternative text', () => {
    expect(validateGalleryDetails({ title: 'QA Arena', altText: 'Two drones in the arena' })).toEqual({});
    expect(Object.keys(validateGalleryDetails({ title: '', altText: ' ' })).sort()).toEqual(['altText', 'title']);
  });
});

describe('Staff console: site information validation mirrors the API', () => {
  test('accepts a complete record', () => {
    expect(validateSiteInfo(validSiteInfo())).toEqual({});
  });

  test('rejects a bad email, telephone format, http links and too many lines or phones', () => {
    const info = validSiteInfo();
    info.email = 'not-an-email';
    info.phones = [{ display: 'Office', tel: '12-34' }];
    info.mapUrl = 'http://maps.example.org';
    info.social = { instagram: 'https://localhost/qa' };
    const errors = validateSiteInfo(info);
    expect(errors.email).toBeDefined();
    expect(errors['phones.0.tel']).toBeDefined();
    expect(errors.mapUrl).toBeDefined();
    expect(errors['social.instagram']).toBeDefined();

    const many = validSiteInfo();
    many.addressLines = Array.from({ length: 7 }, (_, i) => `Line ${i + 1}`);
    many.phones = Array.from({ length: 5 }, () => ({ display: '0120', tel: '+911204806827' }));
    const limits = validateSiteInfo(many);
    expect(limits.addressLines).toMatch(/at most 6/);
    expect(limits.phones).toMatch(/At most 4/);
  });

  test('requires alternative text when an About image is set', () => {
    const info = { ...validSiteInfo(), aboutImageUrl: '/api/uploads/files/qa.png', aboutImageAlt: '' };
    expect(validateSiteInfo(info).aboutImageAlt).toBeDefined();
  });

  test('payload trims values, drops empty entries and strips spaces from dialling numbers', () => {
    const payload = siteInfoPayload({
      ...validSiteInfo(),
      addressLines: [' Line 1 ', ''],
      phones: [{ display: ' 0120 ', tel: '+91 120-480 6827' }, { display: '', tel: '' }],
      mapUrl: '  ',
      social: { linkedin: '', x: ' https://x.com/qa ' }
    });
    expect(payload.addressLines).toEqual(['Line 1']);
    expect(payload.phones).toEqual([{ display: '0120', tel: '+911204806827' }]);
    expect(payload.mapUrl).toBeNull();
    expect(payload.social).toEqual({ x: 'https://x.com/qa' });
  });

  test('https checks follow the API (https only, top-level domain required)', () => {
    expect(isHttpsUrl('https://www.example.org/a')).toBe(true);
    expect(isHttpsUrl('http://www.example.org')).toBe(false);
    expect(isHttpsUrl('https://localhost')).toBe(false);
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(EMPTY_SITE_INFO.addressLines).toHaveLength(1);
  });
});

describe('Staff console: sessions and role access', () => {
  test('user agents are summarised for the sessions list', () => {
    expect(
      summariseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')
    ).toBe('Chrome on Windows');
    expect(summariseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1')).toBe(
      'Safari on iOS'
    );
    expect(summariseUserAgent(null)).toBe('Unknown Device');
  });

  test('tabs follow the API roles: content for administrators, users for the Super Administrator', () => {
    for (const tab of ['sponsors', 'gallery', 'site_info', 'cms_hero']) {
      expect(canOpenTab(tab, 'SUPER_ADMIN')).toBe(true);
      expect(canOpenTab(tab, 'EVENT_ADMIN')).toBe(true);
      expect(canOpenTab(tab, 'JUDGE')).toBe(false);
      expect(canOpenTab(tab, 'INSPECTOR')).toBe(false);
    }
    expect(canOpenTab('users', 'EVENT_ADMIN')).toBe(false);
    expect(canOpenTab('scoring', 'JUDGE')).toBe(true);
    expect(canOpenTab('scrutineering', 'INSPECTOR')).toBe(true);
    expect(TAB_ROLES.security).toEqual(['SUPER_ADMIN', 'EVENT_ADMIN', 'JUDGE', 'INSPECTOR']);
    expect(canOpenTab('security', undefined)).toBe(false);
  });

  test('the API restricts the content endpoints to both administrator roles', () => {
    const controller = fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'src', 'cms', 'site-content.controller.ts'), 'utf-8');
    const roles = controller.match(/@Roles\(([^)]*)\)/g) ?? [];
    expect(roles.length).toBeGreaterThan(0);
    for (const r of roles) expect(r).toBe('@Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)');
  });
});

describe('Staff console: new tabs are wired to the contract endpoints', () => {
  test('navigation lists the new tabs and the step-up dialog is mounted', () => {
    const page = read('app', 'page.tsx');
    for (const id of ["id: 'site_info'", "id: 'sponsors'", "id: 'gallery'", "id: 'security'"]) expect(page).toContain(id);
    expect(page).toContain('<StepUpDialog />');
    expect(page).toContain('visibleNavItems.map');
    expect(page).toContain('formatCountdown(idleSecondsLeft)');
  });

  test('each tab calls the endpoints from the contract', () => {
    const sponsors = read('app', '_components', 'SponsorsTab.tsx');
    expect(sponsors).toContain("adminFetch<Sponsor[] | { items?: Sponsor[] }>('/cms/admin/sponsors')");
    expect(sponsors).toContain("'/cms/admin/sponsors/order', { method: 'PUT'");
    expect(sponsors).toContain('`/cms/admin/sponsors/${pendingDelete.id}`, { method: \'DELETE\' }');
    expect(sponsors).toContain("'/cms/admin/settings/sponsors-section'");
    expect(sponsors).toContain('purpose="SPONSOR_LOGO"');

    const gallery = read('app', '_components', 'GalleryTab.tsx');
    expect(gallery).toContain("'/cms/admin/gallery/order', { method: 'PUT'");
    expect(gallery).toContain("uploadAdminFile(file, 'GALLERY_IMAGE'");
    expect(gallery).toContain("'/cms/admin/settings/gallery-section'");

    const site = read('app', '_components', 'SiteInfoTab.tsx');
    expect(site).toContain("'/cms/admin/settings/site-info', { method: 'PUT'");
    expect(site).toContain('purpose="SITE_IMAGE"');

    const security = read('app', '_components', 'SecurityTab.tsx');
    expect(security).toContain("'/auth/sessions'");
    expect(security).toContain('`/auth/sessions/${target.id}`, { method: \'DELETE\' }');
  });
});

describe('Staff console: step-up re-authentication in the API client', () => {
  const originalFetch = global.fetch;
  let client: typeof import('../apps/admin/src/lib/api-client');

  beforeAll(() => {
    process.env.NEXT_PUBLIC_API_URL = 'http://api.test/api';
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      client = require('../apps/admin/src/lib/api-client');
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    client.setStepUpHandler(null);
  });

  const jsonResponse = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => body }) as Response;
  const STEP_UP = { statusCode: 403, code: 'STEP_UP_REQUIRED', message: 'Confirm this action with your authenticator code.' };

  test('a 403 STEP_UP_REQUIRED prompts once, then retries the original request once', async () => {
    const calls: string[] = [];
    let attempt = 0;
    global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      attempt += 1;
      return attempt === 1 ? jsonResponse(403, STEP_UP) : jsonResponse(200, { success: true });
    }) as typeof fetch;
    const handler = jest.fn(async () => true);
    client.setStepUpHandler(handler);

    await expect(client.adminFetch('/cms/admin/sponsors/abc', { method: 'DELETE' })).resolves.toEqual({ success: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['DELETE http://api.test/api/cms/admin/sponsors/abc', 'DELETE http://api.test/api/cms/admin/sponsors/abc']);
  });

  test('cancelling the prompt aborts with a formal message and does not retry', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(403, STEP_UP));
    global.fetch = fetchMock as unknown as typeof fetch;
    client.setStepUpHandler(async () => false);

    const err = await client.adminFetch('/cms/admin/settings/site-info', { method: 'PUT', body: '{}' }).catch((e: unknown) => e);
    expect(client.isStepUpCancelledError(err)).toBe(true);
    expect((err as Error).message).toBe(client.STEP_UP_CANCELLED_MESSAGE);
    expect((err as Error).message).not.toMatch(/!/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a second STEP_UP_REQUIRED after the retry is reported instead of prompting again', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(403, STEP_UP));
    global.fetch = fetchMock as unknown as typeof fetch;
    const handler = jest.fn(async () => true);
    client.setStepUpHandler(handler);

    const err = await client.adminFetch('/cms/admin/gallery/abc', { method: 'DELETE' }).catch((e: unknown) => e);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(err).toBeInstanceOf(client.ApiError);
    expect((err as InstanceType<typeof client.ApiError>).code).toBe('STEP_UP_REQUIRED');
  });

  test('concurrent requests share a single prompt', async () => {
    let stepped = false;
    global.fetch = jest.fn(async () => (stepped ? jsonResponse(200, { ok: true }) : jsonResponse(403, STEP_UP))) as typeof fetch;
    let release: (value: boolean) => void = () => undefined;
    const handler = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = (value) => {
            stepped = true;
            resolve(value);
          };
        })
    );
    client.setStepUpHandler(handler);

    const both = Promise.all([client.adminFetch('/a', { method: 'DELETE' }), client.adminFetch('/b', { method: 'DELETE' })]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release(true);
    await expect(both).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('a plain 403 (role) is not treated as a step-up request', async () => {
    global.fetch = jest.fn(async () => jsonResponse(403, { statusCode: 403, message: 'Your account role is not permitted to perform this action' })) as typeof fetch;
    const handler = jest.fn(async () => true);
    client.setStepUpHandler(handler);
    await expect(client.adminFetch('/auth/users')).rejects.toThrow('Your account role is not permitted to perform this action');
    expect(handler).not.toHaveBeenCalled();
  });

  test('submitStepUpCode posts the trimmed code and a wrong code does not end the session', async () => {
    const bodies: unknown[] = [];
    global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push([String(url), init?.body]);
      return jsonResponse(400, { code: 'INVALID_STEP_UP_CODE', message: 'The authentication code is not valid.' });
    }) as typeof fetch;
    const sessionHandler = jest.fn();
    client.setSessionExpiredHandler(sessionHandler);
    await expect(client.submitStepUpCode(' 123456 ')).rejects.toThrow('The authentication code is not valid.');
    expect(bodies).toEqual([['http://api.test/api/auth/step-up', JSON.stringify({ code: '123456' })]]);
    expect(sessionHandler).not.toHaveBeenCalled();
    client.setSessionExpiredHandler(null);
  });
});

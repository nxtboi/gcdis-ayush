import * as fs from 'fs';
import * as path from 'path';

/**
 * Public website: console-managed site content (site information, sponsors, gallery).
 * Covers the data layer fallbacks, placement filtering and the wiring of the shared components.
 */
const rootDir = path.resolve(__dirname, '..');
const web = (...p: string[]) => path.join(rootDir, 'apps', 'web', 'src', ...p);
const read = (p: string) => fs.readFileSync(p, 'utf-8');

process.env.NEXT_PUBLIC_API_URL = 'http://localhost:4000/api';
// Required after the env is set: API_BASE_URL is resolved when the module loads.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const content = require('../apps/web/src/lib/site-content') as typeof import('../apps/web/src/lib/site-content');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const site = require('../apps/web/src/lib/site') as typeof import('../apps/web/src/lib/site');

const {
  DEFAULT_SITE_INFO,
  DEFAULT_SPONSORS_SECTION,
  DEFAULT_GALLERY_SECTION,
  normaliseSiteContent,
  normaliseSiteInfo,
  normaliseSponsors,
  normaliseGallery,
  groupSponsorsByTier,
  galleryCategories,
  safeExternalUrl,
  safeImageUrl,
  isApiHostedImage,
  getSiteContent,
  getSponsors,
  getGalleryImages
} = content;

const sponsor = (over: Record<string, unknown>) => ({
  id: 'id',
  name: 'Sponsor',
  tier: 'GOLD',
  logoUrl: null,
  websiteUrl: null,
  description: null,
  placements: ['HOME', 'EVENT', 'FOOTER'],
  isActive: true,
  displayOrder: 0,
  ...over
});

describe('site information fallbacks', () => {
  test('defaults equal the constants in lib/site.ts', () => {
    expect(DEFAULT_SITE_INFO.email).toBe(site.ORG_EMAIL);
    expect(DEFAULT_SITE_INFO.addressLines).toEqual([...site.ORG_ADDRESS_LINES]);
    expect(DEFAULT_SITE_INFO.phones).toEqual(site.ORG_PHONES.map((p) => ({ ...p })));
    expect(DEFAULT_SPONSORS_SECTION).toEqual({
      enabled: true,
      title: 'Sponsors and Partners',
      subtitle: '',
      showOn: { home: true, event: true, footer: true }
    });
    expect(DEFAULT_GALLERY_SECTION).toEqual({ enabled: true, title: 'Gallery', subtitle: '' });
  });

  test.each([undefined, null, 'oops', [], 42])('unusable payload %p falls back to the defaults', (raw) => {
    const out = normaliseSiteContent(raw);
    expect(out.siteInfo).toEqual(DEFAULT_SITE_INFO);
    expect(out.sponsorsSection).toEqual(DEFAULT_SPONSORS_SECTION);
    expect(out.gallerySection).toEqual(DEFAULT_GALLERY_SECTION);
  });

  test('missing or invalid fields fall back individually; valid fields are used', () => {
    const info = normaliseSiteInfo({
      organisationName: '  Centre Name  ',
      email: 'not-an-email',
      addressLines: ['', 42],
      phones: [{ display: 'Office', tel: '12' }, { display: 'Desk', tel: '+91 120 480 6827' }],
      social: { linkedin: 'https://linkedin.com/company/gcdis', instagram: 'javascript:alert(1)', youtube: '' },
      mapUrl: 'ftp://example.com/map',
      aboutImageUrl: '/api/uploads/files/about.webp',
      aboutImageAlt: 'The laboratory'
    });
    expect(info.organisationName).toBe('Centre Name');
    expect(info.shortName).toBe(DEFAULT_SITE_INFO.shortName);
    expect(info.email).toBe(site.ORG_EMAIL);
    expect(info.addressLines).toEqual([...site.ORG_ADDRESS_LINES]);
    expect(info.phones).toEqual([{ display: 'Desk', tel: '+911204806827' }]);
    expect(info.social).toEqual({ linkedin: 'https://linkedin.com/company/gcdis' });
    expect(info.mapUrl).toBeNull();
    expect(info.aboutImageUrl).toBe('http://localhost:4000/api/uploads/files/about.webp');
    expect(info.aboutImageAlt).toBe('The laboratory');
  });

  test('section settings keep defaults for missing keys and respect explicit false', () => {
    const out = normaliseSiteContent({
      sponsorsSection: { enabled: true, title: '', showOn: { home: false } },
      gallerySection: { enabled: false, subtitle: 'Recent activities' }
    });
    expect(out.sponsorsSection).toEqual({
      enabled: true,
      title: 'Sponsors and Partners',
      subtitle: '',
      showOn: { home: false, event: true, footer: true }
    });
    expect(out.gallerySection).toEqual({ enabled: false, title: 'Gallery', subtitle: 'Recent activities' });
  });
});

describe('URL safety', () => {
  test('external links accept only http(s)', () => {
    expect(safeExternalUrl('https://example.com')).toBe('https://example.com/');
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,x')).toBeNull();
    expect(safeExternalUrl('//evil.example')).toBeNull();
    expect(safeExternalUrl(undefined)).toBeNull();
  });

  test('upload paths resolve against the API origin and are optimiser-eligible', () => {
    const url = safeImageUrl('/api/uploads/files/logo.png');
    expect(url).toBe('http://localhost:4000/api/uploads/files/logo.png');
    expect(isApiHostedImage(url as string)).toBe(true);
    expect(isApiHostedImage('https://cdn.example.com/logo.png')).toBe(false);
    expect(safeImageUrl('//evil.example/x.png')).toBeNull();
    expect(safeImageUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('sponsors', () => {
  const list = [
    sponsor({ id: 'p2', name: 'Partner B', tier: 'PARTNER', displayOrder: 2 }),
    sponsor({ id: 'g1', name: 'Gold A', tier: 'GOLD', displayOrder: 1, placements: ['HOME'] }),
    sponsor({ id: 't1', name: 'Title', tier: 'TITLE', displayOrder: 5, placements: ['EVENT', 'FOOTER'] }),
    sponsor({ id: 'p1', name: 'Partner A', tier: 'PARTNER', displayOrder: 1 }),
    sponsor({ id: 'off', name: 'Inactive', isActive: false }),
    sponsor({ id: 'bad', name: '' }),
    'not an object'
  ];

  test('ordered by tier rank then displayOrder; inactive and malformed entries dropped', () => {
    expect(normaliseSponsors(list).map((s) => s.id)).toEqual(['t1', 'g1', 'p1', 'p2']);
  });

  test('placement filtering keeps only sponsors listed for that placement', () => {
    expect(normaliseSponsors(list, 'HOME').map((s) => s.id)).toEqual(['g1', 'p1', 'p2']);
    expect(normaliseSponsors(list, 'EVENT').map((s) => s.id)).toEqual(['t1', 'p1', 'p2']);
    expect(normaliseSponsors(list, 'FOOTER').map((s) => s.id)).toEqual(['t1', 'p1', 'p2']);
  });

  test('unknown tiers become PARTNER; unsafe website URLs are removed; logos resolve to the API host', () => {
    const [s] = normaliseSponsors([
      sponsor({ tier: 'DIAMOND', websiteUrl: 'javascript:alert(1)', logoUrl: '/api/uploads/files/l.png' })
    ]);
    expect(s.tier).toBe('PARTNER');
    expect(s.websiteUrl).toBeNull();
    expect(s.logoUrl).toBe('http://localhost:4000/api/uploads/files/l.png');
  });

  test('grouping uses the formal tier labels and omits empty tiers', () => {
    const groups = groupSponsorsByTier(normaliseSponsors(list));
    expect(groups.map((g) => [g.tier, g.label, g.heading, g.sponsors.length])).toEqual([
      ['TITLE', 'Title Sponsor', 'Title Sponsor', 1],
      ['GOLD', 'Gold Sponsor', 'Gold Sponsors', 1],
      ['PARTNER', 'Partner', 'Partners', 2]
    ]);
  });

  test('non-array payloads give an empty list', () => {
    expect(normaliseSponsors({ data: [] })).toEqual([]);
    expect(normaliseSponsors(null, 'HOME')).toEqual([]);
  });
});

describe('gallery', () => {
  test('published images only, ordered, with alt text falling back to the title', () => {
    const out = normaliseGallery([
      { id: 'b', imageUrl: '/api/uploads/files/b.jpg', title: 'B', altText: 'Alt B', displayOrder: 2, category: 'Workshops' },
      { id: 'a', imageUrl: '/api/uploads/files/a.jpg', title: 'Arena', altText: '', displayOrder: 1, category: 'Events', width: 1200, height: 800 },
      { id: 'hidden', imageUrl: '/api/uploads/files/h.jpg', title: 'H', altText: 'H', isPublished: false },
      { id: 'nourl', imageUrl: '', title: 'X', altText: 'X' }
    ]);
    expect(out.map((i) => i.id)).toEqual(['a', 'b']);
    expect(out[0]).toMatchObject({ altText: 'Arena', width: 1200, height: 800, imageUrl: 'http://localhost:4000/api/uploads/files/a.jpg' });
    expect(galleryCategories(out)).toEqual(['Events', 'Workshops']);
  });
});

describe('server fetchers (mocked fetch)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const respond = (status: number, body: unknown) =>
    jest.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

  test('API unreachable: defaults and empty lists, no throw', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(getSiteContent()).resolves.toEqual({
      siteInfo: DEFAULT_SITE_INFO,
      sponsorsSection: DEFAULT_SPONSORS_SECTION,
      gallerySection: DEFAULT_GALLERY_SECTION
    });
    await expect(getSponsors('HOME')).resolves.toEqual([]);
    await expect(getGalleryImages()).resolves.toEqual([]);
  });

  test('404 (endpoint not deployed yet) falls back to defaults', async () => {
    global.fetch = respond(404, { statusCode: 404 });
    const out = await getSiteContent();
    expect(out.siteInfo.email).toBe(site.ORG_EMAIL);
  });

  test('requests use the placement query and a 30 s revalidation window', async () => {
    const fetchMock = respond(200, [sponsor({ id: 'x', placements: ['FOOTER'] }), sponsor({ id: 'y', placements: ['HOME'] })]);
    global.fetch = fetchMock;
    const out = await getSponsors('FOOTER');
    expect(out.map((s) => s.id)).toEqual(['x']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:4000/api/cms/sponsors?placement=FOOTER');
    expect(init.next).toEqual({ revalidate: 30 });
  });

  test('site payload from the API is used', async () => {
    global.fetch = respond(200, {
      siteInfo: { ...DEFAULT_SITE_INFO, email: 'secretariat@example.edu', social: { x: 'https://x.com/gcdis' } },
      sponsorsSection: { ...DEFAULT_SPONSORS_SECTION, showOn: { home: true, event: false, footer: true } },
      gallerySection: { enabled: true, title: 'Photographs', subtitle: '' }
    });
    const out = await getSiteContent();
    expect(out.siteInfo.email).toBe('secretariat@example.edu');
    expect(out.siteInfo.social).toEqual({ x: 'https://x.com/gcdis' });
    expect(out.sponsorsSection.showOn.event).toBe(false);
    expect(out.gallerySection.title).toBe('Photographs');
  });
});

describe('wiring of the public pages', () => {
  test('no hard-coded contact details outside lib/site.ts', () => {
    const files = [
      web('components', 'layout', 'Footer.tsx'),
      // Home page body (replaces components/home/HomeSections.tsx) and its content file.
      ...fs.readdirSync(web('components', 'home-bento')).map((f) => web('components', 'home-bento', f)),
      web('lib', 'home-content.ts'),
      web('app', 'events', '[slug]', '_components', 'ChampionshipSections.tsx'),
      web('app', 'portal', '_components', 'AuthView.tsx'),
      web('app', 'portal', '_components', 'DoubtTab.tsx'),
      web('app', 'not-found.tsx')
    ];
    for (const file of files) {
      const code = read(file);
      expect({ file, hit: /gcdisgalgotias@gmail\.com|0120-48068|ORG_EMAIL|ORG_PHONES|ORG_ADDRESS_LINES|SECRETARIAT_EMAIL/.test(code) }).toEqual({
        file,
        hit: false
      });
    }
  });

  test('root layout provides site content and footer sponsors; event layout adds EVENT sponsors', () => {
    const root = read(web('app', 'layout.tsx'));
    expect(root).toContain('<SiteContentProvider content={content} sponsors={{ FOOTER: footerSponsors }}>');
    expect(root).toContain('showOn.footer');
    const event = read(web('app', 'events', '[slug]', 'layout.tsx'));
    expect(event).toContain("getSponsors('EVENT')");
    expect(event).toContain('showOn.event');
    const home = read(web('app', 'page.tsx'));
    expect(home).toContain("getSponsors('HOME')");
    expect(home).toContain('showOn.home');
    expect(home).toContain('gallerySection.enabled');
  });

  test('sponsor links open in a new tab with rel="noopener noreferrer sponsored"', () => {
    const code = read(web('components', 'site', 'Sponsors.tsx'));
    expect(code).toContain("const SPONSOR_LINK_REL = 'noopener noreferrer sponsored';");
    expect(code.match(/target="_blank"/g)?.length).toBe(code.match(/rel=\{SPONSOR_LINK_REL\}/g)?.length);
    expect(code).toContain('Sponsorship Opportunities');
  });

  test('footer renders social icons only for links that are set', () => {
    const code = read(web('components', 'layout', 'Footer.tsx'));
    expect(code).toContain('SOCIAL_KEYS.filter((key) => Boolean(siteInfo.social[key]))');
    expect(code).toContain('socialLinks.length > 0 &&');
  });

  test('lightbox supports Escape, arrow keys and a focus trap', () => {
    const code = read(web('components', 'site', 'GallerySection.tsx'));
    for (const key of ["'Escape'", "'ArrowRight'", "'ArrowLeft'", "'Tab'"]) expect(code).toContain(key);
    expect(code).toContain('aria-modal="true"');
  });

  test('public copy added for site content has no exclamation marks', () => {
    for (const f of ['Sponsors.tsx', 'GallerySection.tsx']) {
      const text = read(web('components', 'site', f)).replace(/!==|!=|!\w|!\(|!\[/g, '');
      expect({ f, bang: /!/.test(text) }).toEqual({ f, bang: false });
    }
  });

  test('next.config.js allows API uploads for the image optimiser', () => {
    const cfg = read(path.join(rootDir, 'apps', 'web', 'next.config.js'));
    expect(cfg).toContain('remotePatterns: uploadImagePatterns()');
    expect(cfg).toContain('/uploads/files/**');
  });
});

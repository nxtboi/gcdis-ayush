import * as fs from 'fs';
import * as path from 'path';
import {
  CHAMPIONSHIP_DATES_LABEL,
  CHAMPIONSHIP_DAYS,
  CHAMPIONSHIP_END_FALLBACK,
  CHAMPIONSHIP_START_FALLBACK,
  MAX_COACHES,
  MAX_ROSTER
} from '../apps/web/src/lib/championship';
import {
  EVENT_DAY_COUNT,
  EVENT_SECTIONS,
  LEGACY_HASHES,
  TAKE_PART_STEPS,
  buildEventJsonLd,
  eventWindow,
  feeLabel,
  isKnownText,
  normaliseEventDetails,
  registrationStatus,
  sectionFromHash,
  serialiseJsonLd,
  toIstIso,
  venueLabel
} from '../apps/web/src/lib/championship-event';

/** Single-page championship event site (/events/drone-soccer-2026). */
const rootDir = path.resolve(__dirname, '..');
const web = (...p: string[]) => path.join(rootDir, 'apps', 'web', 'src', ...p);
const read = (p: string) => fs.readFileSync(p, 'utf-8');
const eventDir = (...p: string[]) => web('app', 'events', '[slug]', ...p);

const page = read(eventDir('page.tsx'));
const sections = read(eventDir('_components', 'ChampionshipSections.tsx'));
const hero = read(eventDir('_components', 'EventHero.tsx'));
const primitives = read(eventDir('_components', 'EventPrimitives.tsx'));
const allSources = [page, sections, hero, primitives, read(web('lib', 'championship-event.ts'))].join('\n');
/** Rendered page sources only (the helpers' comments mention placeholders and fees by design). */
const pageSources = [page, sections, hero, primitives].join('\n');

/** Shape of `GET /events/drone-soccer-2026` (venue still a placeholder in the database). */
const API_EVENT = {
  slug: 'drone-soccer-2026',
  title: 'GCDIS National Drone Soccer Championship 2026',
  startDate: '2026-12-01T03:30:00.000Z',
  endDate: '2026-12-02T12:30:00.000Z',
  venueName: 'Needs input',
  venueAddress: 'Needs input',
  categories: [
    { slug: 'd20', name: 'Class 20 (D20) Drone Soccer', entryFee: 1500, currency: 'INR', isActive: true },
    { slug: 'd40', name: 'Class 40 (D40) Drone Soccer', entryFee: 3500, currency: 'INR', isActive: true }
  ]
};

const SITE_INFO = {
  organisationName: 'Galgotias Centre for Drone Intelligence & Simulation',
  universityName: 'Galgotias University',
  addressLines: ['Galgotias University', 'Plot No. 2, Sector 17-A, Yamuna Expressway', 'Greater Noida, Gautam Buddh Nagar, Uttar Pradesh 203201'],
  email: 'secretariat@example.org'
};

describe('Section anchors and the sticky section nav', () => {
  test('sections are listed in page order and each one is rendered with its anchor', () => {
    expect(EVENT_SECTIONS.map((s) => s.id)).toEqual([
      'facts',
      'take-part',
      'categories',
      'programme',
      'gallery',
      'partners',
      'prizes',
      'rules',
      'teams',
      'scores',
      'venue',
      'register'
    ]);
    for (const { id } of EVENT_SECTIONS) expect({ id, rendered: sections.includes(`id="${id}"`) }).toEqual({ id, rendered: true });
    // Class cards keep their own anchors (#d20, #d40) through the Tilt wrapper.
    expect(sections).toContain('<Tilt id={spec.id}');
  });

  test('the FAQ section has been removed everywhere', () => {
    expect(EVENT_SECTIONS.some((s) => (s.id as string) === 'faq')).toBe(false);
    expect(sections).not.toContain('id="faq"');
    expect(sectionFromHash('#faq')).toBeNull();
    expect(JSON.stringify(buildEventJsonLd({ details: normaliseEventDetails(API_EVENT), siteInfo: SITE_INFO, siteUrl: 'https://www.gcdis.in' }))).not.toContain('FAQPage');
  });

  test('the nav does scroll-spy with aria-current and lists every section (all are always rendered)', () => {
    expect(sections).toContain('getBoundingClientRect().top <= SPY_OFFSET');
    expect(sections).toContain("aria-current={isActive ? 'true' : undefined}");
    expect(sections).toContain('const sections = EVENT_SECTIONS;');
    expect(sections).toContain('<GallerySection content={gallery} />');
    expect(sections).toContain('<SponsorsSection sponsors={sponsors}');
    expect(sections).not.toMatch(/\{show(Sponsors|Gallery) &&/);
    expect(sections).toContain('sponsorsSection.enabled && sponsorsSection.showOn.event');
    // The sticky nav keeps the countdown but no Register button (owner's request, 16 Oct 2026).
    expect(sections).not.toContain("{registrationOpen ? 'Register' : 'Team Portal'}");
    expect(sections).toContain('<NavCountdown startsAt={startsAt} endsAt={endsAt} />');
  });
});

describe('Old tab fragments', () => {
  test.each([
    ['#overview', 'facts', 'facts'],
    ['#categories', 'categories', 'categories'],
    ['#d20', 'categories', 'd20'],
    ['#D40', 'categories', 'd40'],
    ['#rules', 'rules', 'rules'],
    ['#safety', 'rules', 'rules'],
    ['#schedule', 'programme', 'programme'],
    ['#fixtures', 'programme', 'programme'],
    ['#teams', 'teams', 'teams'],
    ['#scoring', 'scores', 'scores'],
    ['#live', 'scores', 'scores'],
    ['#scores', 'scores', 'scores'],
    ['#sponsors', 'partners', 'partners'],
    ['contact', 'venue', 'venue'],
    ['#programme', 'programme', 'programme']
  ])('%s lands on %s', (hash, section, elementId) => {
    expect(sectionFromHash(hash)).toEqual({ section, elementId });
  });

  test('unknown fragments are ignored', () => {
    expect(sectionFromHash('')).toBeNull();
    expect(sectionFromHash('#nothing-here')).toBeNull();
    expect(Object.values(LEGACY_HASHES).every((s) => EVENT_SECTIONS.some((e) => e.id === s))).toBe(true);
  });

  test('the page rewrites legacy fragments to the section anchor and re-aligns after data loads', () => {
    expect(sections).toContain('sectionFromHash(window.location.hash)');
    expect(sections).toContain("window.history.replaceState(window.history.state, '', `#${target.elementId}`)");
    expect(sections).toContain("window.addEventListener('hashchange', onHash)");
  });
});

describe('Event details from the API', () => {
  const details = normaliseEventDetails(API_EVENT);

  test('placeholder venues are never shown', () => {
    expect(isKnownText('Needs input')).toBe(false);
    expect(isKnownText('TBD')).toBe(false);
    expect(details.venueName).toBeNull();
    expect(details.venueAddress).toBeNull();
  });

  test('entry fees come from the API categories, formatted in rupees', () => {
    expect(feeLabel(details, 'd20')).toBe('₹1,500');
    expect(feeLabel(details, 'd40')).toBe('₹3,500');
    expect(feeLabel(null, 'd20')).toBeNull();
    expect(feeLabel(normaliseEventDetails({ categories: [{ slug: 'd20', entryFee: 0 }] }), 'd20')).toBeNull();
    // The page renders the fees only through feeLabel (never a hard-coded amount).
    expect(sections).toContain("feeLabel(details, 'd20')");
    expect(sections).toContain("feeLabel(details, 'd40')");
    expect(pageSources).not.toMatch(/₹\s?1,500|₹\s?3,500|\b1500\b|\b3500\b/);
    expect(sections).toContain('GST-inclusive');
  });

  test('registration status follows the active categories', () => {
    expect(registrationStatus(details)).toBe('open');
    expect(registrationStatus(normaliseEventDetails({ categories: [{ slug: 'd20', isActive: false }] }))).toBe('closed');
    expect(registrationStatus(null)).toBe('unknown');
  });

  test('venue: real API venue, else the host university and city from site information, else nothing', () => {
    expect(venueLabel(details, SITE_INFO)).toBe('Galgotias University, Greater Noida');
    expect(venueLabel(normaliseEventDetails({ ...API_EVENT, venueName: 'Indoor Arena' }), SITE_INFO)).toBe('Indoor Arena');
    expect(venueLabel(null, { universityName: 'Galgotias University', addressLines: ['Galgotias University', 'Uttar Pradesh'] })).toBe('Galgotias University');
    expect(venueLabel(null, { universityName: 'Galgotias University', addressLines: [] })).toBeNull();
  });
});

describe('Dates: 1 and 2 December 2026', () => {
  test('two programme days, compressed from the existing activities, with no times', () => {
    expect(CHAMPIONSHIP_DATES_LABEL).toBe('1–2 December 2026');
    expect(EVENT_DAY_COUNT).toBe(2);
    expect(CHAMPIONSHIP_DAYS.map((d) => d.date)).toEqual(['1 December', '2 December']);
    expect(CHAMPIONSHIP_DAYS[0].detail).toMatch(/weighing of drone balls/);
    expect(CHAMPIONSHIP_DAYS[1].detail).toMatch(/prize distribution ceremony/);
    for (const d of CHAMPIONSHIP_DAYS) expect(`${d.title} ${d.detail}`).not.toMatch(/\d{1,2}:\d{2}|\b(am|pm)\b/i);
    expect(allSources).not.toMatch(/November|12–15|Four days/);
  });

  test('the countdown window comes from the API, with the IST fallback', () => {
    expect(toIstIso('2026-12-01T03:30:00.000Z')).toBe('2026-12-01T09:00:00+05:30');
    expect(eventWindow(normaliseEventDetails(API_EVENT))).toEqual({ startsAt: '2026-12-01T09:00:00+05:30', endsAt: '2026-12-02T18:00:00+05:30' });
    expect(eventWindow(null)).toEqual({ startsAt: CHAMPIONSHIP_START_FALLBACK, endsAt: CHAMPIONSHIP_END_FALLBACK });
    expect(CHAMPIONSHIP_START_FALLBACK).toBe('2026-12-01T09:00:00+05:30');
    expect(CHAMPIONSHIP_END_FALLBACK).toBe('2026-12-02T18:00:00+05:30');
    // An end before the start is rejected.
    expect(normaliseEventDetails({ startDate: '2026-12-02T00:00:00Z', endDate: '2026-12-01T00:00:00Z' }).startsAt).toBeNull();
    expect(page).toContain('eventWindow(details)');
    expect(hero).toContain('useEventCountdown(startsAt, endsAt)');
  });
});

describe('Event JSON-LD', () => {
  const ld = buildEventJsonLd({ details: normaliseEventDetails(API_EVENT), siteInfo: SITE_INFO, siteUrl: 'https://www.gcdis.in' });

  test('SportsEvent with dates, location, organiser, url and the two entry fees in INR', () => {
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toBe('SportsEvent');
    expect(ld.name).toBe('Drone Soccer Championship 2026');
    expect(ld.startDate).toBe('2026-12-01T09:00:00+05:30');
    expect(ld.endDate).toBe('2026-12-02T18:00:00+05:30');
    expect(ld.url).toBe('https://www.gcdis.in/events/drone-soccer-2026');
    expect(ld.location).toMatchObject({ '@type': 'Place', name: 'Galgotias University, Greater Noida' });
    expect(ld.organizer).toMatchObject({ '@type': 'Organization', name: SITE_INFO.organisationName });
    const offers = ld.offers as { price: number; priceCurrency: string }[];
    expect(offers.map((o) => [o.price, o.priceCurrency])).toEqual([
      [1500, 'INR'],
      [3500, 'INR']
    ]);
  });

  test('unknown facts are left out', () => {
    const bare = buildEventJsonLd({ details: null, siteInfo: { ...SITE_INFO, addressLines: [] }, siteUrl: 'https://www.gcdis.in' });
    expect(bare.offers).toBeUndefined();
    expect(bare.location).toBeUndefined();
    expect(bare.startDate).toBe('2026-12-01T09:00:00+05:30');
    expect(JSON.stringify(ld)).not.toMatch(/Needs input|deadline|validThrough/i);
  });

  test('serialised safely and rendered with the CSP nonce', () => {
    expect(serialiseJsonLd({ a: '</script><b>&' })).toBe('{"a":"\\u003c/script\\u003e\\u003cb\\u003e\\u0026"}');
    expect(page).toContain("requestHeaders.get('x-nonce')");
    expect(page).toMatch(/<script type="application\/ld\+json" nonce=\{nonce\} suppressHydrationWarning dangerouslySetInnerHTML=\{\{ __html: jsonLd \}\} \/>/);
  });
});

describe('Page content and design', () => {
  test('one h1; the hero has equal-width transparent buttons to the portal, programme and live scores', () => {
    expect(page.match(/<h1\b/g)).toHaveLength(1);
    expect(sections).not.toMatch(/<h1\b/);
    expect(hero).toContain('border border-white/30 bg-white/5');
    expect(hero).toContain('sm:w-52');
    for (const href of ['href="/portal"', 'href="#programme"', 'href="#scores"']) expect(hero).toContain(href);
  });

  test('key facts and rules state the roster limits; the take-part steps follow the portal flow', () => {
    expect([MAX_ROSTER, MAX_COACHES]).toEqual([7, 3]);
    expect(sections).toContain('Up to {MAX_ROSTER} members, at most {MAX_COACHES} of them coaches');
    expect(sections).toContain('A team roster may include up to ${MAX_ROSTER} members');
    expect(TAKE_PART_STEPS.map((s) => s.title)).toEqual([
      'Create an account',
      'Verify your email',
      'Add team members',
      'Submit registration',
      'Pay the entry fee',
      'Document review',
      'Technical inspection',
      'Compete'
    ]);
    expect(TAKE_PART_STEPS[1].detail).toContain('6-digit code');
  });

  test('no invented facts: no deadline, sponsor names or hard-coded contact details', () => {
    expect(pageSources).not.toMatch(/deadline|closes on|last date|gcdisgalgotias@gmail\.com|0120-48068|Needs input/i);
    expect(sections).toContain('useSiteInfo()');
  });

  test('a sibling of the home page bento design; the live-score logic is kept', () => {
    expect(primitives).toContain("from '@/components/home-bento/BentoCard'");
    expect(primitives).toContain("from '@/components/home-bento/Section'");
    expect(hero).toContain("from '@/components/home-bento/Countdown'");
    expect(hero).toContain("from '@/components/home-bento/Marquee'");
    expect(sections).toContain('normalizeFixtures(rawFixtures)');
    expect(sections).toContain('useMatchSocket(');
    expect(sections).toContain('POLL_INTERVAL_MS');
    expect(sections).toContain('/scoreboard');
    // Home look: ink-outlined BentoCards with hard shadows, the home tokens, the lime marquee band.
    expect(primitives).toContain("shadow={shadow ?? (dark ? 'lime' : 'ink')}");
    expect(primitives).toContain("from '@/components/home-bento/tokens'");
    expect(hero).toContain('-rotate-[1.5deg] overflow-hidden border-y-[2.5px] border-bento-ink bg-bento-lime');
    expect(pageSources).not.toMatch(/CtaBurst|confetti/);
  });

  test('effects respect prefers-reduced-motion', () => {
    expect(page).toContain('<MotionRoot>');
    expect(primitives).toContain('useReduce()');
    expect(primitives).toContain('usePointerEffects()');
    expect(primitives).toContain('motion-reduce:before:hidden');
    expect(hero).toContain('setAllowed(!reduce && !connection?.saveData)');
  });

  test('no decode / scramble, light sweep or word-by-word heading effects: text renders statically', () => {
    expect(pageSources).not.toMatch(/Scramble|RevealHeading|LightSweep|Eyebrow|hero-sharpen|home-bento\/Text|Magnetic|Spotlight/);
    // Headings are plain elements; their blocks only fade and slide in.
    expect(primitives).toContain('<h2 id={id} className={cx(H2');
    expect(primitives).toContain('initial={{ opacity: 0, y: 22 }}');
    expect(hero).toMatch(/<span className="hero-rise block" style=\{\{ animationDelay: '0\.2s' \}\}>\s*\{lead\}/);
    // Distinct motion: flip countdown digits, count-ups without motion blur, hover shine on buttons.
    expect(hero).toContain('<FlipCountdown parts={parts} />');
    expect(primitives).toContain('initial={reduce ? { opacity: 0 } : { rotateX: -90, opacity: 0 }}');
    expect(sections).toContain('<Counter value={PRIZE_POOL_INR} format="inr"');
    expect(primitives).toContain('export function Counter(');
    expect(primitives).toContain('hover:before:translate-x-[420%]');
  });
});

describe('Championship media (hero video, poster and gallery)', () => {
  // Loaded lazily so the API origin used to resolve upload paths comes from this environment.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const media = require('../apps/web/src/lib/championship-media') as typeof import('../apps/web/src/lib/championship-media');

  test('falls back to the laboratory photograph with no video or gallery when the endpoint is missing', () => {
    expect(media.normaliseChampionshipMedia(undefined)).toEqual({ heroVideoUrl: null, heroPosterUrl: null, gallery: [], sections: {} });
    expect(media.DEFAULT_HERO_POSTER).toBe('/images/gcdis-drone-lab.jpg');
    expect(hero).toContain('posterUrl || DEFAULT_HERO_POSTER');
  });

  test('video URLs must be site uploads or https', () => {
    expect(media.safeVideoUrl('https://cdn.example.org/hero.mp4')).toBe('https://cdn.example.org/hero.mp4');
    expect(media.safeVideoUrl('http://cdn.example.org/hero.mp4')).toBeNull();
    expect(media.safeVideoUrl('javascript:alert(1)')).toBeNull();
    expect(media.safeVideoUrl('/etc/passwd')).toBeNull();
    expect(media.safeVideoUrl('//evil.example/x.mp4')).toBeNull();
    expect(media.safeVideoUrl('/api/uploads/files/../x')).toBeNull();
    const upload = media.safeVideoUrl('/api/uploads/files/abc_123.mp4');
    expect(upload === null || /^https?:\/\/[^/]+\/api\/uploads\/files\/abc_123\.mp4$/.test(upload)).toBe(true);
  });

  test('gallery items are validated: known kinds, safe image URLs, no duplicates', () => {
    const out = media.normaliseChampionshipMedia({
      heroVideoUrl: 'data:video/mp4;base64,AAAA',
      heroPosterUrl: 'https://cdn.example.org/poster.jpg',
      gallery: [
        { id: 'a', imageUrl: 'https://cdn.example.org/a.jpg', caption: ' Class 40 drone ball ', kind: 'drone' },
        { id: 'a', imageUrl: 'https://cdn.example.org/dup.jpg', caption: null, kind: 'arena' },
        { id: 'b', imageUrl: 'javascript:alert(1)', caption: null, kind: 'arena' },
        { id: 'c', imageUrl: 'https://cdn.example.org/c.jpg', caption: null, kind: 'stadium' },
        { id: 'd', imageUrl: 'https://cdn.example.org/d.jpg', caption: '', kind: 'event' }
      ]
    });
    expect(out.heroVideoUrl).toBeNull();
    expect(out.heroPosterUrl).toBe('https://cdn.example.org/poster.jpg');
    expect(out.gallery).toEqual([
      { id: 'a', imageUrl: 'https://cdn.example.org/a.jpg', caption: 'Class 40 drone ball', kind: 'drone' },
      { id: 'd', imageUrl: 'https://cdn.example.org/d.jpg', caption: null, kind: 'event' }
    ]);
  });

  test('the hero video is muted, looped, inline, lazy and poster-first; the gallery is always shown', () => {
    // Bento hero: the video sits inside the main hero tile, beside the key-fact tiles.
    expect(page).toContain('<HeroMedia videoUrl={media.heroVideoUrl} posterUrl={media.heroPosterUrl} />');
    expect(page).toContain('lg:col-span-8');
    for (const attr of ['muted', 'loop', 'playsInline', 'autoPlay', 'poster={poster}', "window.addEventListener('load', onLoad, { once: true })"]) {
      expect(hero).toContain(attr);
    }
    expect(hero).toContain('object-cover');
    expect(page).toContain('getChampionshipMedia()');
    expect(page).toContain('gallery={galleryWithFallback(media.gallery, siteGallery)}');
    expect(sections).toContain('More photos of our drones and arena are coming soon.');
    expect(sections).toContain('disabled={count === 0}');
    expect(sections).toContain('<GalleryLightbox');
    expect(read(web('lib', 'championship-media.ts'))).toContain("getPublicJson('/cms/public/championship-media')");
  });

  test('gallery fallback: real site photographs and the laboratory photograph, filed under Event', () => {
    const own = [{ id: 'x', imageUrl: 'https://cdn.example.org/x.jpg', caption: null, kind: 'arena' as const }];
    expect(media.galleryWithFallback(own, [])).toEqual({ items: own, isFallback: false });
    const site = [
      { id: 'g1', imageUrl: 'https://api.example.org/a.jpg', title: 'Arena build', caption: null, altText: 'Arena under construction', category: 'arena', displayOrder: 0, width: null, height: null }
    ];
    const out = media.galleryWithFallback([], site);
    expect(out.isFallback).toBe(true);
    expect(out.items.map((i) => [i.id, i.kind, i.caption])).toEqual([
      ['site-g1', 'event', 'Arena build'],
      ['gcdis-drone-lab', 'event', 'GCDIS drone laboratory, Galgotias University']
    ]);
    expect(out.items[1].imageUrl).toBe(media.DEFAULT_HERO_POSTER);
    expect(media.galleryWithFallback([], []).items).toHaveLength(1);
  });

  test('sponsors: always shown; logo wall in console order, or the sponsorship card with site contact details', () => {
    expect(sections).toContain('[...sponsors].sort((a, b) => a.displayOrder - b.displayOrder)');
    expect(sections).toContain('rel="noopener noreferrer sponsored"');
    expect(sections).toContain('Sponsorship opportunities');
    expect(sections).toContain('Become a sponsor');
    expect(sections).toContain("const mail = site.email ? `mailto:${site.email}");
    expect(sections).toContain('site.phones[0].display');
  });
});

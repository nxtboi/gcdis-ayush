import * as fs from 'fs';
import * as path from 'path';
import {
  formatMatchTime,
  formatStage,
  formatStatus,
  isInProgress,
  mergeFixtureUpdate,
  normalizeFixture,
  normalizeFixtures,
  pickLiveFixture
} from '../apps/web/src/lib/fixtures';
import { formatIssuedDate, normalizeCertificateCode } from '../apps/web/src/lib/certificates';
import { CLASS_SPECS, FIDA_NAME, MAX_COACHES, MAX_ROSTER, PRIZE_POOL_INR, formatInr } from '../apps/web/src/lib/championship';

/** Regression tests for the public-site fixes (championship page, overlay, verification, footer, motion). */
const rootDir = path.resolve(__dirname, '..');
const web = (...p: string[]) => path.join(rootDir, 'apps', 'web', 'src', ...p);
const read = (p: string) => fs.readFileSync(p, 'utf-8');

describe('Fixture normalisation (Match Schedule crash)', () => {
  // Shape returned by GET /competition/fixtures: flat team fields, no nested team objects.
  const apiRow = {
    id: 'f-1',
    matchNumber: 9139,
    stage: 'QUALIFIER',
    status: 'LIVE',
    arenaName: 'Arena Alpha',
    categoryName: 'Class 20 (D20) Drone Soccer',
    currentSet: 1,
    team1Name: 'QA A TEAM',
    team2Name: 'QA B TEAM',
    team1Score: 11,
    team2Score: 1,
    scheduledStart: null
  };

  test('flat API rows normalise without nested team objects', () => {
    const f = normalizeFixture(apiRow)!;
    expect(f.team1).toEqual({ name: 'QA A TEAM', institution: null, score: 11 });
    expect(f.team2.name).toBe('QA B TEAM');
    expect(f.arenaName).toBe('Arena Alpha');
    expect(f.status).toBe('LIVE');
  });

  test('nested socket payloads (match_updated) normalise too', () => {
    const f = normalizeFixture({ id: 'f-2', team1: { name: 'Red', institutionName: 'GU' }, team2: { name: 'Blue' }, arena: { name: 'Beta' } })!;
    expect(f.team1).toEqual({ name: 'Red', institution: 'GU', score: 0 });
    expect(f.arenaName).toBe('Beta');
    expect(f.status).toBe('SCHEDULED');
  });

  test('payloads without an id or of the wrong type are dropped', () => {
    expect(normalizeFixture(null)).toBeNull();
    expect(normalizeFixture({ team1Name: 'x' })).toBeNull();
    expect(normalizeFixtures('nope')).toEqual([]);
    expect(normalizeFixtures([{ id: 'b', matchNumber: 2 }, null, { id: 'a', matchNumber: 1 }]).map((f) => f.id)).toEqual(['a', 'b']);
  });

  test('partial live updates merge into the list; unknown fixtures request a reload', () => {
    const list = [apiRow];
    const merged = mergeFixtureUpdate(list, { id: 'f-1', team2Score: 2, status: undefined })!;
    expect(merged[0].team2Score).toBe(2);
    expect(merged[0].status).toBe('LIVE');
    expect(list[0].team2Score).toBe(1);
    expect(mergeFixtureUpdate(list, { id: 'other', team1Score: 1 })).toBeNull();
  });

  test('labels are formal and the featured match is one in progress', () => {
    expect(formatStage('QUARTER_FINAL')).toBe('Quarter-final');
    expect(formatStage(null)).toBe('Match');
    expect(formatStatus('LIVE')).toBe('In Progress');
    expect(formatStatus('VERIFIED')).toBe('Result Confirmed');
    expect(isInProgress('PAUSED')).toBe(true);
    const fixtures = normalizeFixtures([
      { id: 'a', matchNumber: 1, status: 'COMPLETED' },
      { id: 'b', matchNumber: 2, status: 'LIVE' }
    ]);
    expect(pickLiveFixture(fixtures)?.id).toBe('b');
    expect(pickLiveFixture(normalizeFixtures([{ id: 'a', status: 'SCHEDULED' }]))).toBeNull();
  });

  test('match times are shown in IST', () => {
    expect(formatMatchTime('2026-11-12T04:30:00.000Z')).toMatch(/12 Nov 2026.*10:00/);
    expect(formatMatchTime('not a date')).toBeNull();
  });

  test('the championship page reads fixtures only through the normaliser', () => {
    const sections = read(web('app', 'events', '[slug]', '_components', 'ChampionshipSections.tsx'));
    expect(sections).toContain('normalizeFixtures(rawFixtures)');
    const page = read(web('app', 'events', '[slug]', 'page.tsx'));
    expect(page).not.toContain('fetchApi');
    expect(page).toContain('<ChampionshipSections');
  });
});

describe('Championship facts', () => {
  test('FIDA figures and prizes are stated once, accurately', () => {
    expect(FIDA_NAME).toBe('Federation of International Dronesoccer Association');
    expect(CLASS_SPECS.d20).toMatchObject({ ballDiameter: '20 cm ± 1 cm', maxWeight: '110 g', strikers: 2, goalDiameter: '30 cm' });
    expect(CLASS_SPECS.d40).toMatchObject({ ballDiameter: '40 cm ± 2 cm', maxWeight: '1,100 g', strikers: 1, goalDiameter: '60 cm' });
    expect([MAX_ROSTER, MAX_COACHES]).toEqual([7, 3]);
    expect(formatInr(PRIZE_POOL_INR)).toBe('₹1,00,000');
    const total = [...CLASS_SPECS.d20.prizes, ...CLASS_SPECS.d40.prizes].reduce((sum, p) => sum + p.amount, 0);
    expect(total).toBeLessThanOrEqual(PRIZE_POOL_INR);
  });
});

describe('Certificate verification', () => {
  test('codes are normalised and malformed input is rejected', () => {
    expect(normalizeCertificateCode('  gcdis-cert-2026-6c330230 ')).toBe('GCDIS-CERT-2026-6C330230');
    expect(normalizeCertificateCode('GCDIS CERT 2026')).toBe('GCDIS-CERT-2026');
    expect(normalizeCertificateCode('../etc')).toBeNull();
    expect(normalizeCertificateCode('ab')).toBeNull();
    expect(normalizeCertificateCode('A'.repeat(65))).toBeNull();
  });

  test('issue dates are formatted formally in IST', () => {
    expect(formatIssuedDate('2026-10-11T15:11:59.866Z')).toBe('11 October 2026');
    expect(formatIssuedDate(undefined)).toBeNull();
  });

  test('a /verify entry page exists and the result page offers a retry and a new lookup', () => {
    const index = read(web('app', 'verify', 'page.tsx'));
    expect(index).toContain('robots: { index: false, follow: false }');
    expect(index).toContain('<VerifyForm');
    const result = read(web('app', 'verify', '[code]', 'page.tsx'));
    expect(result).toContain('Try Again');
    expect(result).toContain('<VerifyForm');
    // A failed request must not be presented as an invalid certificate.
    expect(result).toContain('This does not indicate that the certificate is invalid');
  });
});

describe('Footer fragment links', () => {
  test('same-page fragment links use a plain anchor so the championship tabs receive hashchange', () => {
    const footer = read(web('components', 'layout', 'Footer.tsx'));
    expect(footer).toContain('function FooterLink');
    expect(footer).toMatch(/path === pathname/);
    expect(footer).toContain('<a href={`#${hash}`}');
    expect(footer).toContain('#d20');
    expect(footer).toContain('#d40');
  });
});

describe('Broadcast overlay', () => {
  const overlay = read(web('app', 'live', 'overlay', 'page.tsx'));

  test('no locally simulated match clock is shown', () => {
    expect(overlay).not.toMatch(/setInterval\(/);
    expect(overlay).not.toMatch(/seconds\s*:/);
  });

  test('loads the match in progress on open and uses formal, non-bouncing animation', () => {
    expect(overlay).toContain("fetchApi<unknown>('/competition/fixtures')");
    expect(overlay).toContain('pickLiveFixture');
    expect(overlay).not.toContain('animate-bounce');
    expect(overlay).not.toContain('animate-spin');
  });

  test('lower-third mode makes the page background transparent for compositing', () => {
    expect(overlay).toContain("body.style.background = 'transparent'");
  });
});

describe('Motion system', () => {
  test('shared helpers use the formal easing, once-only reveal and the reduced-motion policy', () => {
    const tokens = read(web('components', 'motion', 'tokens.ts'));
    expect(tokens).toContain('[0.22, 1, 0.36, 1]');
    expect(tokens).toContain("{ once: true, margin: '-80px' }");
    expect(read(web('components', 'motion', 'Reveal.tsx'))).toContain('reducedMotion="user"');
    for (const file of ['Reveal.tsx', 'Stagger.tsx', 'CountUp.tsx', 'AnimatedScore.tsx', 'Accordion.tsx']) {
      expect(read(web('components', 'motion', file)).startsWith("'use client';")).toBe(true);
    }
  });

  test('count-up renders the final value first (no hydration mismatch, correct without JavaScript)', () => {
    const countUp = read(web('components', 'motion', 'CountUp.tsx'));
    expect(countUp).toContain('{finalText}');
    expect(countUp).toContain('useReducedMotion');
  });

  test('the championship page is one scrolling page with a scroll-spy section nav (the tabs were replaced)', () => {
    const sections = read(web('app', 'events', '[slug]', '_components', 'ChampionshipSections.tsx'));
    expect(sections).not.toContain('role="tablist"');
    expect(sections).not.toContain('role="tabpanel"');
    expect(sections).toContain('aria-label="Championship sections"');
    expect(sections).toContain("aria-current={isActive ? 'true' : undefined}");
    expect(sections).toContain('layoutId="event-nav-pill"');
  });
});

describe('Public copy', () => {
  test('no emoji in public page sources', () => {
    const files = [
      web('app', 'page.tsx'),
      web('app', 'not-found.tsx'),
      web('app', 'events', '[slug]', 'page.tsx'),
      web('app', 'events', '[slug]', '_components', 'ChampionshipSections.tsx'),
      web('app', 'live', 'overlay', 'page.tsx'),
      web('app', 'verify', '[code]', 'page.tsx'),
      // The home page body (formerly components/home/HomeSections.tsx) is now the bento layout and its content file.
      ...fs.readdirSync(web('components', 'home-bento')).map((f) => web('components', 'home-bento', f)),
      web('lib', 'home-content.ts'),
      web('components', 'layout', 'Footer.tsx'),
      web('components', 'layout', 'Navbar.tsx')
    ];
    for (const file of files) {
      expect({ file, emoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(read(file)) }).toEqual({ file, emoji: false });
    }
  });

  test('contact details on the home page come from the console-managed site information (lib/site.ts fallback)', () => {
    // Contact details on the home page are shown in the bento footer (id="contact").
    const home = read(web('components', 'home-bento', 'BentoFooter.tsx'));
    expect(home).toContain('id="contact"');
    expect(home).toContain("from '@/components/site/SiteContentProvider'");
    expect(home).toContain('siteInfo.addressLines');
    expect(home).toContain('siteInfo.phones');
    expect(home).not.toMatch(/0120-48068/);
    expect(home).not.toContain('gcdisgalgotias@gmail.com');
  });
});

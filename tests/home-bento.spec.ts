import * as fs from 'fs';
import * as path from 'path';
import {
  HOME_CONTENT,
  CHAMPIONSHIP_STARTS_AT,
  resolveHomeContent,
  showPlaceholderContent,
  splitIsoDate,
  statDisplay,
  visibleBlock,
  visibleItems,
  visibleStats,
  type HomeContent
} from '../apps/web/src/lib/home-content';
import { getCountdown, getEventPhase, pad2 } from '../apps/web/src/lib/countdown';

/**
 * Home page "bold bento" redesign: content file and placeholder rule, countdown helper, and the
 * rendering contracts of the section components (checked on their sources, like the other web tests).
 */
const rootDir = path.resolve(__dirname, '..');
const web = (...p: string[]) => path.join(rootDir, 'apps', 'web', 'src', ...p);
const read = (p: string) => fs.readFileSync(p, 'utf-8');
const bento = (f: string) => read(web('components', 'home-bento', f));
const bentoFiles = fs.readdirSync(web('components', 'home-bento'));

/** Every string in a value, recursively. */
function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === 'object') return Object.values(v).flatMap(strings);
  return [];
}

/** True when any object in the value still carries `placeholder: true`. */
function hasPlaceholder(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasPlaceholder);
  if (v && typeof v === 'object') {
    if ((v as { placeholder?: boolean }).placeholder === true) return true;
    return Object.values(v).some(hasPlaceholder);
  }
  return false;
}

describe('home content: placeholder rule', () => {
  test('placeholders are shown outside production, or in production only with the explicit flag', () => {
    expect(showPlaceholderContent({ NODE_ENV: 'development' })).toBe(true);
    expect(showPlaceholderContent({ NODE_ENV: 'test' })).toBe(true);
    expect(showPlaceholderContent({ NODE_ENV: 'production' })).toBe(false);
    expect(showPlaceholderContent({ NODE_ENV: 'production', NEXT_PUBLIC_SHOW_PLACEHOLDER_CONTENT: 'false' })).toBe(false);
    expect(showPlaceholderContent({ NODE_ENV: 'production', NEXT_PUBLIC_SHOW_PLACEHOLDER_CONTENT: 'true' })).toBe(true);
  });

  test('visibleItems / visibleBlock drop placeholders only when they are hidden', () => {
    const items = [{ id: 'a' }, { id: 'b', placeholder: true }, { id: 'c', placeholder: false }];
    expect(visibleItems(items, true).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(visibleItems(items, false).map((i) => i.id)).toEqual(['a', 'c']);
    expect(visibleBlock({ placeholder: true }, false)).toBeNull();
    expect(visibleBlock({ placeholder: true }, true)).toEqual({ placeholder: true });
    expect(visibleBlock(null, true)).toBeNull();
  });

  test('production content contains no placeholder anywhere', () => {
    const prod = resolveHomeContent(false);
    expect(hasPlaceholder(prod)).toBe(false);
    // Sections that consist only of owner-supplied facts end up empty, so the page hides them.
    expect(prod.mous.items).toEqual([]);
    expect(prod.awards.items).toEqual([]);
    expect(prod.testimonials.visitors).toEqual([]);
    expect(prod.testimonials.stories).toEqual([]);
    expect(prod.testimonials.storyVideo).toBeNull();
    expect(prod.about.video).toBeNull();
    expect(prod.mission.roadmap).toBeNull();
    expect(prod.news.items.every((n) => !n.placeholder)).toBe(true);
    expect(prod.programmes.items.every((p) => p.details === null)).toBe(true);
    expect(prod.services.items.every((s) => !s.highlights)).toBe(true);
  });

  test('development content keeps placeholders for layout review', () => {
    const dev = resolveHomeContent(true);
    expect(dev.mous.items.length).toBeGreaterThan(0);
    expect(dev.awards.items.length).toBeGreaterThan(0);
    expect(dev.testimonials.visitors.length).toBeGreaterThan(0);
    expect(dev.about.video).not.toBeNull();
  });

  test('real content survives in production', () => {
    const prod = resolveHomeContent(false);
    expect(prod.centres.items).toHaveLength(5);
    expect(prod.centres.items.map((c) => c.title)).toEqual(
      expect.arrayContaining(['UAV design & prototyping', 'Drone flight arena', 'Robotics, vision & navigation'])
    );
    expect(prod.programmes.items.map((p) => p.title)).toEqual(
      ['Drone pilot training', 'Drone manufacturing', 'Robotics', 'Simulation & autonomy', 'Drone internship']
    );
    expect(prod.services.items.map((s) => s.id)).toEqual([
      'survey-mapping',
      'inspection-monitoring',
      'design-manufacturing',
      'simulation-testing',
      'agricultural-drones',
      'consultancy'
    ]);
    expect(prod.news.items.some((n) => n.href === '/events/drone-soccer-2026')).toBe(true);
    expect(prod.news.nextEvent?.startsAt).toBe('2026-12-01T09:00:00+05:30');
  });

  test('unknown statistics are never shown; known ones render as stated facts', () => {
    const all = HOME_CONTENT.about.stats;
    for (const show of [true, false]) {
      const shown = visibleStats(all, show);
      expect(shown.every((s) => s.value !== null || Boolean(s.text))).toBe(true);
      expect(shown.map((s) => s.id)).not.toContain('students');
    }
    const byId = Object.fromEntries(visibleStats(all, false).map((s) => [s.id, statDisplay(s)]));
    expect(byId.centres).toBe('05');
    expect(byId.arena).toBe('8 × 4 × 3 m');
    expect(byId['prize-pool']).toBe('₹1,00,000');
  });

  test('copy is formal: no "XX" counts and no exclamation marks', () => {
    const text = strings(HOME_CONTENT);
    expect(text.filter((s) => /\bX{2,}\b/.test(s))).toEqual([]);
    expect(text.filter((s) => s.includes('!'))).toEqual([]);
  });

  test('resolveHomeContent does not mutate its source', () => {
    const before = JSON.stringify(HOME_CONTENT);
    resolveHomeContent(false);
    expect(JSON.stringify(HOME_CONTENT)).toBe(before);
    const custom: HomeContent = { ...HOME_CONTENT, mous: { ...HOME_CONTENT.mous, items: [{ ...HOME_CONTENT.mous.items[0], placeholder: false }] } };
    expect(resolveHomeContent(false, custom).mous.items).toHaveLength(1);
  });

  test('ISO dates split without time-zone dependence', () => {
    expect(splitIsoDate('2026-11-12')).toEqual({ month: 'Nov', day: '12', year: '2026' });
    expect(splitIsoDate('2026-13-01')).toBeNull();
    expect(splitIsoDate(undefined)).toBeNull();
    expect(splitIsoDate('12/11/2026')).toBeNull();
  });
});

describe('countdown helper', () => {
  test('counts down to the championship start (1 Dec 2026, 09:00 IST; two days, 1–2 December)', () => {
    expect(CHAMPIONSHIP_STARTS_AT).toBe('2026-12-01T09:00:00+05:30');
    expect(getCountdown(CHAMPIONSHIP_STARTS_AT, '2026-10-15T09:00:00+05:30')).toEqual({
      days: 47,
      hours: 0,
      minutes: 0,
      seconds: 0,
      totalMs: 47 * 86400 * 1000
    });
    const p = getCountdown(CHAMPIONSHIP_STARTS_AT, '2026-11-30T07:58:30+05:30');
    expect(p && [p.days, p.hours, p.minutes, p.seconds]).toEqual([1, 1, 1, 30]);
  });

  test('the result does not depend on the offset used to express "now"', () => {
    expect(getCountdown(CHAMPIONSHIP_STARTS_AT, '2026-10-15T03:30:00Z')).toEqual(getCountdown(CHAMPIONSHIP_STARTS_AT, '2026-10-15T09:00:00+05:30'));
  });

  test('returns null once the start is reached, or for invalid dates', () => {
    expect(getCountdown(CHAMPIONSHIP_STARTS_AT, CHAMPIONSHIP_STARTS_AT)).toBeNull();
    expect(getCountdown(CHAMPIONSHIP_STARTS_AT, '2026-12-01T04:00:00Z')).toBeNull(); // 09:30 IST, after the start
    expect(getCountdown('not a date', Date.now())).toBeNull();
  });

  test('event phase and padding', () => {
    const start = '2026-12-01T09:00:00+05:30';
    const end = '2026-12-02T18:00:00+05:30';
    expect(getEventPhase(start, end, '2026-11-01T00:00:00+05:30')).toBe('upcoming');
    expect(getEventPhase(start, end, '2026-12-01T12:00:00+05:30')).toBe('live');
    expect(getEventPhase(start, end, '2026-12-03T00:00:00+05:30')).toBe('ended');
    expect(pad2(7)).toBe('07');
    expect(pad2(128)).toBe('128');
    expect(pad2(-3)).toBe('00');
  });
});

describe('home page rendering contracts', () => {
  test('app/page.tsx loads the console-managed sections, resolves placeholders on the server and keeps the data wiring', () => {
    const page = read(web('app', 'page.tsx'));
    expect(page).toContain('getHomePage()');
    expect(page).toContain('resolveHomeContent(showPlaceholderContent(), home.content)');
    expect(page).toContain("getSponsors('HOME')");
    expect(page).not.toMatch(/['"]use client['"]/);
  });

  test('the original hero and ticker are kept, with after effects layered on top; the old body sections are gone', () => {
    const home = read(web('components', 'home', 'PublicHomePage.tsx'));
    expect(home).toContain("fetchApi<{ data?: HeroSectionData }>('/cms/section/hero')");
    expect(home).toContain('id="hero-heading"');
    expect(home).toContain('className="hero-kenburns absolute inset-0 -z-20"');
    expect(home).toContain('animate-ticker');
    // Hero copy, buttons, facts and ticker come from the console-managed content (bundled defaults unchanged).
    // The three hero buttons (primary, secondary, optional third) share one style and width
    expect(home).toContain('const heroButtons = [hero.primaryCta, hero.secondaryCta, hero.tertiaryCta].filter(');
    expect(home).toContain('{heroButtons.map((cta) => (');
    expect(home).toContain('sm:w-60');
    expect(home).toContain('content.ticker.items.map');
    // Hero buttons and highlights lead into the main site (owner's request, 16 Oct 2026)
    expect(HOME_CONTENT.hero.primaryCta).toEqual({ label: 'Explore Programmes', href: '#programmes' });
    expect(HOME_CONTENT.hero.secondaryCta).toEqual({ label: 'Our Services', href: '#services' });
    expect(HOME_CONTENT.hero.tertiaryCta).toEqual({ label: 'Events', href: '#news' });
    expect(HOME_CONTENT.hero.facts.map((f) => f.url)).toEqual(['#programmes', '#services', '#centres']);
    // Highlights are links; links to a section that staff switched off are hidden
    expect(home).toContain('const highlights = hero.facts.filter((f) => isShownLink(f.url));');
    expect(home).toContain('aria-label="Explore GCDIS"');
    // After effects: headline blur-to-sharp, light sweep, magnetic CTAs, background parallax, spotlight.
    expect(home).toContain('hero-rise hero-sharpen block');
    expect(home).toContain('<LightSweep />');
    expect(home.match(/<Magnetic key=\{`\$\{cta.href\}-\$\{cta.label\}`\} className="w-full sm:w-auto">/g)).toHaveLength(1);
    expect(home).toContain('<HeroParallax className="absolute inset-0 -z-20">');
    expect(home).toContain('<Spotlight ');
    expect(read(web('app', 'globals.css'))).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.hero-rise\.hero-sharpen \{ animation: none/);
    expect(home).toContain('<HomeBento');
    expect(home).toContain('<BentoFooter');
    expect(home).not.toContain('HomeSections');
    expect(fs.existsSync(web('components', 'home', 'HomeSections.tsx'))).toBe(false);
  });

  test('sections with owner-supplied content render nothing when empty', () => {
    expect(bento('MouStrip.tsx')).toContain('if (content.items.length === 0) return null;');
    expect(bento('AwardsSection.tsx')).toContain('if (tiles.length === 0) return null;');
    expect(bento('TestimonialsSection.tsx')).toContain('if (!hasVisitors && !hasStories) return null;');
    expect(bento('HomeBento.tsx')).toContain('content.centres.items.length > 0 &&');
  });

  test('section ids match the navbar scroll-spy and the footer links', () => {
    const all = bentoFiles.map(bento).join('\n');
    const navbar = read(web('components', 'layout', 'Navbar.tsx'));
    const sections = [...navbar.matchAll(/section: '([a-z-]+)'/g)].map((m) => m[1]);
    expect(sections).toEqual(['about', 'programmes', 'services', 'news', 'contact']);
    for (const id of sections) expect(all).toMatch(new RegExp(`id="${id}"`));
    // The hero scroll cue points at #news.
    expect(read(web('components', 'home', 'PublicHomePage.tsx'))).toContain('href="#news"');
  });

  test('tabs are accessible tablists with arrow-key support and animated indicators', () => {
    for (const f of ['MissionSection.tsx', 'ProgrammesSection.tsx']) {
      const code = bento(f);
      expect(code).toContain('role="tablist"');
      expect(code).toContain('aria-selected={selected}');
      expect(code).toContain('role="tabpanel"');
      expect(code).toContain("'ArrowRight'");
      expect(code).toContain("'ArrowLeft'");
    }
    expect(bento('MissionSection.tsx')).toContain('layoutId="mission-pill"');
    expect(bento('ProgrammesSection.tsx')).toContain('layoutId="programme-underline"');
  });

  test('carousels announce themselves and have visible controls', () => {
    for (const f of ['CentresSection.tsx', 'NewsSection.tsx', 'TestimonialsSection.tsx']) {
      const code = bento(f);
      expect(code).toContain('aria-roledescription="carousel"');
      expect(code).toContain('aria-roledescription="slide"');
      expect(code).toMatch(/aria-label=\{?[`"]Previous/);
    }
    expect(bento('CentresSection.tsx')).toContain("drag={maxIndex > 0 ? 'x' : false}");
  });

  test('reduced motion is respected and pointer effects are desktop-only', () => {
    expect(read(web('components', 'home', 'PublicHomePage.tsx'))).toContain('<MotionConfig reducedMotion="user">');
    const hooks = bento('hooks.ts');
    expect(hooks).toContain('(hover: hover) and (pointer: fine)');
    expect(hooks).toContain('useReducedMotion');
    expect(read(web('app', 'globals.css'))).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.bento-sweep/);
    // The marquee stops on its own and the counters / decoders skip their effect.
    expect(bento('Marquee.tsx')).toContain('if (reduce || paused.current');
    expect(bento('Text.tsx')).toContain('if (!el || !inView || reduce) return;');
  });

  test('time- and device-based output renders after mount only (no hydration mismatch)', () => {
    const countdown = bento('Countdown.tsx');
    expect(countdown).toContain('useState<number | null>(null)');
    expect(countdown).toContain('setNow(Date.now())');
    expect(bento('NewsSection.tsx')).toContain('useEventCountdown(event.startsAt, event.endsAt)');
    expect(bento('Effects.tsx')).toContain('{enabled && (');
    expect(bento('Effects.tsx')).not.toContain('CursorRing');
  });

  test('no inline <script> tags (nonce-based CSP)', () => {
    for (const f of bentoFiles) expect({ f, script: /<script\b/.test(bento(f)) }).toEqual({ f, script: false });
  });

  test('home-content.ts can be moved to the CMS: no functions or JSX in the content object', () => {
    const json = JSON.parse(JSON.stringify(HOME_CONTENT));
    expect(json).toEqual(HOME_CONTENT);
  });
});

describe('Navbar: only the Championship link blinks', () => {
  test('the live item gets the blink class on desktop and mobile; it stops for reduced motion', () => {
    const nav = read(web('components', 'layout', 'Navbar.tsx'));
    expect(nav.match(/nav-live-blink/g)).toHaveLength(2);
    expect(nav).toContain("item.live ? 'nav-live-blink relative' : 'relative'");
    const css = read(web('app', 'globals.css'));
    expect(css).toContain('@keyframes nav-live-blink');
    expect(css).toMatch(/prefers-reduced-motion: reduce\)[\s\S]*\.nav-live-blink,/);
  });
});

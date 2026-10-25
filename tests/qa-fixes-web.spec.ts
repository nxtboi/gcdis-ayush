import * as fs from 'fs';
import * as path from 'path';

/** Static regression checks for the public-site QA fixes (M6, M7, L10, L11, L12). */
describe('QA fixes: public web site', () => {
  const rootDir = path.resolve(__dirname, '..');
  const web = (...p: string[]) => path.join(rootDir, 'apps', 'web', ...p);
  const read = (p: string) => fs.readFileSync(p, 'utf-8');
  const app = (...p: string[]) => web('src', 'app', ...p);

  /** All non-portal TSX sources of the public site. */
  function publicSources(): { file: string; code: string }[] {
    const out: { file: string; code: string }[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'portal') continue;
          walk(full);
        } else if (entry.name.endsWith('.tsx')) {
          out.push({ file: path.relative(rootDir, full), code: read(full) });
        }
      }
    };
    walk(web('src'));
    return out;
  }

  describe('M6: unknown event slugs return 404', () => {
    test('event layout validates the slug server-side and calls notFound()', () => {
      const layout = read(app('events', '[slug]', 'layout.tsx'));
      expect(layout).not.toContain("'use client'");
      expect(layout).toContain("from 'next/navigation'");
      expect(layout).toContain('notFound()');
      expect(layout).toContain('const { slug } = await params;');
      expect(layout).toContain('resolveEvent(slug)');
    });

    test('slug resolution prefers the API and falls back to the known slug list', () => {
      const lib = read(web('src', 'lib', 'events.ts'));
      expect(lib).toContain("'drone-soccer-2026'");
      expect(lib).toContain('/events/${encodeURIComponent(slug)}');
      expect(lib).toContain('res.status === 404');
    });

    test('scoreboard has its own noindex metadata and slug validation', () => {
      const layout = read(app('events', '[slug]', 'scoreboard', 'layout.tsx'));
      expect(layout).toContain('Live Scoreboard');
      expect(layout).toContain('robots: { index: false, follow: false }');
      expect(layout).toContain('notFound()');
    });
  });

  test('branded 404 page with navigation, footer and links', () => {
    const page = read(app('not-found.tsx'));
    expect(page).toContain('<Navbar />');
    expect(page).toContain('<Footer />');
    expect(page).toContain('<main id="main"');
    expect(page).toContain('href="/"');
    expect(page).toContain('href="/events/drone-soccer-2026"');
  });

  describe('L10: SEO', () => {
    test('robots.txt disallows private areas without trailing slashes and keeps the sitemap', () => {
      const robots = read(web('public', 'robots.txt'));
      expect(robots).toMatch(/^Disallow: \/portal$/m);
      expect(robots).toMatch(/^Disallow: \/live$/m);
      expect(robots).toMatch(/^Disallow: \/verify$/m);
      expect(robots).toContain('Sitemap: https://www.gcdis.in/sitemap.xml');
    });

    test('root layout declares the home canonical and a skip link', () => {
      const layout = read(app('layout.tsx'));
      expect(layout).toContain("alternates: { canonical: '/' }");
      expect(layout).toContain('href="#main"');
      expect(layout).toContain('Skip to content');
      expect(layout).toContain('focus:not-sr-only');
    });

    test('event Open Graph keeps image, site name, locale and adds a twitter block', () => {
      const layout = read(app('events', '[slug]', 'layout.tsx'));
      expect(layout).toContain("'/images/gcdis-logo.png'");
      expect(layout).toContain('siteName: SITE_NAME');
      expect(layout).toContain("locale: 'en_IN'");
      expect(layout).toContain('twitter: {');
    });

    test('verify and overlay pages are noindex and set their own og:url', () => {
      for (const p of [app('verify', '[code]', 'layout.tsx'), app('live', 'overlay', 'layout.tsx')]) {
        const code = read(p);
        expect(code).toContain('robots: { index: false, follow: false }');
        expect(code).toContain('canonical: null');
        expect(code).toMatch(/openGraph: \{.*\burl\b/);
      }
    });
  });

  describe('L11: accessibility landmarks and headings', () => {
    test.each([
      // The home page markup lives in components/home/PublicHomePage.tsx (app/page.tsx is a server wrapper that loads CMS data)
      [path.join('..', 'components', 'home', 'PublicHomePage.tsx')],
      [path.join('events', '[slug]', 'page.tsx')],
      [path.join('verify', '[code]', 'page.tsx')]
    ])('%s has exactly one <main id="main">', (rel) => {
      const code = read(app(rel));
      expect(code.match(/<main\b/g)).toHaveLength(1);
      expect(code).toContain('<main id="main">');
    });

    test('home page and footer no longer skip heading levels (no h4)', () => {
      expect(read(app('page.tsx'))).not.toMatch(/<h4\b/);
      expect(read(web('src', 'components', 'layout', 'Footer.tsx'))).not.toMatch(/<h4\b/);
    });

    test('event page goes h1 -> h2 (no h3 directly under the h1)', () => {
      const code = read(app('events', '[slug]', 'page.tsx'));
      expect(code).toMatch(/<h1\b/);
      expect(code).not.toMatch(/<h3\b/);
    });

    test('verify page renders an h1 on the initial (loading) render', () => {
      const code = read(app('verify', '[code]', 'page.tsx'));
      const h1 = code.indexOf('<h1');
      expect(h1).toBeGreaterThan(-1);
      expect(h1).toBeLessThan(code.indexOf('{loading ?'));
      expect(code.match(/<h1\b/g)).toHaveLength(1);
      expect(code).toContain('Certificate Code Not Found');
      expect(code).toContain('VERIFIED OFFICIAL CERTIFICATE');
    });
  });

  test('M7: no low-contrast green or slate-400-on-white combinations in public pages', () => {
    for (const { file, code } of publicSources()) {
      expect({ file, hit: /(?<!:)bg-\[#16A34A\][^"'`]*text-white/.test(code) }).toEqual({ file, hit: false });
      expect({ file, hit: code.includes('text-[#16A34A]') }).toEqual({ file, hit: false });
      expect({ file, hit: /bg-\[#22C55E\][^"'`/]*\btext-white\b/.test(code) }).toEqual({ file, hit: false });
    }
  });

  test('overlay broadcast logo is prioritised', () => {
    expect(read(app('live', 'overlay', 'page.tsx'))).toContain('<Logo size={72} priority />');
  });

  describe('Headers and CSP', () => {
    test('next.config.js hides X-Powered-By and matches the nginx frame-src / img-src policy', () => {
      const cfg = read(web('next.config.js'));
      expect(cfg).toContain('poweredByHeader: false');
      // The CSP moved from next.config.js to the per-request nonce policy in src/lib/csp.ts (set by middleware).
      const csp = read(web('src', 'lib', 'csp.ts'));
      expect(csp).toContain('frame-src https://api.razorpay.com https://checkout.razorpay.com ${GSI.frame}');
      expect(csp).not.toMatch(/'img-src'[^\]]*'https:'/);
    });

    test('www CSP restricts img-src and admin CSP allows API media (nonce policies from middleware; none in nginx)', () => {
      // Security round 3: nginx no longer sends a CSP for www/admin (it would intersect with the nonce policy).
      const nginx = read(path.join(rootDir, 'infra', 'nginx', 'nginx.conf'));
      expect(nginx).not.toMatch(/img-src 'self' data: blob: https:;/);
      const webCsp = read(web('src', 'lib', 'csp.ts'));
      expect(webCsp).toContain("['img-src', \"'self'\", 'data:', 'blob:', ...API.http, RAZORPAY.checkout, RAZORPAY.cdn]");
      expect(webCsp).toContain('frame-src https://api.razorpay.com https://checkout.razorpay.com ${GSI.frame}');
      const adminCsp = read(path.join(rootDir, 'apps', 'admin', 'src', 'lib', 'csp.ts'));
      expect(adminCsp).toContain("['media-src', \"'self'\", 'blob:', ...API.http]");
    });
  });
});

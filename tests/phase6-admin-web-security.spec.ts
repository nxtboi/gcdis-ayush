import * as fs from 'fs';
import * as path from 'path';

describe('Phase 6: Admin Governance, Public Web Portal & Next.js Security Headers', () => {
  const rootDir = path.resolve(__dirname, '..');
  const adminPagePath = path.join(rootDir, 'apps', 'admin', 'src', 'app', 'page.tsx');
  const adminApiClientPath = path.join(rootDir, 'apps', 'admin', 'src', 'lib', 'api-client.ts');
  const webApiClientPath = path.join(rootDir, 'apps', 'web', 'src', 'lib', 'api-client.ts');
  const webPortalPagePath = path.join(rootDir, 'apps', 'web', 'src', 'app', 'portal', 'page.tsx');
  const webNextConfigPath = path.join(rootDir, 'apps', 'web', 'next.config.js');
  const adminNextConfigPath = path.join(rootDir, 'apps', 'admin', 'next.config.js');

  describe('1. Admin Portal Hardening & Real Flow', () => {
    test('Admin page has eliminated fake login and implements real flow (login -> 2FA / enrolment -> forced password change)', () => {
      const code = fs.readFileSync(adminPagePath, 'utf-8');

      // Does not use local fake toggle for 2fa
      expect(code).not.toContain("if (twoFactorCode.length === 6) {\n      setIsAuthenticated(true);");
      // Calls real auth API endpoints
      expect(code).toContain("adminFetch('/auth/login'");
      expect(code).toContain("adminFetch('/auth/2fa/verify-login'");
      expect(code).toContain("adminFetch('/auth/2fa/generate'");
      expect(code).toContain("adminFetch('/auth/2fa/enable'");
      expect(code).toContain("adminFetch('/auth/change-password'");
    });

    test('Admin portal enforces the idle inactivity timeout (server-enforced, default 30 minutes)', () => {
      const code = fs.readFileSync(adminPagePath, 'utf-8');
      // Admin hardening: the console follows the API's ADMIN_IDLE_TIMEOUT_MIN (default 30) instead of a fixed 15
      expect(code).toContain('const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;');
      expect(code).toContain('idleMinutesRef.current * 60 * 1000');
      expect(code).toContain('lastActivityRef');
      expect(code).toContain('handleLogout');
    });

    test('Admin portal supports logout and logout-all session revocation', () => {
      const code = fs.readFileSync(adminPagePath, 'utf-8');
      expect(code).toContain("adminFetch('/auth/logout'");
      expect(code).toContain("adminFetch('/auth/logout-all'");
    });

    test('Admin portal wires every tab to real API without hardcoded component state', () => {
      const code = fs.readFileSync(adminPagePath, 'utf-8');

      // Overview & Checklist
      expect(code).toContain("adminFetch('/cms/admin/checklist')");
      expect(code).toContain("adminFetch('/cms/prizes')");

      // Hero / CMS
      expect(code).toContain("adminFetch('/cms/section/hero')");
      expect(code).toContain("adminFetch('/cms/admin/section/hero/draft'");
      expect(code).toContain("adminFetch(`/cms/admin/section/hero/rollback/${versionNum}`");
      expect(code).toContain("adminFetch('/cms/admin/section/hero/versions')");

      // Registrations
      expect(code).toContain("adminFetch('/registrations");
      expect(code).toContain("adminFetch(`/registrations/${regId}/status`");

      // Scrutineering Inspections
      expect(code).toContain("adminFetch('/inspections')");
      expect(code).toContain("adminFetch('/inspections', {\n        method: 'POST'");

      // Scoring
      expect(code).toContain("adminFetch('/competition/fixtures')");
      expect(code).toContain("adminFetch(`/competition/fixtures/${activeFixture.id}/event`");

      // Audit Logs & CSV Export
      expect(code).toContain("adminFetch(`/audit?");
      expect(code).toContain("downloadAuditCsv");

      // Users & Roles
      expect(code).toContain("adminFetch('/auth/users')");
      expect(code).toContain("adminFetch('/auth/staff-user'");
    });
  });

  describe('2. Public Web Portal & API Client Hardening', () => {
    test('web api-client.ts requires NEXT_PUBLIC_API_URL and fails if missing', () => {
      const code = fs.readFileSync(webApiClientPath, 'utf-8');
      expect(code).toContain('NEXT_PUBLIC_API_URL');
      expect(code).toContain('throw new Error');
      expect(code).not.toContain("process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api'");
    });

    test('web api-client.ts uses credentials: include, deletes localStorage auth, and refreshes once on 401', () => {
      const code = fs.readFileSync(webApiClientPath, 'utf-8');
      expect(code).toContain("credentials: 'include'");
      expect(code).not.toContain("localStorage.getItem('gcdis_token')");
      expect(code).toContain('/auth/refresh');
      expect(code).toContain('_isRetry');
    });

    test('web portal page has replaced localStorage with real API session calls and eliminated localhost URLs', () => {
      const code = fs.readFileSync(webPortalPagePath, 'utf-8');
      expect(code).not.toContain("localStorage.setItem('gcdis_demo_auth'");
      expect(code).not.toContain("localStorage.getItem('gcdis_demo_auth'");
      expect(code).not.toContain("'http://localhost:4000");
    });

    test('web portal replaced window.open with authenticated downloads', () => {
      const code = fs.readFileSync(webPortalPagePath, 'utf-8');
      expect(code).not.toContain("window.open(");
      expect(code).toContain('downloadAuthenticatedFile');
    });

    test('Razorpay checkout script is loaded on-demand on the payment screen', () => {
      const code = fs.readFileSync(webApiClientPath, 'utf-8');
      expect(code).toContain('loadRazorpayCheckout');
      expect(code).toContain('checkout.razorpay.com/v1/checkout.js');

      const portalCode = fs.readFileSync(webPortalPagePath, 'utf-8');
      expect(portalCode).toContain('loadRazorpayCheckout()');
    });
  });

  describe('3. Next.js Security Headers & CSP', () => {
    test('apps/web next.config.js enforces CSP, frame-ancestors, Referrer-Policy and Permissions-Policy', () => {
      const code = fs.readFileSync(webNextConfigPath, 'utf-8');
      // CSP is a per-request nonce policy built in src/lib/csp.ts and set by src/middleware.ts
      const csp = fs.readFileSync(path.join(rootDir, 'apps', 'web', 'src', 'lib', 'csp.ts'), 'utf-8');
      const middleware = fs.readFileSync(path.join(rootDir, 'apps', 'web', 'src', 'middleware.ts'), 'utf-8');
      expect(middleware).toContain('Content-Security-Policy');
      expect(csp).toContain("frame-ancestors 'none'");
      expect(code).toContain('Referrer-Policy');
      expect(code).toContain('strict-origin-when-cross-origin');
      expect(code).toContain('Permissions-Policy');
      expect(code).toContain('camera=(), microphone=(), geolocation=()');
      expect(code).toContain('X-Content-Type-Options');
      expect(code).toContain('nosniff');
    });

    test('apps/admin next.config.js enforces noindex and allows NO third-party scripts', () => {
      const code = fs.readFileSync(adminNextConfigPath, 'utf-8');
      expect(code).toContain('X-Robots-Tag');
      expect(code).toContain('noindex, nofollow, noarchive');
      // CSP is a per-request nonce policy built in src/lib/csp.ts and set by src/middleware.ts
      const csp = fs.readFileSync(path.join(rootDir, 'apps', 'admin', 'src', 'lib', 'csp.ts'), 'utf-8');
      const middleware = fs.readFileSync(path.join(rootDir, 'apps', 'admin', 'src', 'middleware.ts'), 'utf-8');
      expect(middleware).toContain('Content-Security-Policy');
      // Admin CSP must not include third-party scripts like razorpay or cdn scripts
      expect(code).not.toContain('checkout.razorpay.com');
      expect(csp).not.toContain('checkout.razorpay.com');
      expect(csp).toContain("frame-ancestors 'none'");
      expect(code).toContain('nosniff');
    });
  });
});

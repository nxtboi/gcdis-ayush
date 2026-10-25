import * as fs from 'fs';
import * as path from 'path';

/**
 * QA report fixes for the staff console (apps/admin): M2, M3, L5, M5, L6, M7, L12 and the
 * duplicate robots meta. String-level checks plus logic checks of the pure helpers.
 */
describe('QA fixes: staff console', () => {
  const rootDir = path.resolve(__dirname, '..');
  const adminDir = path.join(rootDir, 'apps', 'admin');
  const read = (...parts: string[]) => fs.readFileSync(path.join(adminDir, ...parts), 'utf-8');
  const pageCode = read('src', 'app', 'page.tsx');

  describe('M2: forced password change and revoked sessions', () => {
    test('no dashboard data is loaded while the password change is pending', () => {
      expect(pageCode).toContain('const canLoadData = isAuthenticated && !mustChangePassword;');
      expect(pageCode).toMatch(/if \(!canLoadData\) return;/);
      // Every tab loader effect is gated on canLoadData
      expect(pageCode).not.toMatch(/if \(!isAuthenticated\) return;\s*\n\s*if \(activeTab ===/);
    });

    test('a successful change clears auth state and returns to sign-in with a formal notice', () => {
      expect(pageCode).toContain('Your password has been changed. Please sign in again with your new password.');
      expect(pageCode).toContain('clearSessionState({ notice: PASSWORD_CHANGED_NOTICE });');
      const authScreens = read('src', 'app', '_components', 'AuthScreens.tsx');
      expect(authScreens).toContain('authNotice');
      expect(authScreens).toContain('role="status"');
    });

    test('the API change-password endpoint revokes sessions without issuing a new one', () => {
      const service = fs.readFileSync(path.join(rootDir, 'apps', 'api', 'src', 'auth', 'auth.service.ts'), 'utf-8');
      const body = service.slice(service.indexOf('async changePassword('), service.indexOf('async rotateSession('));
      expect(body).toContain('revokedAt');
      expect(body).not.toContain('createSession');
    });

    test('a 401 session-revoked response returns the console to the sign-in screen', () => {
      expect(pageCode).toContain('setSessionExpiredHandler(');
      expect(pageCode).toContain('SESSION_ENDED_NOTICE');
    });
  });

  describe('adminFetch session handling (logic)', () => {
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
      client.setSessionExpiredHandler(null);
    });

    const jsonResponse = (status: number, body: unknown) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        statusText: String(status),
        json: async () => body
      }) as Response;

    test('401 after a failed refresh calls the handler and throws SessionExpiredError', async () => {
      const calls: string[] = [];
      global.fetch = jest.fn(async (url: RequestInfo | URL) => {
        calls.push(String(url));
        return jsonResponse(401, { message: 'Session has been revoked or expired' });
      }) as typeof fetch;
      const handler = jest.fn();
      client.setSessionExpiredHandler(handler);

      await expect(client.adminFetch('/cms/admin/checklist')).rejects.toBeInstanceOf(client.SessionExpiredError);
      expect(handler).toHaveBeenCalledWith('Session has been revoked or expired');
      expect(calls).toEqual(['http://api.test/api/cms/admin/checklist', 'http://api.test/api/auth/refresh']);
    });

    test('a wrong current password (401 on change-password) is a normal error, not a session end', async () => {
      global.fetch = jest.fn(async () => jsonResponse(401, { message: 'Current password does not match' })) as typeof fetch;
      const handler = jest.fn();
      client.setSessionExpiredHandler(handler);

      const err = await client.adminFetch('/auth/change-password', { method: 'POST' }).catch((e: unknown) => e);
      expect(client.isSessionExpiredError(err)).toBe(false);
      expect((err as Error).message).toBe('Current password does not match');
      expect(handler).not.toHaveBeenCalled();
    });

    test('toPagedResult accepts bare arrays, { items, total } and named collections', () => {
      expect(client.toPagedResult([{ id: 1 }])).toEqual({ items: [{ id: 1 }], total: null });
      expect(client.toPagedResult({ items: [{ id: 2 }], total: 7, page: 1, limit: 25 })).toEqual({ items: [{ id: 2 }], total: 7 });
      expect(client.toPagedResult({ registrations: [{ id: 3 }], total: 802 }, 'registrations')).toEqual({
        items: [{ id: 3 }],
        total: 802
      });
      expect(client.toPagedResult(null)).toEqual({ items: [], total: null });
    });
  });

  describe('M3: paging for registrations, users and the audit log', () => {
    test('lists request pages with the API limit/offset parameters', () => {
      expect(pageCode).toContain("adminFetch('/registrations?' + params.toString())");
      expect(pageCode).toContain("params.set('offset', String(offsetOf(auditPage)));");
      expect(pageCode).toContain('offset: String(offsetOf(usersPage))');
      // The 100-row cap of the old list request is gone for the paged list
      expect(pageCode).not.toContain("const data = await adminFetch('/registrations?limit=100');\n      setRegistrations");
    });

    test('pagination control offers Previous/Next, page X of Y and 25/50/100 rows', () => {
      const pagination = read('src', 'app', '_components', 'Pagination.tsx');
      expect(pagination).toContain('Previous');
      expect(pagination).toContain('Next');
      expect(pagination).toContain('Page {state.page} of {pages}');
      const types = read('src', 'app', '_components', 'types.ts');
      expect(types).toContain('PAGE_SIZE_OPTIONS = [25, 50, 100]');
      for (const tab of ['RegistrationsTab.tsx', 'UsersTab.tsx', 'AuditTab.tsx']) {
        expect(read('src', 'app', '_components', tab)).toContain('<Pagination');
      }
    });

    test('filters reset to the first page', () => {
      expect(pageCode).toContain("setRegStatusFilter(status);\n                setRegPage((prev) => ({ ...prev, page: 1 }));");
      expect(pageCode).toContain('setAuditFilterAction(value);\n                setAuditPage((prev) => ({ ...prev, page: 1 }));');
    });
  });

  describe('L5: staff list excludes team captains', () => {
    test('requests scope=staff and filters by role in the browser', () => {
      expect(pageCode).toContain("scope: 'staff'");
      expect(pageCode).toContain("withMeta: 'true'");
      expect(pageCode).toContain('isStaffRole(u.role)');
      expect(read('src', 'app', '_components', 'UsersTab.tsx')).toContain('isStaffRole(u.role)');
    });

    test('isStaffRole accepts only staff roles', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { isStaffRole } = require('../apps/admin/src/app/_components/types');
      expect(['SUPER_ADMIN', 'EVENT_ADMIN', 'JUDGE', 'INSPECTOR'].every((r) => isStaffRole(r))).toBe(true);
      expect(isStaffRole('TEAM_CAPTAIN')).toBe(false);
      expect(isStaffRole(undefined)).toBe(false);
    });
  });

  describe('M5 and L6: hero text editing and CMS status messages', () => {
    const cmsTab = read('src', 'app', '_components', 'CmsHeroTab.tsx');

    test('text fields with limits and counters are sent at the top level of data', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { HERO_TEXT_LIMITS, heroTextFrom, heroConfigFrom } = require('../apps/admin/src/app/_components/types');
      expect(HERO_TEXT_LIMITS).toEqual({
        headline: 200,
        tagline: 120,
        description: 600,
        announcementTitle: 160,
        announcementDate: 60,
        announcementBody: 1000
      });
      expect(heroTextFrom({ headline: 'H', description: 'x'.repeat(700), focusX: 10 })).toEqual({
        headline: 'H',
        tagline: '',
        description: 'x'.repeat(600),
        announcementTitle: '',
        announcementDate: '',
        announcementBody: ''
      });
      const config = heroConfigFrom({ headline: 'H', focusX: 20 });
      expect(config.focusX).toBe(20);
      expect(config).not.toHaveProperty('headline');
      expect(pageCode).toContain('data: { ...heroConfig, ...text }');
      expect(cmsTab).toContain('{value.length} / {max} characters');
      expect(cmsTab).toContain('<textarea');
    });

    test('draft and publish confirmations use role="status"; errors use role="alert"', () => {
      expect(pageCode).toContain('The public site is unchanged until you publish.');
      expect(pageCode).toContain('Draft saved at ${formatTime(new Date())}.');
      expect(pageCode).toContain('Published. The public site now shows this version.');
      expect(cmsTab).toContain('role="status"');
      expect(cmsTab).toContain('role="alert"');
    });
  });

  describe('M7, L12 and robots meta', () => {
    test('no slate-500 muted text and no white text on #16A34A in the console', () => {
      const dir = path.join(adminDir, 'src', 'app');
      const files = [path.join(dir, 'page.tsx'), ...fs.readdirSync(path.join(dir, '_components')).map((f) => path.join(dir, '_components', f))];
      for (const file of files) {
        const code = fs.readFileSync(file, 'utf-8');
        expect(code).not.toMatch(/text-slate-500|placeholder-slate-500/);
        expect(code).not.toMatch(/bg-\[#16A34A\][^"'`]*text-white/);
      }
    });

    test('admin CSP (src/lib/csp.ts, set by middleware) sets media-src and next.config.js disables X-Powered-By', () => {
      const csp = read('src', 'lib', 'csp.ts');
      expect(csp).toContain("['media-src', \"'self'\", 'blob:', ...API.http]");
      const config = read('next.config.js');
      expect(config).toContain('poweredByHeader: false');
    });

    test('layout keeps metadata.robots without a duplicate manual robots meta', () => {
      const layout = read('src', 'app', 'layout.tsx');
      expect(layout).toContain('robots: {');
      expect(layout).not.toContain('<meta name="robots"');
    });
  });
});

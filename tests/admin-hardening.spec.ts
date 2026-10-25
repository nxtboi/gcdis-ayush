import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtService } from '@nestjs/jwt';
import { of } from 'rxjs';
import { InMemoryPrisma } from './support/in-memory-prisma';

/**
 * Staff console hardening (admin-hardening): idle timeout, concurrent session cap, new-device alerts and email,
 * step-up for sensitive reads, response headers, staff password length, Super Administrator protections and the
 * audit log hash chain. Prisma is the in-memory store or a jest double; no database, SMTP or network is used.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'admin_hardening_test_jwt_secret_0123456789abcdef';
delete process.env.JWT_ADMIN_SECRET;
process.env.ADMIN_IP_ALLOWLIST = '';
delete process.env.ADMIN_IDLE_TIMEOUT_MIN;
delete process.env.ADMIN_MAX_SESSIONS;
delete process.env.ADMIN_LOGOUT_CLEAR_SITE_DATA;

/* eslint-disable @typescript-eslint/no-var-requires */
const { AuthService } = require('../apps/api/src/auth/auth.service');
const { AuthController, adminLogoutClearSiteData } = require('../apps/api/src/auth/auth.controller');
const { JwtStrategy } = require('../apps/api/src/auth/jwt.strategy');
const { TwoFactorService } = require('../apps/api/src/auth/two-factor.service');
const { StepUpGuard, StaffStepUpGuard } = require('../apps/api/src/auth/step-up.guard');
const policy = require('../apps/api/src/auth/staff-session-policy');
const { AuditService } = require('../apps/api/src/audit/audit.service');
const { AuditController } = require('../apps/api/src/audit/audit.controller');
const { UploadsController } = require('../apps/api/src/uploads/uploads.controller');
const chain = require('../apps/api/src/audit/audit-chain');
const { NoStoreForAuthenticatedInterceptor } = require('../apps/api/src/security/no-store.interceptor');
const { MailService } = require('../apps/api/src/mail/mail.service');
const { staffNewSignInNotice } = require('../apps/api/src/mail/mail.templates');
const { SecurityAlertService } = require('../apps/api/src/security/security-alert.service');
const apiPasswordPolicy = require('../apps/api/src/auth/password-policy');
const adminPasswordPolicy = require('../apps/admin/src/lib/password-policy');
const adminCsp = require('../apps/admin/src/lib/csp');
/* eslint-enable @typescript-eslint/no-var-requires */

const root = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const ctx = (req: any, res: any = {}) =>
  ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) }) as any;
const MIN = 60 * 1000;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SA1 = id(1);
const SA2 = id(2);
const EA = id(3);
const CAP = id(4);

function staffUser(uid: string, role: string, extra: Record<string, unknown> = {}) {
  return {
    id: uid,
    email: `${role.toLowerCase()}.${uid.slice(-2)}@hardening.test`,
    passwordHash: '$2b$04$hardeningplaceholderhashvaluehardeningplaceholderha',
    fullName: `Staff ${uid.slice(-2)}`,
    role,
    isActive: true,
    isTwoFactorEnabled: role !== 'TEAM_CAPTAIN',
    mustChangePassword: false,
    ...extra
  };
}

function alertsDouble() {
  return { alert: jest.fn().mockResolvedValue(true), recordWebhookSignatureFailure: jest.fn() } as any;
}

function authService(prisma: any, opts: { alerts?: any; mail?: any; audit?: any } = {}) {
  return new AuthService(
    prisma,
    new JwtService({ secret: process.env.JWT_SECRET }),
    new TwoFactorService(),
    opts.audit,
    opts.alerts,
    opts.mail
  );
}

beforeEach(() => {
  SecurityAlertService.reset();
  MailService.testOutbox.length = 0;
});

// ---------------------------------------------------------------------------------------------------------------
describe('1. Idle timeout for staff sessions', () => {
  const strategy = (prisma: any, audit?: any) => new JwtStrategy(prisma, audit);
  const adminPayload = (sid: string, sub = SA1) => ({ sub, sid, aud: 'gcdis-admin', email: 'x', role: 'SUPER_ADMIN', fullName: 'X' });

  test('ADMIN_IDLE_TIMEOUT_MIN defaults to 30 minutes and is clamped', () => {
    expect(policy.adminIdleTimeoutMinutes({})).toBe(30);
    expect(policy.adminIdleTimeoutMinutes({ ADMIN_IDLE_TIMEOUT_MIN: '45' })).toBe(45);
    expect(policy.adminIdleTimeoutMinutes({ ADMIN_IDLE_TIMEOUT_MIN: '1' })).toBe(5);
    expect(policy.adminIdleTimeoutMinutes({ ADMIN_IDLE_TIMEOUT_MIN: 'x' })).toBe(30);
    expect(policy.adminIdleTimeoutMs({})).toBe(30 * MIN);
  });

  test('an idle staff session is revoked (reason IDLE_TIMEOUT) and answers 401 SESSION_IDLE_TIMEOUT; later requests keep the code', async () => {
    const db = new InMemoryPrisma();
    const now = Date.now();
    db.reset({
      User: [staffUser(SA1, 'SUPER_ADMIN')],
      Session: [
        { id: id(50), userId: SA1, familyId: id(50), refreshTokenHash: 'h50', isActive: true, expiresAt: new Date(now + 3600_000), createdAt: new Date(now - 40 * MIN), lastSeenAt: new Date(now - 31 * MIN) }
      ]
    });
    const audit = { logAction: jest.fn().mockResolvedValue({}) };
    const err: any = await strategy(db, audit).validate({ headers: {}, url: '/api/teams' }, adminPayload(id(50))).catch((e: any) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.getResponse()).toMatchObject({ statusCode: 401, code: 'SESSION_IDLE_TIMEOUT', message: 'You were signed out after 30 minutes of inactivity.' });
    const row = db.rows('Session')[0];
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(row.isActive).toBe(false);
    expect(row.revokedReason).toBe('IDLE_TIMEOUT');
    expect(audit.logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'AUTH_SESSION_IDLE_TIMEOUT', entityId: SA1 }));

    const again: any = await strategy(db).validate({ headers: {}, url: '/api/teams' }, adminPayload(id(50))).catch((e: any) => e);
    expect(again.getResponse()).toMatchObject({ code: 'SESSION_IDLE_TIMEOUT' });
  });

  test('activity is recorded in lastSeenAt at most once a minute, and not for passive (background) requests', async () => {
    const db = new InMemoryPrisma();
    const now = Date.now();
    db.reset({
      User: [staffUser(SA1, 'SUPER_ADMIN')],
      Session: [
        { id: id(51), userId: SA1, familyId: id(51), refreshTokenHash: 'h51', isActive: true, expiresAt: new Date(now + 3600_000), createdAt: new Date(now - 20 * MIN), lastSeenAt: new Date(now - 10 * MIN) },
        { id: id(52), userId: SA1, familyId: id(52), refreshTokenHash: 'h52', isActive: true, expiresAt: new Date(now + 3600_000), createdAt: new Date(now - 20 * MIN), lastSeenAt: new Date(now - 10 * MIN) }
      ]
    });
    const s = strategy(db);
    const user = await s.validate({ headers: {}, url: '/api/teams' }, adminPayload(id(51)));
    expect(user).toMatchObject({ id: SA1, aud: 'gcdis-admin' });
    const seen = db.rows('Session').find((r) => r.id === id(51))!.lastSeenAt.getTime();
    expect(Date.now() - seen).toBeLessThan(5000);

    // Within the minute: no further write
    const writes = () => db.calls.filter((c) => c.model === 'Session' && c.op === 'updateMany').length;
    const before = writes();
    await s.validate({ headers: {}, url: '/api/teams' }, adminPayload(id(51)));
    expect(writes()).toBe(before);

    // Passive request: authenticated, but not activity
    await s.validate({ headers: { [policy.PASSIVE_REQUEST_HEADER]: '1' }, url: '/api/registrations' }, adminPayload(id(52)));
    expect(now - db.rows('Session').find((r) => r.id === id(52))!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(10 * MIN - 1000);
  });

  test('public (captain) sessions are not subject to the idle timeout', async () => {
    const db = new InMemoryPrisma();
    const now = Date.now();
    db.reset({
      User: [staffUser(CAP, 'TEAM_CAPTAIN')],
      Session: [{ id: id(53), userId: CAP, familyId: id(53), refreshTokenHash: 'h53', isActive: true, expiresAt: new Date(now + 3600_000), createdAt: new Date(now - 5 * 24 * 60 * MIN) }]
    });
    const user = await strategy(db).validate({ headers: {}, url: '/api/teams' }, { sub: CAP, sid: id(53), aud: 'gcdis-public' });
    expect(user).toMatchObject({ id: CAP });
    expect(db.rows('Session')[0].revokedAt ?? null).toBeNull();
    expect(db.rows('Session')[0].lastSeenAt ?? null).toBeNull();
  });

  test('refresh of an idle staff session ends the family with SESSION_IDLE_TIMEOUT; an active one carries lastSeenAt over', async () => {
    const crypto = require('crypto');
    const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
    const db = new InMemoryPrisma();
    const now = Date.now();
    db.reset({
      User: [staffUser(SA1, 'SUPER_ADMIN')],
      Session: [
        { id: id(60), userId: SA1, familyId: id(60), refreshTokenHash: hash('idle'), isActive: true, expiresAt: new Date(now + 3600_000), createdAt: new Date(now - 60 * MIN), lastSeenAt: new Date(now - 45 * MIN) },
        { id: id(61), userId: SA1, familyId: id(61), refreshTokenHash: hash('busy'), isActive: true, expiresAt: new Date(now + 3600_000), createdAt: new Date(now - 60 * MIN), lastSeenAt: new Date(now - 3 * MIN) }
      ]
    });
    const svc = authService(db);
    const err: any = await svc.rotateSession('idle', '10.1.1.1', 'Chrome').catch((e: any) => e);
    expect(err.getResponse()).toMatchObject({ statusCode: 401, code: 'SESSION_IDLE_TIMEOUT' });
    expect(db.rows('Session').find((r) => r.id === id(60))!.revokedReason).toBe('IDLE_TIMEOUT');
    // Presenting the same token again is not treated as a replay
    const again: any = await svc.rotateSession('idle').catch((e: any) => e);
    expect(again.getResponse()).toMatchObject({ code: 'SESSION_IDLE_TIMEOUT' });

    const rotated = await svc.rotateSession('busy', '10.1.1.1', 'Chrome');
    const successor = db.rows('Session').find((r) => r.id === rotated.sessionId)!;
    expect(successor.lastSeenAt.getTime()).toBe(now - 3 * MIN);
  });

  test('GET /auth/me tells the console the idle limit for staff sessions only', async () => {
    const controller = new AuthController({ findById: jest.fn().mockResolvedValue({ id: SA1 }) } as any, {} as any);
    expect(await controller.getProfile({ user: { id: SA1, aud: 'gcdis-admin' } })).toEqual({ user: { id: SA1 }, session: { idleTimeoutMinutes: 30 } });
    expect(await controller.getProfile({ user: { id: CAP, aud: 'gcdis-public' } })).toEqual({ user: { id: SA1 } });
  });

  test('console: warning two minutes before, "Stay signed in", idle notice and passive background requests', () => {
    const page = read('apps', 'admin', 'src', 'app', 'page.tsx');
    expect(page).toContain('const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;');
    expect(page).toContain('const IDLE_WARNING_SECONDS = 120;');
    expect(page).toContain('You were signed out after ${minutes} minutes of inactivity.');
    expect(page).toContain('Stay Signed In');
    expect(page).toContain('keepSessionAlive()');
    expect(page).toContain('code === SESSION_IDLE_TIMEOUT_CODE');
    const client = read('apps', 'admin', 'src', 'lib', 'api-client.ts');
    expect(client).toContain("PASSIVE_REQUEST_HEADER = 'X-GCDIS-Passive'");
    expect(client.toLowerCase()).toContain(policy.PASSIVE_REQUEST_HEADER);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('2. Concurrent staff sessions', () => {
  test('ADMIN_MAX_SESSIONS defaults to 3', () => {
    expect(policy.adminMaxSessions({})).toBe(3);
    expect(policy.adminMaxSessions({ ADMIN_MAX_SESSIONS: '5' })).toBe(5);
    expect(policy.adminMaxSessions({ ADMIN_MAX_SESSIONS: '0' })).toBe(3);
  });

  test('a fourth sign-in revokes the oldest session family (SESSION_LIMIT) and raises an alert; captains are not capped', async () => {
    const db = new InMemoryPrisma();
    const now = Date.now();
    const fam = (n: number, ageMin: number) => ({
      id: id(70 + n),
      userId: SA1,
      familyId: id(70 + n),
      refreshTokenHash: `h7${n}`,
      isActive: true,
      expiresAt: new Date(now + 3600_000),
      createdAt: new Date(now - ageMin * MIN),
      ipAddress: '10.0.0.1',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0'
    });
    db.reset({
      User: [staffUser(SA1, 'SUPER_ADMIN'), staffUser(CAP, 'TEAM_CAPTAIN')],
      Session: [fam(1, 30), fam(2, 300), fam(3, 60)]
    });
    const alerts = alertsDouble();
    const svc = authService(db, { alerts });
    const created = await svc['createSession'](SA1, '10.0.0.1', 'Mozilla/5.0 (Windows NT 10.0) Chrome/131.0');
    const rows = db.rows('Session');
    const oldest = rows.find((r) => r.id === id(72))!;
    expect(oldest.revokedReason).toBe('SESSION_LIMIT');
    expect(oldest.isActive).toBe(false);
    expect(rows.filter((r) => r.userId === SA1 && r.isActive && !r.revokedAt).map((r) => r.id).sort()).toEqual([id(71), id(73), created.sessionId].sort());
    expect(alerts.alert).toHaveBeenCalledWith('STAFF_SESSION_LIMIT_REACHED', expect.stringContaining(SA1.slice(-2)), expect.objectContaining({ maxSessions: 3, sessionsSignedOut: 1 }));

    // The revoked session's refresh answers a clear code instead of a replay alarm
    const err: any = await svc.rotateSession('h72-not-a-real-token').catch((e: any) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);

    // Captains keep any number of sessions
    for (let i = 0; i < 4; i++) await svc['createSession'](CAP, '10.0.0.2', 'Chrome');
    expect(db.rows('Session').filter((r) => r.userId === CAP && r.isActive).length).toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('3. New-device / new-location staff sign-in alerts', () => {
  const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
  const FIREFOX_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0';

  test('network (/24, IPv6 /64) and browser family helpers', () => {
    expect(policy.ipNetworkOf('203.0.113.77')).toBe('203.0.113.0/24');
    expect(policy.ipNetworkOf('::ffff:198.51.100.9')).toBe('198.51.100.0/24');
    expect(policy.ipNetworkOf('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(policy.ipNetworkOf('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(policy.userAgentFamily(CHROME_WIN)).toBe('Chrome on Windows');
    expect(policy.userAgentFamily(FIREFOX_MAC)).toBe('Firefox on macOS');
    expect(policy.userAgentFamily(CHROME_WIN.replace('131.0', '132.0'))).toBe('Chrome on Windows');
  });

  function setup(history: Array<{ ip: string; ua: string; daysAgo: number }>, fullName = 'Staff <b>Member</b>') {
    const db = new InMemoryPrisma();
    const now = Date.now();
    db.reset({
      User: [staffUser(SA1, 'SUPER_ADMIN', { fullName })],
      Session: history.map((h, i) => ({
        id: id(80 + i),
        userId: SA1,
        familyId: id(80 + i),
        refreshTokenHash: `h8${i}`,
        isActive: false,
        revokedAt: new Date(now - h.daysAgo * 86400_000),
        expiresAt: new Date(now - h.daysAgo * 86400_000),
        createdAt: new Date(now - h.daysAgo * 86400_000),
        ipAddress: h.ip,
        userAgent: h.ua
      }))
    });
    const alerts = alertsDouble();
    const mail = new MailService();
    const svc = authService(db, { alerts, mail });
    return { db, alerts, svc };
  }

  const flush = () => new Promise((r) => setTimeout(r, 20));

  test('a sign-in from a known /24 and browser family raises nothing', async () => {
    const { svc, alerts } = setup([{ ip: '203.0.113.10', ua: CHROME_WIN, daysAgo: 3 }]);
    await svc['createSession'](SA1, '203.0.113.200', CHROME_WIN.replace('131.0', '132.0'));
    await flush();
    expect(alerts.alert).not.toHaveBeenCalledWith('STAFF_NEW_DEVICE_LOGIN', expect.anything(), expect.anything());
    expect(MailService.testOutbox).toHaveLength(0);
  });

  test('a new network raises STAFF_NEW_DEVICE_LOGIN and emails the staff member an escaped notice', async () => {
    const { svc, alerts, db } = setup([{ ip: '203.0.113.10', ua: CHROME_WIN, daysAgo: 3 }]);
    await svc['createSession'](SA1, '198.51.100.7', CHROME_WIN);
    await flush();
    expect(alerts.alert).toHaveBeenCalledWith(
      'STAFF_NEW_DEVICE_LOGIN',
      expect.stringContaining('198.51.100.0/24'),
      expect.objectContaining({ newNetwork: true, newBrowser: false, browser: 'Chrome on Windows' })
    );
    expect(MailService.testOutbox).toHaveLength(1);
    const mail = MailService.testOutbox[0];
    expect(mail.to).toBe(db.rows('User')[0].email);
    expect(mail.subject).toBe('GCDIS: New sign-in to your staff account');
    expect(mail.text).toContain('IP address: 198.51.100.7');
    expect(mail.text).toContain('Browser: Chrome on Windows');
    expect(mail.text).toMatch(/Time: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC/);
    expect(mail.text).toContain("If this wasn't you, change your password");
    expect(mail.text).toContain('Super Administrator');
    expect(mail.html).toContain('Staff &lt;b&gt;Member&lt;/b&gt;');
    expect(mail.html).not.toContain('<b>Member</b>');
    expect(mail.html).toContain('wasn&#39;t you');
  });

  test('a new browser family, or history older than 30 days, also counts as new', async () => {
    const a = setup([{ ip: '203.0.113.10', ua: CHROME_WIN, daysAgo: 3 }]);
    await a.svc['createSession'](SA1, '203.0.113.10', FIREFOX_MAC);
    await flush();
    expect(a.alerts.alert).toHaveBeenCalledWith('STAFF_NEW_DEVICE_LOGIN', expect.any(String), expect.objectContaining({ newBrowser: true, newNetwork: false }));

    MailService.testOutbox.length = 0;
    const b = setup([{ ip: '203.0.113.10', ua: CHROME_WIN, daysAgo: 45 }]);
    await b.svc['createSession'](SA1, '203.0.113.10', CHROME_WIN);
    await flush();
    expect(b.alerts.alert).toHaveBeenCalledWith('STAFF_NEW_DEVICE_LOGIN', expect.any(String), expect.objectContaining({ newBrowser: true, newNetwork: true }));
    expect(MailService.testOutbox).toHaveLength(1);
  });

  test('refresh rotation never checks; captains never get the notice', async () => {
    const { svc, alerts } = setup([]);
    await svc['createSession'](SA1, '192.0.2.1', CHROME_WIN, 'family', { rotated: true });
    const db: any = (svc as any).prisma;
    db.rows('User').push(staffUser(CAP, 'TEAM_CAPTAIN'));
    await svc['createSession'](CAP, '192.0.2.1', CHROME_WIN);
    await flush();
    expect(alerts.alert).not.toHaveBeenCalled();
    expect(MailService.testOutbox).toHaveLength(0);
  });

  test('the template escapes every interpolated value', () => {
    const m = staffNewSignInNotice('<img src=x>', { time: new Date('2026-10-16T08:00:00Z'), ipAddress: '1.2.3.4"><script>', browser: 'Chrome <x>' });
    expect(m.html).not.toMatch(/<img src=x>|<script>|<x>/);
    expect(m.html).toContain('2026-10-16 08:00:00 UTC');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('4. Step-up for sensitive reads', () => {
  const guardsOf = (cls: any, method: string) => Reflect.getMetadata(GUARDS_METADATA, cls.prototype[method]) || [];

  test('GET /audit/export requires a recent step-up', () => {
    expect(guardsOf(AuditController, 'exportCsv')).toContain(StepUpGuard);
    expect(guardsOf(AuditController, 'getAuditLogs')).not.toContain(StepUpGuard);
  });

  test('GET /uploads/signed-url/:assetId requires a step-up for staff sessions only', () => {
    expect(guardsOf(UploadsController, 'getSignedUrl')).toContain(StaffStepUpGuard);
    const guard = new StaffStepUpGuard();
    const staff = (stepUpAt: Date | null) => ctx({ user: { id: SA1, role: 'EVENT_ADMIN', aud: 'gcdis-admin', stepUpAt } });
    try {
      guard.canActivate(staff(null));
      throw new Error('expected STEP_UP_REQUIRED');
    } catch (err: any) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({ statusCode: 403, code: 'STEP_UP_REQUIRED' });
    }
    expect(() => guard.canActivate(staff(new Date(Date.now() - 11 * MIN)))).toThrow(ForbiddenException);
    expect(guard.canActivate(staff(new Date(Date.now() - MIN)))).toBe(true);
    // Captains opening their own files: unaffected
    expect(guard.canActivate(ctx({ user: { id: CAP, role: 'TEAM_CAPTAIN', aud: 'gcdis-public', stepUpAt: null } }))).toBe(true);
    expect(() => guard.canActivate(ctx({}))).toThrow(UnauthorizedException);
  });

  test('the console prompts through the step-up dialog for both reads (STEP_UP_REQUIRED)', () => {
    const client = read('apps', 'admin', 'src', 'lib', 'api-client.ts');
    const exportFn = client.slice(client.indexOf('export async function downloadAuditCsv'));
    expect(exportFn).toContain('isStepUpRequired(res.status, body)');
    expect(exportFn).toContain('requestStepUp()');
    // Signed URLs are fetched with adminFetch, which already handles STEP_UP_REQUIRED
    expect(read('apps', 'admin', 'src', 'app', '_components', 'documentReview.ts')).toContain('adminFetch<{ url?: string }>(`/uploads/signed-url/');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('5. Response hardening', () => {
  test('authenticated API responses are Cache-Control: no-store; anonymous ones are untouched', (done) => {
    const interceptor = new NoStoreForAuthenticatedInterceptor();
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => (headers[k] = v), headersSent: false };
    interceptor.intercept(ctx({ user: { id: CAP } }, res), { handle: () => of('x') }).subscribe(() => {
      expect(headers['Cache-Control']).toBe('no-store');
      expect(headers['Pragma']).toBe('no-cache');
      const anon: Record<string, string> = {};
      interceptor
        .intercept(ctx({}, { setHeader: (k: string, v: string) => (anon[k] = v) }), { handle: () => of('y') })
        .subscribe(() => {
          expect(anon).toEqual({});
          done();
        });
    });
  });

  test('the interceptor is registered globally', () => {
    expect(read('apps', 'api', 'src', 'security', 'security.module.ts')).toContain('{ provide: APP_INTERCEPTOR, useClass: NoStoreForAuthenticatedInterceptor }');
  });

  test('admin HTML: no-store, X-Robots-Tag noindex/nofollow (middleware and next.config.js), robots.txt disallows all', async () => {
    const middleware = read('apps', 'admin', 'src', 'middleware.ts');
    expect(middleware).toContain("response.headers.set('Cache-Control', 'no-store, max-age=0')");
    expect(middleware).toContain("response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')");
    const sandbox: any = { module: { exports: {} }, process, URL };
    sandbox.exports = sandbox.module.exports;
    vm.runInNewContext(read('apps', 'admin', 'next.config.js'), sandbox);
    const rules = await sandbox.module.exports.headers();
    const all = rules.find((r: any) => r.source === '/:path*');
    expect(all.headers.find((h: any) => h.key === 'X-Robots-Tag').value).toMatch(/noindex, nofollow/);
    expect(read('apps', 'admin', 'public', 'robots.txt').replace(/\r/g, '').trim()).toBe('User-agent: *\nDisallow: /');
  });

  function logoutWith(origin: string) {
    const headers: Record<string, string> = {};
    const cleared: string[] = [];
    const res = { setHeader: (k: string, v: string) => (headers[k] = v), clearCookie: (n: string) => cleared.push(n) };
    const controller = new AuthController(
      { logout: jest.fn().mockResolvedValue({}), sessionIdFromAccessToken: jest.fn().mockReturnValue(null) } as any,
      {} as any
    );
    return controller.logout({ headers: { origin }, cookies: {} }, res).then(() => ({ headers, cleared }));
  }

  test('console sign-out sends Clear-Site-Data: "cache", "storage"; the portal sign-out does not', async () => {
    const admin = await logoutWith('http://localhost:3001');
    expect(admin.headers['Clear-Site-Data']).toBe('"cache", "storage"');
    expect(admin.cleared).toContain('gcdis_admin_access_token');
    const portal = await logoutWith('http://localhost:3000');
    expect(portal.headers['Clear-Site-Data']).toBeUndefined();
    expect(adminLogoutClearSiteData({ ADMIN_LOGOUT_CLEAR_SITE_DATA: 'off' })).toBeNull();
    expect(adminLogoutClearSiteData({ ADMIN_LOGOUT_CLEAR_SITE_DATA: '"cache", "storage", "evil"' })).toBe('"cache", "storage"');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('6. Trusted Types on the console', () => {
  test('enforced in production, report-only in development, with an emergency override', () => {
    expect(adminCsp.trustedTypesMode({ NODE_ENV: 'production' })).toBe('enforce');
    expect(adminCsp.trustedTypesMode({ NODE_ENV: 'development' })).toBe('report-only');
    expect(adminCsp.trustedTypesMode({ NODE_ENV: 'production', ADMIN_TRUSTED_TYPES: 'report-only' })).toBe('report-only');
    expect(adminCsp.withEnforcedTrustedTypes("default-src 'self'")).toBe(
      "default-src 'self'; require-trusted-types-for 'script'; trusted-types nextjs nextjs#bundler 'allow-duplicates'"
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('7. Staff password policy', () => {
  const STRONG_13 = 'Gx7!kq2Lmp9Rz';
  const STRONG_14 = 'Gx7!kq2Lmp9Rzw';

  test('staff need 14 characters, captains stay at 12', async () => {
    expect(STRONG_13).toHaveLength(13);
    const svc = authService({} as any);
    for (const role of ['SUPER_ADMIN', 'EVENT_ADMIN', 'JUDGE', 'INSPECTOR']) {
      const err: any = await svc.validatePasswordPolicy(STRONG_13, 'someone@hardening.test', role).catch((e: any) => e);
      expect(err?.getResponse?.()).toMatchObject({ code: 'WEAK_PASSWORD', message: 'The password must be at least 14 characters long.' });
      await expect(svc.validatePasswordPolicy(STRONG_14, 'someone@hardening.test', role)).resolves.toBeUndefined();
    }
    await expect(svc.validatePasswordPolicy(STRONG_13, 'someone@hardening.test', 'TEAM_CAPTAIN')).resolves.toBeUndefined();
    await expect(svc.validatePasswordPolicy(STRONG_13, 'someone@hardening.test')).resolves.toBeUndefined();
    expect(apiPasswordPolicy.passwordMinLengthForRole('JUDGE')).toBe(14);
    expect(apiPasswordPolicy.passwordMinLengthForRole('TEAM_CAPTAIN')).toBe(12);
  });

  test('change-password applies the staff length; existing staff passwords still sign in (no re-check at login)', async () => {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('Old-Pass-2026!', 4);
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue({ ...staffUser(EA, 'EVENT_ADMIN'), passwordHash: hash }), update: jest.fn() },
      loginAttempt: { count: jest.fn().mockResolvedValue(0), create: jest.fn() },
      session: { updateMany: jest.fn() }
    };
    const svc = authService(prisma);
    const err: any = await svc.changePassword(EA, 'Old-Pass-2026!', STRONG_13).catch((e: any) => e);
    expect(err?.getResponse?.()).toMatchObject({ code: 'WEAK_PASSWORD' });
    expect(prisma.user.update).not.toHaveBeenCalled();
    await expect(svc.changePassword(EA, 'Old-Pass-2026!', STRONG_14)).resolves.toMatchObject({ success: true });
    expect(read('apps', 'api', 'src', 'auth', 'auth.service.ts')).not.toMatch(/login\([^)]*\)[\s\S]{0,400}validatePasswordPolicy/);
  });

  test('the console shows the 14-character policy on the change-password and first-login screens', () => {
    expect(adminPasswordPolicy.PASSWORD_MIN_LENGTH).toBe(14);
    expect(adminPasswordPolicy.passwordChecks('x')[0].label).toBe('At least 14 characters');
    expect(adminPasswordPolicy.passwordPolicyError(STRONG_13, 'a@b.c')).toBe('The password must contain at least 14 characters.');
    const screens = read('apps', 'admin', 'src', 'app', '_components', 'AuthScreens.tsx');
    expect(screens).toContain('Staff accounts need a password of at least {PASSWORD_MIN_LENGTH} characters');
    expect(read('apps', 'admin', 'src', 'app', '_components', 'SecurityTab.tsx')).toContain('<PasswordPolicyList id="security-pw-policy"');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('8. Super Administrator protections', () => {
  function setup(users: any[]) {
    const db = new InMemoryPrisma();
    db.reset({ User: users });
    const alerts = alertsDouble();
    return { db, alerts, svc: authService(db, { alerts }) };
  }
  const actor = (u: any) => ({ id: u.id, email: u.email, role: u.role });

  test('the last active Super Administrator cannot be demoted or deactivated', async () => {
    // SA1 is the only active Super Administrator; SA2 holds the role but is deactivated
    const sa = staffUser(SA1, 'SUPER_ADMIN');
    const inactiveSa = staffUser(SA2, 'SUPER_ADMIN', { isActive: false });
    const { svc, db } = setup([sa, inactiveSa, staffUser(EA, 'EVENT_ADMIN')]);
    // Self-demotion and self-deactivation are refused
    const self: any = await svc.changeUserRole(actor(sa), SA1, 'JUDGE').catch((e: any) => e);
    expect(self.getResponse()).toMatchObject({ code: 'SELF_MODIFICATION_NOT_ALLOWED' });
    const selfStatus: any = await svc.setUserActiveStatus(actor(sa), SA1, false).catch((e: any) => e);
    expect(selfStatus.getResponse()).toMatchObject({ code: 'SELF_MODIFICATION_NOT_ALLOWED' });

    // Demoting or deactivating the only active Super Administrator is refused (actor identity aside)
    const demote: any = await svc.changeUserRole(actor(inactiveSa), SA1, 'JUDGE').catch((e: any) => e);
    expect(demote.getResponse()).toMatchObject({ code: 'LAST_SUPER_ADMIN' });
    const deactivate: any = await svc.setUserActiveStatus(actor(inactiveSa), SA1, false).catch((e: any) => e);
    expect(deactivate.getResponse()).toMatchObject({ code: 'LAST_SUPER_ADMIN' });
    expect(db.rows('User').find((u) => u.id === SA1)).toMatchObject({ role: 'SUPER_ADMIN', isActive: true });
  });

  test('removing the role from (or deactivating) one of two Super Administrators alerts SUPER_ADMIN_ROLE_REVOKED', async () => {
    const sa1 = staffUser(SA1, 'SUPER_ADMIN');
    const sa2 = staffUser(SA2, 'SUPER_ADMIN');
    const { svc, alerts } = setup([sa1, sa2, staffUser(EA, 'EVENT_ADMIN')]);
    await svc.changeUserRole(actor(sa1), SA2, 'EVENT_ADMIN');
    expect(alerts.alert).toHaveBeenCalledWith('SUPER_ADMIN_ROLE_REVOKED', sa2.email, expect.objectContaining({ newRole: 'EVENT_ADMIN', changedBy: sa1.email }));

    await svc.changeUserRole(actor(sa1), EA, 'SUPER_ADMIN');
    expect(alerts.alert).toHaveBeenCalledWith('SUPER_ADMIN_ROLE_GRANTED', expect.any(String), expect.objectContaining({ previousRole: 'EVENT_ADMIN' }));
    alerts.alert.mockClear();
    await svc.setUserActiveStatus(actor(sa1), EA, false, 'left the team');
    expect(alerts.alert).toHaveBeenCalledWith('SUPER_ADMIN_ROLE_REVOKED', expect.any(String), expect.objectContaining({ context: 'account-deactivated' }));
    expect(alerts.alert).toHaveBeenCalledWith('STAFF_ACCOUNT_DEACTIVATED', expect.any(String), expect.anything());
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('9. Audit trail hash chain', () => {
  function service() {
    const db = new InMemoryPrisma();
    db.reset({});
    const alerts = alertsDouble();
    return { db, alerts, audit: new AuditService(db, alerts) };
  }
  const entry = (n: number) => ({
    actorId: SA1,
    actorEmail: 'sa@hardening.test',
    actorRole: 'SUPER_ADMIN',
    action: `ACTION_${n}`,
    entityType: 'Thing',
    entityId: `t-${n}`,
    beforeState: n % 2 ? { b: 1, a: [1, 'x', { z: true, y: null }] } : undefined,
    afterState: { when: new Date('2026-10-16T00:00:00Z'), n, nested: { k2: 'v', k1: 0.1 + 0.2 } },
    ipAddress: '10.0.0.1',
    userAgent: 'jest'
  });

  test('appends link every row to the previous one (genesis = 64 zeros)', async () => {
    const { db, audit } = service();
    for (let i = 1; i <= 5; i++) await audit.logAction(entry(i));
    const rows = db.rows('AuditLog').sort((a, b) => a.chainSeq - b.chainSeq);
    expect(rows.map((r) => r.chainSeq)).toEqual([1, 2, 3, 4, 5]);
    expect(rows[0].prevHash).toBe(chain.AUDIT_CHAIN_GENESIS);
    for (let i = 1; i < rows.length; i++) expect(rows[i].prevHash).toBe(rows[i - 1].rowHash);
    for (const r of rows) {
      expect(r.rowHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.rowHash).toBe(chain.computeAuditRowHash(r));
    }
    // Hash = sha256(prevHash + canonical JSON); key order of JSON values does not matter
    const crypto = require('crypto');
    expect(rows[1].rowHash).toBe(crypto.createHash('sha256').update(rows[1].prevHash + chain.canonicalAuditRow(rows[1])).digest('hex'));
    expect(chain.canonicalJson({ b: 1, a: { d: 2, c: 1 } })).toBe('{"a":{"c":1,"d":2},"b":1}');
    expect(chain.computeAuditRowHash({ ...rows[1], afterState: JSON.parse(JSON.stringify(rows[1].afterState)) })).toBe(rows[1].rowHash);
  });

  test('concurrent appends never fork the chain', async () => {
    const { db } = service();
    await Promise.all(Array.from({ length: 25 }, (_, i) => chain.appendAuditLog(db, entry(i))));
    const seqs = db.rows('AuditLog').map((r) => r.chainSeq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect((await chain.verifyAuditChain(db)).ok).toBe(true);
  });

  test('a unique-index conflict (another API instance) is retried on the new head', async () => {
    const { db } = service();
    await chain.appendAuditLog(db, entry(1));
    const realCreate = (db as any).auditLog.create;
    let injected = false;
    (db as any).auditLog.create = async (args: any) => {
      if (!injected) {
        injected = true;
        // Another instance appends position 2 between our read and our insert
        await realCreate({ data: { ...args.data, id: id(999), action: 'OTHER_INSTANCE', rowHash: chain.computeAuditRowHash({ ...args.data, id: id(999), action: 'OTHER_INSTANCE' }) } });
        const err: any = new Error('Unique constraint failed');
        err.code = 'P2002';
        throw err;
      }
      return realCreate(args);
    };
    await chain.appendAuditLog(db, entry(2));
    expect(db.rows('AuditLog').map((r) => r.chainSeq).sort()).toEqual([1, 2, 3]);
    expect((await chain.verifyAuditChain(db)).ok).toBe(true);
  });

  test('verification passes on an intact chain, counts legacy rows and is audited', async () => {
    const { db, audit, alerts } = service();
    db.rows('AuditLog').push({ id: id(500), action: 'LEGACY', entityType: 'X', createdAt: new Date(Date.now() - 86400_000), chainSeq: null, prevHash: null, rowHash: null });
    for (let i = 1; i <= 3; i++) await audit.logAction(entry(i));
    const report = await audit.verifyChain({ id: SA1, email: 'sa@hardening.test', role: 'SUPER_ADMIN' }, '10.0.0.1', 'jest');
    expect(report).toMatchObject({ ok: true, checkedRows: 3, legacyRows: 1, headSeq: 3, firstBreak: null });
    expect(db.rows('AuditLog').some((r) => r.action === 'AUDIT_CHAIN_VERIFIED' && r.chainSeq === 4)).toBe(true);
    expect(alerts.alert).not.toHaveBeenCalled();
  });

  test('tampering with a row is reported at that row and raises AUDIT_CHAIN_BROKEN', async () => {
    const { db, audit, alerts } = service();
    for (let i = 1; i <= 6; i++) await audit.logAction(entry(i));
    const target = db.rows('AuditLog').find((r) => r.chainSeq === 4)!;
    target.afterState = { ...target.afterState, n: 999 };
    const report = await audit.verifyChain({ id: SA1 });
    expect(report.ok).toBe(false);
    expect(report.checkedRows).toBe(3);
    expect(report.firstBreak).toMatchObject({ chainSeq: 4, id: target.id, reason: 'HASH_MISMATCH' });
    expect(alerts.alert).toHaveBeenCalledWith('AUDIT_CHAIN_BROKEN', expect.any(String), expect.objectContaining({ reason: 'HASH_MISMATCH', chainSeq: 4 }));
  });

  test('a removed row, a re-linked forgery and an unchained insert are each detected', async () => {
    // Removed row
    let s = service();
    for (let i = 1; i <= 5; i++) await s.audit.logAction(entry(i));
    s.db.tables.set('AuditLog', s.db.rows('AuditLog').filter((r) => r.chainSeq !== 3));
    expect((await chain.verifyAuditChain(s.db)).firstBreak).toMatchObject({ chainSeq: 4, reason: 'SEQUENCE_GAP' });

    // Row rewritten with a recomputed own hash: the next row's prevHash no longer matches
    s = service();
    for (let i = 1; i <= 5; i++) await s.audit.logAction(entry(i));
    const forged = s.db.rows('AuditLog').find((r) => r.chainSeq === 2)!;
    forged.actorEmail = 'someone-else@hardening.test';
    forged.rowHash = chain.computeAuditRowHash(forged);
    expect((await chain.verifyAuditChain(s.db)).firstBreak).toMatchObject({ chainSeq: 3, reason: 'PREVIOUS_HASH_MISMATCH' });

    // Row inserted around the application (no chain position) after the chain started
    s = service();
    for (let i = 1; i <= 2; i++) await s.audit.logAction(entry(i));
    s.db.rows('AuditLog').push({ id: id(777), action: 'INJECTED', entityType: 'X', createdAt: new Date(Date.now() + 1000), chainSeq: null, prevHash: null, rowHash: null });
    expect((await chain.verifyAuditChain(s.db)).firstBreak).toMatchObject({ id: id(777), reason: 'UNCHAINED_ROW' });
  });

  test('GET /audit/verify-chain is Super Administrator only; every application insert goes through the chain', () => {
    const roles = Reflect.getMetadata('roles', AuditController.prototype.verifyChain);
    expect(roles).toEqual(['SUPER_ADMIN']);
    for (const file of [
      ['apps', 'api', 'src', 'auth', 'auth.service.ts'],
      ['apps', 'api', 'src', 'auth', 'google-auth.service.ts'],
      ['apps', 'api', 'src', 'audit', 'audit.service.ts'],
      ['apps', 'api', 'prisma', 'bootstrap-admin.ts']
    ]) {
      expect(read(...file)).not.toMatch(/auditLog\.create\(/);
    }
    const migration = read('apps', 'api', 'prisma', 'migrations', '20261017000000_admin_session_idle_and_audit_chain', 'migration.sql');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "rowHash"');
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "audit_logs_chainSeq_key"');
    expect(migration).not.toMatch(/\bUPDATE\s+"?audit_logs|DROP\s+(TABLE|COLUMN)|DELETE\s+FROM/i);
    expect(read('apps', 'api', 'src', 'audit', 'audit-chain.ts')).toContain('pg_advisory_xact_lock');
    expect(read('apps', 'admin', 'src', 'app', '_components', 'SecurityTab.tsx')).toContain('Verify Audit Chain');
  });
});

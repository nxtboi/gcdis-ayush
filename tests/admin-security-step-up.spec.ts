import 'reflect-metadata';
import * as crypto from 'crypto';
import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { AuthController } from '../apps/api/src/auth/auth.controller';
import { JwtStrategy } from '../apps/api/src/auth/jwt.strategy';
import { TwoFactorService } from '../apps/api/src/auth/two-factor.service';
import {
  StepUpGuard,
  STEP_UP_WINDOW_MS,
  adminSessionMaxMs,
  hasRecentStepUp,
  stepUpUntil
} from '../apps/api/src/auth/step-up.guard';
import { isAdminIpAllowed, normaliseIp, parseIpAllowList } from '../apps/api/src/common/utils/ip-allowlist.util';
import { SiteContentController } from '../apps/api/src/cms/site-content.controller';
import { CsrfGuard } from '../apps/api/src/common/guards/csrf.guard';
import { RolesGuard } from '../apps/api/src/auth/roles.guard';

const JWT_SECRET = 'admin_security_step_up_test_secret_value_0123456789';
const ctx = (req: any) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as any;

describe('ADMIN_IP_ALLOWLIST', () => {
  const env = (v?: string) => ({ ADMIN_IP_ALLOWLIST: v } as any);

  test('disabled when empty or unset', () => {
    expect(isAdminIpAllowed('203.0.113.9', env(undefined))).toBe(true);
    expect(isAdminIpAllowed('203.0.113.9', env('   '))).toBe(true);
    expect(parseIpAllowList('').enabled).toBe(false);
  });

  test('matches exact IPv4, CIDR ranges, IPv6 and IPv4-mapped IPv6 addresses', () => {
    const list = env('203.0.113.10, 10.0.0.0/8, 2001:db8::/32, ::1');
    expect(isAdminIpAllowed('203.0.113.10', list)).toBe(true);
    expect(isAdminIpAllowed('203.0.113.11', list)).toBe(false);
    expect(isAdminIpAllowed('10.200.3.4', list)).toBe(true);
    expect(isAdminIpAllowed('::ffff:10.1.2.3', list)).toBe(true);
    expect(isAdminIpAllowed('2001:db8:1::5', list)).toBe(true);
    expect(isAdminIpAllowed('2001:db9::5', list)).toBe(false);
    expect(isAdminIpAllowed('::1', list)).toBe(true);
    expect(isAdminIpAllowed('', list)).toBe(false);
    expect(isAdminIpAllowed('not-an-ip', list)).toBe(false);
    expect(normaliseIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
  });

  test('fails closed when configured with no valid entry', () => {
    const parsed = parseIpAllowList('nonsense, 10.0.0.0/99');
    expect(parsed.enabled).toBe(true);
    expect(parsed.invalid).toEqual(['nonsense', '10.0.0.0/99']);
    expect(isAdminIpAllowed('10.0.0.1', env('nonsense'))).toBe(false);
  });
});

describe('Admin session lifetime', () => {
  test('defaults to 12 hours, honours ADMIN_SESSION_MAX_HOURS and clamps it', () => {
    expect(adminSessionMaxMs({} as any)).toBe(12 * 3600_000);
    expect(adminSessionMaxMs({ ADMIN_SESSION_MAX_HOURS: '4' } as any)).toBe(4 * 3600_000);
    expect(adminSessionMaxMs({ ADMIN_SESSION_MAX_HOURS: '0.1' } as any)).toBe(3600_000);
    expect(adminSessionMaxMs({ ADMIN_SESSION_MAX_HOURS: '9999' } as any)).toBe(168 * 3600_000);
    expect(adminSessionMaxMs({ ADMIN_SESSION_MAX_HOURS: 'abc' } as any)).toBe(12 * 3600_000);
  });
});

describe('StepUpGuard', () => {
  const guard = new StepUpGuard();

  test('requires a step-up within the last 10 minutes on the current session', () => {
    expect(() => guard.canActivate(ctx({ user: { id: 'u', stepUpAt: null } }))).toThrow(ForbiddenException);
    try {
      guard.canActivate(ctx({ user: { id: 'u' } }));
    } catch (err: any) {
      expect(err.getStatus()).toBe(403);
      expect(err.getResponse()).toMatchObject({ statusCode: 403, code: 'STEP_UP_REQUIRED' });
    }
    expect(guard.canActivate(ctx({ user: { id: 'u', stepUpAt: new Date(Date.now() - 60_000) } }))).toBe(true);
    expect(() =>
      guard.canActivate(ctx({ user: { id: 'u', stepUpAt: new Date(Date.now() - STEP_UP_WINDOW_MS - 1000) } }))
    ).toThrow(ForbiddenException);
    // A future timestamp is never trusted
    expect(hasRecentStepUp({ stepUpAt: new Date(Date.now() + 5 * 60_000) })).toBe(false);
    expect(() => guard.canActivate(ctx({}))).toThrow(UnauthorizedException);
    expect(stepUpUntil(null)).toBeNull();
  });
});

describe('Step-up is applied to the sensitive admin routes', () => {
  const guardsOf = (proto: any, name: string) => (Reflect.getMetadata(GUARDS_METADATA, proto[name]) || []) as any[];

  test.each(['deleteSponsor', 'deleteGalleryImage', 'saveSiteInfo'])('%s requires step-up, roles and CSRF', (name) => {
    const guards = guardsOf(SiteContentController.prototype, name);
    expect(guards).toEqual(expect.arrayContaining([RolesGuard, CsrfGuard, StepUpGuard]));
  });

  test.each(['createSponsor', 'updateSponsor', 'reorderSponsors', 'createGalleryImage', 'updateGalleryImage', 'reorderGallery', 'saveSponsorsSection', 'saveGallerySection'])(
    '%s has roles + CSRF but no step-up',
    (name) => {
      const guards = guardsOf(SiteContentController.prototype, name);
      expect(guards).toEqual(expect.arrayContaining([RolesGuard, CsrfGuard]));
      expect(guards).not.toContain(StepUpGuard);
    }
  );

  test('auth controller exposes step-up and session management', () => {
    const p: any = AuthController.prototype;
    expect(Reflect.getMetadata(PATH_METADATA, p.stepUp)).toBe('step-up');
    expect(Reflect.getMetadata(PATH_METADATA, p.listSessions)).toBe('sessions');
    expect(Reflect.getMetadata(PATH_METADATA, p.revokeSession)).toBe('sessions/:id');
    expect(Reflect.getMetadata(METHOD_METADATA, p.revokeSession)).toBe(3); // RequestMethod.DELETE
    expect(guardsOf(p, 'stepUp')).toContain(CsrfGuard);
    expect(guardsOf(p, 'revokeSession')).toContain(CsrfGuard);
  });
});

describe('JwtStrategy staff-session hardening', () => {
  const session = (user: any, extra: any = {}) => ({
    userId: user.id,
    isActive: true,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    stepUpAt: null,
    user,
    ...extra
  });
  const staff = { id: 'u1', isActive: true, mustChangePassword: false, role: 'EVENT_ADMIN', email: 'a@b.c', isTwoFactorEnabled: true };
  const payload: any = { sub: 'u1', aud: 'gcdis-admin', sid: 's1' };

  afterEach(() => {
    delete process.env.ADMIN_IP_ALLOWLIST;
  });

  test('exposes the session step-up time to StepUpGuard', async () => {
    const at = new Date();
    const strategy = new JwtStrategy({ session: { findUnique: jest.fn().mockResolvedValue(session(staff, { stepUpAt: at })) } } as any);
    await expect(strategy.validate({ originalUrl: '/api/cms/admin/sponsors' }, payload)).resolves.toMatchObject({ stepUpAt: at });
  });

  test('a staff session without 2FA may only sign out', async () => {
    const strategy = new JwtStrategy({
      session: { findUnique: jest.fn().mockResolvedValue(session({ ...staff, isTwoFactorEnabled: false })) }
    } as any);
    await expect(strategy.validate({ originalUrl: '/api/cms/admin/sponsors' }, payload)).rejects.toMatchObject({
      response: { code: 'TWO_FACTOR_REQUIRED' }
    });
    await expect(strategy.validate({ originalUrl: '/api/auth/logout' }, payload)).resolves.toMatchObject({ id: 'u1' });
  });

  test('an admin-audience token of an account that is no longer staff is rejected', async () => {
    const strategy = new JwtStrategy({
      session: { findUnique: jest.fn().mockResolvedValue(session({ ...staff, role: 'TEAM_CAPTAIN' })) }
    } as any);
    await expect(strategy.validate({ originalUrl: '/api/auth/me' }, payload)).rejects.toThrow(UnauthorizedException);
  });

  test('ADMIN_IP_ALLOWLIST blocks admin-audience requests from other networks, not public ones', async () => {
    process.env.ADMIN_IP_ALLOWLIST = '10.0.0.0/8';
    const strategy = new JwtStrategy({ session: { findUnique: jest.fn().mockResolvedValue(session(staff)) } } as any);
    await expect(strategy.validate({ originalUrl: '/api/x', ip: '203.0.113.5' }, payload)).rejects.toMatchObject({
      response: { code: 'ADMIN_IP_NOT_ALLOWED' }
    });
    await expect(strategy.validate({ originalUrl: '/api/x', ip: '10.1.1.1' }, payload)).resolves.toMatchObject({ id: 'u1' });

    const captain = { ...staff, role: 'TEAM_CAPTAIN', isTwoFactorEnabled: false };
    const pub = new JwtStrategy({ session: { findUnique: jest.fn().mockResolvedValue(session(captain)) } } as any);
    await expect(pub.validate({ originalUrl: '/api/x', ip: '203.0.113.5' }, { ...payload, aud: 'gcdis-public' })).resolves.toMatchObject({
      id: 'u1'
    });
  });
});

describe('AuthService step-up, sessions and staff session issue', () => {
  let twoFactor: TwoFactorService;
  let prisma: any;
  let audit: any;
  let svc: AuthService;
  let secret: string;
  const USER = 'b1f8c7a2-3d4e-4f5a-9b6c-7d8e9f0a1b2c';

  const currentCode = (offset = 0) => twoFactor.computeTotp(secret, Math.floor(Date.now() / 1000 / 30) + offset);

  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    delete process.env.JWT_ADMIN_SECRET;
    delete process.env.ADMIN_IP_ALLOWLIST;
    delete process.env.ADMIN_SESSION_MAX_HOURS;
    twoFactor = new TwoFactorService();
    twoFactor.clearUserAttempts(USER);
    secret = twoFactor.generateBase32Secret();
    const { hashedRecords, plaintextCodes } = twoFactor.generateRecoveryCodes();
    (global as any).__recovery = plaintextCodes;
    const user = {
      id: USER,
      email: 'qa.staff@example.test',
      role: 'SUPER_ADMIN',
      isActive: true,
      isTwoFactorEnabled: true,
      mustChangePassword: false,
      fullName: 'QA Staff',
      twoFactor: { isEnabled: true, secret: twoFactor.encryptSecret(secret), lastUsedStep: null, backupCodes: hashedRecords }
    };
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      twoFactor: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn().mockResolvedValue(null) },
      session: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        groupBy: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({})
      },
      loginAttempt: { count: jest.fn().mockResolvedValue(0), create: jest.fn() }
    };
    audit = { logAction: jest.fn().mockResolvedValue({}) };
    svc = new AuthService(prisma, new JwtService({ secret: JWT_SECRET }), twoFactor, audit);
  });

  const actions = () => audit.logAction.mock.calls.map((c: any[]) => c[0].action);

  test('a valid TOTP code opens a 10-minute window on the calling session', async () => {
    const before = Date.now();
    const result = await svc.stepUp({ id: USER, sid: 's1' }, currentCode(), '127.0.0.1', 'jest');
    const until = new Date(result.stepUpUntil).getTime();
    expect(until).toBeGreaterThanOrEqual(before + STEP_UP_WINDOW_MS - 50);
    expect(until).toBeLessThanOrEqual(Date.now() + STEP_UP_WINDOW_MS + 50);
    // Replay protection: conditional update on lastUsedStep
    expect(prisma.twoFactor.updateMany.mock.calls[0][0].where.OR).toBeDefined();
    expect(prisma.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 's1', userId: USER }), data: { stepUpAt: expect.any(Date) } })
    );
    expect(actions()).toContain('AUTH_STEP_UP_SUCCESS');
  });

  test('a replayed TOTP code (step already used) is refused and audited', async () => {
    prisma.twoFactor.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.stepUp({ id: USER, sid: 's1' }, currentCode(), '127.0.0.1')).rejects.toThrow(BadRequestException);
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
    expect(actions()).toContain('AUTH_STEP_UP_FAILED');
  });

  test('a wrong code is refused with INVALID_STEP_UP_CODE (400, never 401)', async () => {
    await expect(svc.stepUp({ id: USER, sid: 's1' }, '000000')).rejects.toMatchObject({
      response: { code: 'INVALID_STEP_UP_CODE' }
    });
    expect(actions()).toEqual(['AUTH_STEP_UP_FAILED']);
  });

  test('a recovery code is accepted once and consumed', async () => {
    const code = (global as any).__recovery[0];
    await expect(svc.stepUp({ id: USER, sid: 's1' }, code)).resolves.toHaveProperty('stepUpUntil');
    const call = prisma.twoFactor.updateMany.mock.calls.find((c: any[]) => c[0].data.backupCodes);
    expect(call[0].data.backupCodes.filter((r: any) => r.used).length).toBe(1);
    expect(actions()).toEqual(expect.arrayContaining(['AUTH_STEP_UP_SUCCESS', 'AUTH_RECOVERY_CODE_USED']));
  });

  test('repeated failures lock step-up with 429', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(svc.stepUp({ id: USER, sid: 's1' }, '111111')).rejects.toThrow(BadRequestException);
    }
    await expect(svc.stepUp({ id: USER, sid: 's1' }, currentCode())).rejects.toMatchObject({ status: 429 });
    twoFactor.clearUserAttempts(USER);
  });

  test('accounts without 2FA cannot step up', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: USER, isActive: true, isTwoFactorEnabled: false, twoFactor: null });
    await expect(svc.stepUp({ id: USER, sid: 's1' }, '123456')).rejects.toMatchObject({ response: { code: 'TWO_FACTOR_NOT_ENABLED' } });
  });

  test('listSessions returns the contract shape with the sign-in time of each session family', async () => {
    const signIn = new Date(Date.now() - 3600_000);
    prisma.session.findMany.mockResolvedValue([
      { id: 's1', familyId: 'f1', createdAt: new Date(), lastUsedAt: new Date(), ipAddress: '::1', userAgent: 'jest' },
      { id: 's2', familyId: 'f2', createdAt: new Date(), lastUsedAt: null, ipAddress: null, userAgent: null }
    ]);
    prisma.session.groupBy.mockResolvedValue([{ familyId: 'f1', _min: { createdAt: signIn } }]);
    const list = await svc.listSessions(USER, 's1');
    expect(list).toHaveLength(2);
    expect(Object.keys(list[0]).sort()).toEqual(['createdAt', 'current', 'id', 'ipAddress', 'lastUsedAt', 'userAgent']);
    expect(list[0]).toMatchObject({ id: 's1', current: true, createdAt: signIn });
    expect(list[1]).toMatchObject({ id: 's2', current: false, lastUsedAt: null });
  });

  test('revoking another session requires step-up; the current one does not', async () => {
    const live = { userId: USER, familyId: 'f2', isActive: true, revokedAt: null, expiresAt: new Date(Date.now() + 60_000) };
    prisma.session.findUnique.mockResolvedValue({ id: 's2', ...live });
    await expect(svc.revokeSession({ id: USER, sid: 's1' }, 's2', false)).rejects.toMatchObject({
      response: { code: 'STEP_UP_REQUIRED' }
    });
    expect(prisma.session.updateMany).not.toHaveBeenCalled();

    await expect(svc.revokeSession({ id: USER, sid: 's1' }, 's2', true)).resolves.toEqual({ success: true, current: false });
    expect(prisma.session.updateMany.mock.calls[0][0].where).toMatchObject({ userId: USER, OR: [{ id: 's2' }, { familyId: 'f2' }] });
    expect(actions()).toContain('AUTH_SESSION_REVOKED');

    prisma.session.findUnique.mockResolvedValue({ id: 's1', ...live, familyId: 'f1' });
    await expect(svc.revokeSession({ id: USER, sid: 's1' }, 's1', false)).resolves.toEqual({ success: true, current: true });
  });

  test("another user's session is not found", async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 's9',
      userId: 'someone-else',
      familyId: 'f9',
      isActive: true,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000)
    });
    await expect(svc.revokeSession({ id: USER, sid: 's1' }, 's9', true)).rejects.toThrow(NotFoundException);
  });

  test('staff sessions have a 12-hour absolute lifetime that rotation never extends', async () => {
    const issued = await (svc as any).createSession(USER, '127.0.0.1', 'jest');
    const created = prisma.session.create.mock.calls[0][0].data;
    expect(issued.audience).toBe('gcdis-admin');
    expect(created.expiresAt.getTime() - Date.now()).toBeGreaterThan(12 * 3600_000 - 5000);
    expect(created.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(12 * 3600_000);
    expect(created.lastUsedAt).toBeUndefined();

    const absolute = new Date(Date.now() + 3600_000);
    const stepUpAt = new Date();
    await (svc as any).createSession(USER, '127.0.0.1', 'jest', 'fam', { expiresAt: absolute, stepUpAt, rotated: true });
    const rotated = prisma.session.create.mock.calls[1][0].data;
    expect(rotated.expiresAt).toEqual(absolute);
    expect(rotated.stepUpAt).toEqual(stepUpAt);
    expect(rotated.lastUsedAt).toBeInstanceOf(Date);
    expect(rotated.familyId).toBe('fam');
  });

  test('public sessions keep the 7-day sliding lifetime', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: USER, role: 'TEAM_CAPTAIN', isActive: true, isTwoFactorEnabled: false, email: 'c@x.y' });
    await (svc as any).createSession(USER, '127.0.0.1', 'jest', 'fam', { expiresAt: new Date(Date.now() + 1000), rotated: true });
    const data = prisma.session.create.mock.calls[0][0].data;
    expect(data.expiresAt.getTime() - Date.now()).toBeGreaterThan(7 * 24 * 3600_000 - 5000);
  });

  test('a staff session is never issued without 2FA or from outside the allow-list', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: USER, role: 'EVENT_ADMIN', isActive: true, isTwoFactorEnabled: false });
    await expect((svc as any).createSession(USER, '127.0.0.1')).rejects.toThrow(ForbiddenException);

    prisma.user.findUnique.mockResolvedValue({ id: USER, role: 'EVENT_ADMIN', isActive: true, isTwoFactorEnabled: true });
    process.env.ADMIN_IP_ALLOWLIST = '10.0.0.0/8';
    await expect((svc as any).createSession(USER, '203.0.113.7')).rejects.toThrow(ForbiddenException);
    expect(actions()).toContain('AUTH_ADMIN_IP_DENIED');
    await expect((svc as any).createSession(USER, '10.0.0.7')).resolves.toHaveProperty('accessToken');
    expect(prisma.session.create).toHaveBeenCalledTimes(1);
  });

  test('staff password sign-in from outside the allow-list is refused before any 2FA challenge', async () => {
    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash('Correct-Horse-9!', 4);
    prisma.user.findUnique.mockResolvedValue({ id: USER, email: 'qa.staff@example.test', role: 'SUPER_ADMIN', isActive: true, isTwoFactorEnabled: true, passwordHash });
    process.env.ADMIN_IP_ALLOWLIST = '10.0.0.0/8';
    await expect(svc.login({ email: 'qa.staff@example.test', password: 'Correct-Horse-9!' }, '203.0.113.7')).rejects.toThrow(
      ForbiddenException
    );
    const ok: any = await svc.login({ email: 'qa.staff@example.test', password: 'Correct-Horse-9!' }, '10.2.3.4');
    expect(ok.requires2fa).toBe(true);
  });

  test('rotation carries the absolute expiry and step-up window to the successor', async () => {
    const absolute = new Date(Date.now() + 3600_000);
    const stepUpAt = new Date(Date.now() - 60_000);
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      userId: USER,
      familyId: 'f1',
      revokedAt: null,
      isActive: true,
      expiresAt: absolute,
      stepUpAt,
      user: {}
    });
    await svc.rotateSession(crypto.randomBytes(8).toString('hex'), '127.0.0.1', 'jest');
    const data = prisma.session.create.mock.calls[0][0].data;
    expect(data.expiresAt).toEqual(absolute);
    expect(data.stepUpAt).toEqual(stepUpAt);
    expect(data.lastUsedAt).toBeInstanceOf(Date);
  });

});

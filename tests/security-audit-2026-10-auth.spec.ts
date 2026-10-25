/**
 * Security audit 2026-10 (identity layer): regression tests for M1, M2, M3, L1, L2, L3, L4, L7, L8, I1, I3.
 * Prisma is mocked throughout; no database or network access.
 */
import * as path from 'path';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AuthService, ACCOUNT_SOFT_LOCK_THRESHOLD } from '../apps/api/src/auth/auth.service';
import { AuthController } from '../apps/api/src/auth/auth.controller';
import { TwoFactorService } from '../apps/api/src/auth/two-factor.service';
import { GoogleAuthService } from '../apps/api/src/auth/google-auth.service';
import { JwtStrategy } from '../apps/api/src/auth/jwt.strategy';
import { StepUpGuard } from '../apps/api/src/auth/step-up.guard';
import { productionSecretConfigErrors } from '../apps/api/src/auth/jwt-secrets';
import { CsrfGuard } from '../apps/api/src/common/guards/csrf.guard';
import {
  AccountIpRateLimiterGuard,
  RATE_LIMIT_KEY,
  STRICT_AUTH_DEFAULT_IP_MULTIPLIER
} from '../apps/api/src/common/guards/rate-limiter.guard';
import { IS_PUBLIC_KEY } from '../apps/api/src/common/decorators/public.decorator';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { OAuth2Client } = require(require.resolve('google-auth-library', {
  paths: [path.join(__dirname, '../apps/api/src/auth')]
}));

const JWT_SECRET = 'security_audit_2026_10_auth_test_secret_value_32+';
const savedEnv = { ...process.env };

beforeEach(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  delete process.env.JWT_ADMIN_SECRET;
  delete process.env.ADMIN_IP_ALLOWLIST;
  delete process.env.REDIS_URL;
  process.env.NODE_ENV = 'test';
  AccountIpRateLimiterGuard.resetMemoryStore();
});

afterAll(() => {
  process.env = savedEnv;
});

const handler = (name: string) => (AuthController.prototype as any)[name];
const rule = (name: string) => Reflect.getMetadata(RATE_LIMIT_KEY, handler(name));
const guardsOf = (name: string) => Reflect.getMetadata(GUARDS_METADATA, handler(name)) || [];

function httpCtx(name: string, req: any) {
  return {
    getHandler: () => handler(name),
    getClass: () => AuthController,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader: jest.fn() }) })
  } as any;
}

let ipCounter = 0;
const freshIp = () => `198.18.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

async function statusOf(p: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await p;
    return 'ok';
  } catch (err: any) {
    return err instanceof HttpException ? err.getStatus() : -1;
  }
}

function authService(prisma: any, opts: { twoFactor?: TwoFactorService; audit?: any; alerts?: any } = {}) {
  return new AuthService(
    prisma,
    new JwtService({ secret: JWT_SECRET }),
    opts.twoFactor ?? new TwoFactorService(),
    opts.audit,
    opts.alerts
  );
}

// ---------------------------------------------------------------------------------------------------
describe('M1: rate-limit buckets are not keyed on an untrusted body.email', () => {
  const guard = () => new AccountIpRateLimiterGuard(new Reflector());

  test('an extra random body.email no longer bypasses the 2FA verify-login limit (429 by the 6th)', async () => {
    const g = guard();
    const ip = freshIp();
    const results: Array<number | 'ok'> = [];
    for (let i = 0; i < 6; i++) {
      const req = {
        ip,
        body: { challengeToken: 'x', code: '000000', email: `${crypto.randomUUID()}@attacker.test` },
        route: { path: '/api/auth/2fa/verify-login' }
      };
      results.push(await statusOf(g.canActivate(httpCtx('verify2faLogin', req))));
    }
    expect(results.slice(0, 5)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(results[5]).toBe(429);
  });

  test.each(['refresh', 'googleLogin', 'resetPassword', 'verifyEmail', 'verify2faLogin'])(
    '%s ignores body.email (no accountFromBody opt-in)',
    (name) => {
      expect(rule(name).accountFromBody).toBeUndefined();
      expect(AccountIpRateLimiterGuard.accountKey({ body: { email: 'a@b.c' } }, rule(name))).toBe('anonymous');
    }
  );

  test('login, forgot-password and register opt in to the body email', () => {
    for (const name of ['login', 'forgotPassword', 'register']) {
      expect(rule(name).accountFromBody).toBe('email');
    }
    expect(AccountIpRateLimiterGuard.accountKey({ body: { email: ' A@B.C ' } }, rule('login'))).toBe('email:a@b.c');
  });

  test('an authenticated request is keyed on req.user.id, never on the body', () => {
    const key = AccountIpRateLimiterGuard.accountKey({ user: { id: 'u-1' }, body: { email: 'x@y.z' } }, rule('login'));
    expect(key).toBe('user:u-1');
  });

  test('login: rotating emails from one IP is capped by the always-on per-IP bucket (3x points)', async () => {
    const g = guard();
    const ip = freshIp();
    const cap = rule('login').points * STRICT_AUTH_DEFAULT_IP_MULTIPLIER;
    for (let i = 0; i < cap; i++) {
      const req = { ip, body: { email: `user${i}@example.org` }, route: { path: '/api/auth/login' } };
      await expect(g.canActivate(httpCtx('login', req))).resolves.toBe(true);
    }
    const req = { ip, body: { email: 'another@example.org' }, route: { path: '/api/auth/login' } };
    expect(await statusOf(g.canActivate(httpCtx('login', req)))).toBe(429);
  });

  test('strict routes without ipPoints still get a per-IP bucket across authenticated users', async () => {
    const g = guard();
    const ip = freshIp();
    const stepUp = rule('stepUp');
    expect(stepUp.ipPoints).toBeUndefined();
    const cap = stepUp.points * STRICT_AUTH_DEFAULT_IP_MULTIPLIER;
    for (let i = 0; i < cap; i++) {
      const req = { ip, user: { id: `user-${i}` }, body: {}, route: { path: '/api/auth/step-up' } };
      await expect(g.canActivate(httpCtx('stepUp', req))).resolves.toBe(true);
    }
    const req = { ip, user: { id: 'fresh-user' }, body: {}, route: { path: '/api/auth/step-up' } };
    expect(await statusOf(g.canActivate(httpCtx('stepUp', req)))).toBe(429);
  });

  test('2FA attempt counters live in the shared (Redis-backed) store and survive a process restart', async () => {
    const data = new Map<string, { v: string; exp: number }>();
    const now = () => Math.floor(Date.now() / 1000);
    const live = (k: string) => {
      const e = data.get(k);
      if (e && e.exp > 0 && e.exp <= now()) data.delete(k);
      return data.get(k);
    };
    const fakeRedis = {
      incr: jest.fn(async (k: string) => {
        const e = live(k);
        const v = (e ? Number(e.v) : 0) + 1;
        data.set(k, { v: String(v), exp: e ? e.exp : 0 });
        return v;
      }),
      expire: jest.fn(async (k: string, s: number) => {
        const e = live(k);
        if (e) e.exp = now() + s;
        return 1;
      }),
      ttl: jest.fn(async (k: string) => {
        const e = live(k);
        return e ? (e.exp > 0 ? e.exp - now() : -1) : -2;
      }),
      get: jest.fn(async (k: string) => live(k)?.v ?? null),
      set: jest.fn(async (k: string, v: string, _ex: string, s: number) => {
        data.set(k, { v, exp: now() + s });
        return 'OK';
      }),
      del: jest.fn(async (...keys: string[]) => {
        keys.forEach((k) => data.delete(k));
        return keys.length;
      })
    };
    const G: any = AccountIpRateLimiterGuard;
    const saved = { client: G.redisClient, connected: G.isRedisConnected };
    G.redisClient = fakeRedis;
    G.isRedisConnected = true;
    try {
      const userId = `u-${crypto.randomUUID()}`;
      const first = new TwoFactorService();
      for (let i = 0; i < 5; i++) await first.recordFailedAttempt(userId);
      expect([...data.keys()].some((k) => k.includes(userId))).toBe(true);

      // "Restart": a new service instance with an empty memory store still sees the lock
      AccountIpRateLimiterGuard.resetMemoryStore();
      const second = new TwoFactorService();
      await expect(second.isLocked(userId)).resolves.toBe(true);
      await expect(second.checkUserRateLimit(userId)).rejects.toThrow(UnauthorizedException);

      await second.clearUserAttempts(userId);
      await expect(second.checkUserRateLimit(userId)).resolves.toBeUndefined();
    } finally {
      G.redisClient = saved.client;
      G.isRedisConnected = saved.connected;
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe('M2: Google sign-in pre-account takeover protection', () => {
  const CLIENT_ID = '1234567890-audit.apps.googleusercontent.com';
  let verifySpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
    delete process.env.GOOGLE_ALLOWED_HOSTED_DOMAINS;
    verifySpy = jest.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({
      getPayload: () => ({
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        sub: 'google-sub-1',
        email: 'victim@example.org',
        email_verified: true,
        name: 'Real Owner',
        exp: Math.floor(Date.now() / 1000) + 600
      })
    } as any);
  });
  afterEach(() => verifySpy.mockRestore());

  function setup(existing: any) {
    const users = new Map<string, any>([[existing.id, existing]]);
    const prisma: any = {
      user: {
        findUnique: jest.fn(async ({ where }: any) => {
          if (where.id) return users.get(where.id) ?? null;
          if (where.googleSub) return [...users.values()].find((u) => u.googleSub === where.googleSub) ?? null;
          return null;
        }),
        findFirst: jest.fn(async () => existing),
        update: jest.fn(async ({ where, data }: any) => {
          const u = { ...users.get(where.id), ...data };
          users.set(where.id, u);
          return u;
        })
      },
      session: { create: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 2 })) },
      authToken: { updateMany: jest.fn(async () => ({ count: 1 })) },
      loginAttempt: { create: jest.fn(async () => ({})) },
      auditLog: { create: jest.fn(async () => ({})) }
    };
    prisma.$transaction = jest.fn(async (work: any) => work(prisma));
    const google = new GoogleAuthService(prisma, authService(prisma));
    return { prisma, google, users };
  }

  const squatter = (overrides: Record<string, any> = {}) => ({
    id: 'squat-1',
    email: 'victim@example.org',
    passwordHash: '$2a$04$attackerchosenpasswordhashxxxxxxxxxxxxxxxxxxxxxxxxxx',
    fullName: 'Attacker',
    role: 'TEAM_CAPTAIN',
    googleSub: null,
    isActive: true,
    mustChangePassword: false,
    isTwoFactorEnabled: false,
    emailVerifiedAt: null,
    ...overrides
  });

  test('linking an unverified account replaces the password, revokes sessions and tokens, verifies, audits', async () => {
    const { prisma, google, users } = setup(squatter());
    await google.loginWithGoogle('id-token', '10.0.0.5', 'jest');

    const linked = users.get('squat-1');
    expect(linked.googleSub).toBe('google-sub-1');
    expect(linked.emailVerifiedAt).toBeInstanceOf(Date);
    expect(linked.passwordHash).not.toBe(squatter().passwordHash);
    expect(linked.passwordHash).toMatch(/^\$2[aby]\$12\$/);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'squat-1' }), data: expect.objectContaining({ isActive: false }) })
    );
    expect(prisma.authToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'squat-1', usedAt: null }, data: expect.objectContaining({ usedAt: expect.any(Date) }) })
    );
    const actions = prisma.auditLog.create.mock.calls.map((c: any[]) => c[0].data.action);
    expect(actions).toEqual(expect.arrayContaining(['AUTH_GOOGLE_TAKEOVER_PROTECTION', 'AUTH_GOOGLE_LINK']));
    const protection = prisma.auditLog.create.mock.calls.find((c: any[]) => c[0].data.action === 'AUTH_GOOGLE_TAKEOVER_PROTECTION')[0].data;
    expect(protection.afterState).toMatchObject({ passwordReplaced: true, sessionsRevoked: 2, tokensInvalidated: 1 });
    expect(JSON.stringify(protection)).not.toContain('$2');
  });

  test('the old (attacker-chosen) password no longer works after linking', async () => {
    const attackerPassword = 'Attacker-Chosen-Pass-2026';
    const { users, google } = setup(squatter({ passwordHash: await bcrypt.hash(attackerPassword, 4) }));
    await google.loginWithGoogle('id-token', '10.0.0.5', 'jest');
    await expect(bcrypt.compare(attackerPassword, users.get('squat-1').passwordHash)).resolves.toBe(false);
  });

  test('a verified account is linked without touching its password or sessions', async () => {
    const verified = squatter({ emailVerifiedAt: new Date('2026-01-01T00:00:00Z') });
    const { prisma, google, users } = setup(verified);
    await google.loginWithGoogle('id-token', '10.0.0.5', 'jest');
    expect(users.get('squat-1').passwordHash).toBe(verified.passwordHash);
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
    expect(prisma.authToken.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------
describe('M3: POST /auth/staff-user requires step-up, is audited and alerts on SUPER_ADMIN', () => {
  test('the route uses StepUpGuard like PATCH users/:id/role', () => {
    expect(guardsOf('createStaffUser')).toEqual(expect.arrayContaining([StepUpGuard, CsrfGuard]));
    expect(guardsOf('changeUserRole')).toEqual(expect.arrayContaining([StepUpGuard]));
  });

  function setup() {
    const admin = { id: 'admin-1', email: 'root@example.test', role: 'SUPER_ADMIN' };
    const prisma: any = {
      user: {
        findUnique: jest.fn(async ({ where }: any) => (where.id === 'admin-1' ? admin : null)),
        create: jest.fn(async ({ data }: any) => ({ id: 'new-staff', ...data }))
      }
    };
    const audit = { logAction: jest.fn().mockResolvedValue({}) };
    const alerts = { alert: jest.fn().mockResolvedValue(true) };
    return { prisma, audit, alerts, svc: authService(prisma, { audit, alerts }) };
  }

  test.each([
    ['SUPER_ADMIN', true],
    ['JUDGE', false]
  ])('creating a %s audits STAFF_USER_CREATED (alert: %s) and never logs the password', async (role, alerted) => {
    const { svc, audit, alerts } = setup();
    const tempPassword = 'Temp-Staff-Passphrase-2026!';
    await svc.createStaffUser(
      'admin-1',
      { email: 'new.staff@example.test', fullName: 'New Staff', role: role as any, tempPassword },
      '10.1.1.1',
      'jest'
    );
    const entry = audit.logAction.mock.calls.find((c: any[]) => c[0].action === 'STAFF_USER_CREATED')?.[0];
    expect(entry).toMatchObject({
      actorId: 'admin-1',
      actorEmail: 'root@example.test',
      entityId: 'new-staff',
      afterState: expect.objectContaining({ targetEmail: 'new.staff@example.test', role })
    });
    expect(JSON.stringify(entry)).not.toContain(tempPassword);
    expect(JSON.stringify(entry)).not.toContain('passwordHash');
    if (alerted) {
      expect(alerts.alert).toHaveBeenCalledWith('SUPER_ADMIN_ROLE_GRANTED', 'new.staff@example.test', expect.objectContaining({ changedBy: 'root@example.test' }));
    } else {
      expect(alerts.alert).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe('L1 / L4: password login', () => {
  const PASSWORD = 'Right-Password-2026!';
  let hash: string;
  beforeAll(async () => {
    hash = await bcrypt.hash(PASSWORD, 4);
  });

  function setup(user: any, accountFailures = 0) {
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      loginAttempt: {
        // email + IP lockout and IP flood counts: 0; per-account (any IP) count: accountFailures
        count: jest.fn(async ({ where }: any) => (where.ipAddress ? 0 : accountFailures)),
        create: jest.fn().mockResolvedValue({})
      },
      session: { create: jest.fn().mockResolvedValue({}) }
    };
    const alerts = { alert: jest.fn().mockResolvedValue(true) };
    return { prisma, alerts, svc: authService(prisma, { alerts }) };
  }

  const deactivated = () => ({ id: 'd1', email: 'gone@example.org', role: 'TEAM_CAPTAIN', isActive: false, passwordHash: hash });

  test('L1: a deactivated account with a wrong password gets the generic error (attempt recorded)', async () => {
    const { svc, prisma } = setup(deactivated());
    await expect(svc.login({ email: 'gone@example.org', password: 'Wrong-Password-1' } as any, '10.0.0.9')).rejects.toThrow(
      'Invalid email or password'
    );
    expect(prisma.loginAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: 'gone@example.org', successful: false })
    });
  });

  test('L1: only the correct password reveals the deactivated state (attempt recorded)', async () => {
    const { svc, prisma } = setup(deactivated());
    await expect(svc.login({ email: 'gone@example.org', password: PASSWORD } as any, '10.0.0.9')).rejects.toThrow(/deactivated/);
    expect(prisma.loginAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: 'gone@example.org', successful: false, failureReason: 'Account deactivated' })
    });
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  test('L4: the failure that reaches the per-account threshold raises ACCOUNT_LOCKOUT (scope: account)', async () => {
    const user = { id: 'c1', email: 'cap@example.org', role: 'TEAM_CAPTAIN', isActive: true, passwordHash: hash };
    const { svc, alerts } = setup(user, ACCOUNT_SOFT_LOCK_THRESHOLD - 1);
    await expect(svc.login({ email: 'cap@example.org', password: 'Wrong-Password-1' } as any, '203.0.113.20')).rejects.toThrow(
      UnauthorizedException
    );
    expect(alerts.alert).toHaveBeenCalledWith('ACCOUNT_LOCKOUT', 'cap@example.org|account', expect.objectContaining({ scope: 'account' }));
  });

  test('L4: a soft-locked account is refused from any IP, even with the right password', async () => {
    const user = { id: 'c1', email: 'cap@example.org', role: 'TEAM_CAPTAIN', isActive: true, passwordHash: hash };
    const { svc, prisma } = setup(user, ACCOUNT_SOFT_LOCK_THRESHOLD);
    const err: any = await svc.login({ email: 'cap@example.org', password: PASSWORD } as any, '192.0.2.77').catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toMatch(/temporarily locked/);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    const accountQuery = prisma.loginAttempt.count.mock.calls.find((c: any[]) => !c[0].where.ipAddress)[0].where;
    expect(accountQuery).toMatchObject({ email: 'cap@example.org', successful: false });
  });
});

// ---------------------------------------------------------------------------------------------------
describe('L2: change-password rate limit and lockout', () => {
  test('the route has a strict 5 per 15 minutes rate limit', () => {
    expect(rule('changePassword')).toMatchObject({ points: 5, duration: 900, isStrictAuth: true });
    expect(guardsOf('changePassword')).toEqual(expect.arrayContaining([AccountIpRateLimiterGuard, CsrfGuard]));
  });

  async function setup(failedForIp = 0) {
    const hash = await bcrypt.hash('Current-Passw0rd-2026', 4);
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1', email: 'cap@example.org', role: 'TEAM_CAPTAIN', passwordHash: hash }), update: jest.fn() },
      loginAttempt: {
        count: jest.fn(async ({ where }: any) => (where.ipAddress ? failedForIp : 0)),
        create: jest.fn().mockResolvedValue({})
      },
      session: { updateMany: jest.fn() }
    };
    return { prisma, svc: authService(prisma) };
  }

  test('a wrong current password is recorded as a failed attempt', async () => {
    const { prisma, svc } = await setup();
    await expect(svc.changePassword('u1', 'Wrong-Passw0rd-2026', 'Amber-Falcon-Orchard-73', '10.2.2.2')).rejects.toThrow(
      'Current password does not match'
    );
    expect(prisma.loginAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: 'cap@example.org', successful: false, ipAddress: '10.2.2.2' })
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('after 5 failures the account is locked for that IP', async () => {
    const { prisma, svc } = await setup(5);
    await expect(svc.changePassword('u1', 'Current-Passw0rd-2026', 'Amber-Falcon-Orchard-73', '10.2.2.2')).rejects.toThrow(
      ForbiddenException
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------
describe('L3: recovery-code consumption is compare-and-swap', () => {
  async function setup(claimCount: number) {
    const twoFactor = new TwoFactorService();
    const secret = twoFactor.generateBase32Secret();
    const { hashedRecords, plaintextCodes } = twoFactor.generateRecoveryCodes();
    const userId = `u-${crypto.randomUUID()}`;
    const user = {
      id: userId,
      email: 'cap@example.org',
      role: 'TEAM_CAPTAIN',
      isActive: true,
      isTwoFactorEnabled: true,
      mustChangePassword: false,
      twoFactor: { isEnabled: true, secret: twoFactor.encryptSecret(secret), lastUsedStep: null, backupCodes: hashedRecords }
    };
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      twoFactor: { updateMany: jest.fn().mockResolvedValue({ count: claimCount }), update: jest.fn() },
      auditLog: { create: jest.fn() }
    };
    const svc = authService(prisma, { twoFactor });
    const createSession = jest.spyOn(svc as any, 'createSession').mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
    const { twoFactorStateFingerprint } = await import('../apps/api/src/auth/auth.service');
    const challenge = (svc as any).signChallengeToken(userId, '2fa_challenge', '5m', { st: twoFactorStateFingerprint(user.twoFactor) });
    return { prisma, svc, challenge, code: plaintextCodes[0], hashedRecords, createSession };
  }

  test('the update is conditional on the stored codes being unchanged', async () => {
    const { prisma, svc, challenge, code, hashedRecords } = await setup(1);
    await expect(svc.verify2faLogin(challenge, code, '10.0.0.1')).resolves.toHaveProperty('accessToken', 'a');
    const call = prisma.twoFactor.updateMany.mock.calls[0][0];
    expect(call.where.backupCodes).toEqual({ equals: hashedRecords });
    expect(call.data.backupCodes.filter((r: any) => r.used)).toHaveLength(1);
    expect(prisma.twoFactor.update).not.toHaveBeenCalled();
  });

  test('a lost race (count 0) fails and issues no session', async () => {
    const { svc, challenge, code, createSession } = await setup(0);
    await expect(svc.verify2faLogin(challenge, code, '10.0.0.1')).rejects.toThrow(UnauthorizedException);
    expect(createSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------
describe('L8: registration is limited per IP', () => {
  test('about 10 registrations per hour per IP, whatever the email', async () => {
    expect(rule('register')).toMatchObject({ ipPoints: 10, ipDuration: 3600, accountFromBody: 'email' });
    const g = new AccountIpRateLimiterGuard(new Reflector());
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      const req = { ip, body: { email: `new${i}@example.org` }, route: { path: '/api/auth/register' } };
      await expect(g.canActivate(httpCtx('register', req))).resolves.toBe(true);
    }
    const req = { ip, body: { email: 'eleventh@example.org' }, route: { path: '/api/auth/register' } };
    expect(await statusOf(g.canActivate(httpCtx('register', req)))).toBe(429);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('I1: logout works with only the refresh cookie', () => {
  test('the route is public but CSRF-checked and rate limited', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler('logout'))).toBe(true);
    expect(guardsOf('logout')).toEqual(expect.arrayContaining([CsrfGuard, AccountIpRateLimiterGuard]));
  });

  function setup() {
    const prisma: any = { session: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const svc = authService(prisma);
    const controller = new AuthController(svc, {} as any);
    return { prisma, svc, controller };
  }

  test('revokes the session identified by the refresh cookie (no access token, no req.user)', async () => {
    const { prisma, controller } = setup();
    const res = { clearCookie: jest.fn() };
    const req = { headers: { origin: 'http://localhost:3000' }, cookies: { gcdis_refresh_token: 'raw-refresh' }, body: {} };
    await expect(controller.logout(req, res)).resolves.toMatchObject({ success: true });
    const hash = crypto.createHash('sha256').update('raw-refresh').digest('hex');
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { refreshTokenHash: hash },
      data: expect.objectContaining({ isActive: false })
    });
    expect(res.clearCookie).toHaveBeenCalledWith('gcdis_refresh_token', { path: '/' });
  });

  test('an expired but correctly signed access token still names its session; a forged one does not', async () => {
    const { prisma, controller } = setup();
    const jwt = new JwtService({ secret: JWT_SECRET });
    const expired = jwt.sign({ sub: 'u1', sid: 'sess-1', aud: 'gcdis-public' }, { secret: JWT_SECRET, expiresIn: -10 });
    const req = { headers: { origin: 'http://localhost:3000' }, cookies: { gcdis_access_token: expired }, body: {} };
    await controller.logout(req, { clearCookie: jest.fn() });
    expect(prisma.session.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'sess-1' } }));

    prisma.session.updateMany.mockClear();
    const forged = jwt.sign({ sub: 'u1', sid: 'sess-2', aud: 'gcdis-public' }, { secret: 'not-the-server-secret-0123456789abcdef' });
    await controller.logout({ headers: { origin: 'http://localhost:3000' }, cookies: { gcdis_access_token: forged }, body: {} }, { clearCookie: jest.fn() });
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------
describe('I3: JWT verification is pinned to HS256', () => {
  test('JwtStrategy only accepts HS256', () => {
    const strategy: any = new JwtStrategy({} as any);
    expect(strategy._verifOpts.algorithms).toEqual(['HS256']);
  });

  test('a challenge token signed with another HMAC algorithm is refused', async () => {
    const prisma: any = { user: { findUnique: jest.fn() } };
    const svc = authService(prisma);
    const { getChallengeJwtSecret } = await import('../apps/api/src/auth/jwt-secrets');
    const token = new JwtService({}).sign(
      { sub: 'u1', type: '2fa_challenge' },
      { secret: getChallengeJwtSecret(), audience: 'gcdis-2fa-challenge', expiresIn: '5m', algorithm: 'HS512' }
    );
    await expect(svc.verify2faLogin(token, '123456')).rejects.toThrow('Invalid or expired 2FA challenge token');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    // The same claims signed with HS256 are accepted up to the user lookup
    const ok = new JwtService({}).sign(
      { sub: 'u1', type: '2fa_challenge' },
      { secret: getChallengeJwtSecret(), audience: 'gcdis-2fa-challenge', expiresIn: '5m' }
    );
    await svc.verify2faLogin(ok, '123456').catch(() => undefined);
    expect(prisma.user.findUnique).toHaveBeenCalled();
  });

  test('an HS384 access token does not name a session for logout', () => {
    const svc = authService({});
    const hs384 = new JwtService({}).sign({ sub: 'u1', sid: 's1', aud: 'gcdis-public' }, { secret: JWT_SECRET, algorithm: 'HS384' });
    expect(svc.sessionIdFromAccessToken(hs384)).toBeNull();
    const hs256 = new JwtService({}).sign({ sub: 'u1', sid: 's1', aud: 'gcdis-public' }, { secret: JWT_SECRET });
    expect(svc.sessionIdFromAccessToken(hs256)).toBe('s1');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('L7: production secret validation', () => {
  const strong = (tag: string) => `${tag}-${crypto.randomBytes(24).toString('hex')}`;
  const goodEnv = () =>
    ({
      NODE_ENV: 'production',
      JWT_SECRET: strong('a'),
      JWT_ADMIN_SECRET: strong('b'),
      TWO_FACTOR_ENCRYPTION_KEY: strong('c'),
      COOKIE_SECRET: strong('d'),
      VERIFICATION_CODE_KEY: strong('e')
    }) as NodeJS.ProcessEnv;

  test('development starts without any of these secrets', () => {
    expect(productionSecretConfigErrors({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toEqual([]);
    expect(productionSecretConfigErrors({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  test('strong, distinct production secrets pass', () => {
    expect(productionSecretConfigErrors(goodEnv())).toEqual([]);
  });

  test('TWO_FACTOR_ENCRYPTION_KEY is required in production', () => {
    const env = goodEnv();
    delete env.TWO_FACTOR_ENCRYPTION_KEY;
    expect(productionSecretConfigErrors(env)).toEqual(['TWO_FACTOR_ENCRYPTION_KEY is required in production.']);
  });

  test.each(['JWT_SECRET', 'JWT_ADMIN_SECRET', 'TWO_FACTOR_ENCRYPTION_KEY', 'COOKIE_SECRET', 'VERIFICATION_CODE_KEY'])(
    'placeholder text in %s is refused (and the value is never echoed)',
    (name) => {
      for (const placeholder of ['REPLACE_WITH_MINIMUM_32_CHAR_CRYPTO_SECURE_SECRET_KEY', 'changeme-changeme-changeme-changeme', 'example-key-example-key-example-key-1']) {
        const env = goodEnv();
        env[name] = placeholder;
        const errors = productionSecretConfigErrors(env);
        expect(errors).toEqual([`${name} contains placeholder text in production.`]);
        expect(errors.join(' ')).not.toContain(placeholder);
      }
    }
  );

  test('main.ts applies the shared check in its startup validation', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const main = fs.readFileSync(path.join(__dirname, '../apps/api/src/main.ts'), 'utf-8');
    expect(main).toContain('productionSecretConfigErrors(process.env)');
  });
});

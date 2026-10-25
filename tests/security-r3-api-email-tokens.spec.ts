import 'reflect-metadata';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, ForbiddenException, HttpException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { AuthController } from '../apps/api/src/auth/auth.controller';
import { TwoFactorService } from '../apps/api/src/auth/two-factor.service';
import {
  AccountRecoveryService,
  EMAIL_VERIFY_TTL_MS,
  EMAIL_CODE_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  hashToken,
  publicSiteBase
} from '../apps/api/src/auth/account-recovery.service';
import { EmailVerifiedGuard } from '../apps/api/src/auth/email-verified.guard';
import { MailService } from '../apps/api/src/mail/mail.service';
import { RATE_LIMIT_KEY, AccountIpRateLimiterGuard } from '../apps/api/src/common/guards/rate-limiter.guard';
import { CsrfGuard } from '../apps/api/src/common/guards/csrf.guard';
import { RegistrationsController } from '../apps/api/src/registrations/registrations.controller';
import { PaymentsController } from '../apps/api/src/payments/payments.controller';

const rootDir = path.resolve(__dirname, '..');
const STRONG = 'Amber-Falcon-Orchard-73';

/** Minimal in-memory Prisma double for users, sessions and auth tokens. */
function makePrisma() {
  const users = new Map<string, any>();
  const tokens: any[] = [];
  const sessions: any[] = [];
  const audit: any[] = [];
  const matchToken = (t: any, where: any) =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (v === null) return t[k] === null;
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('not' in v) return v.not === null ? t[k] !== null && t[k] !== undefined : t[k] !== v.not;
        if ('gt' in v) return t[k] > v.gt;
        if ('in' in v) return v.in.includes(t[k]);
      }
      return t[k] === v;
    });
  const applyData = (t: any, data: any) => {
    for (const [k, v] of Object.entries(data) as [string, any][]) {
      if (v && typeof v === 'object' && 'increment' in v) t[k] = (t[k] ?? 0) + v.increment;
      else t[k] = v;
    }
  };
  const prisma: any = {
    users,
    tokens,
    sessions,
    audit,
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id) return users.get(where.id) ?? null;
        return [...users.values()].find((u) => u.email === where.email) ?? null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const u = users.get(where.id);
        Object.assign(u, data);
        return u;
      })
    },
    authToken: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const t of tokens) if (matchToken(t, where)) (applyData(t, data), count++);
        return { count };
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: crypto.randomUUID(), usedAt: null, createdAt: new Date(), attempts: 0, codeCipher: null, ...data };
        tokens.push(row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const t = where.id ? tokens.find((x) => x.id === where.id) : tokens.find((x) => x.tokenHash === where.tokenHash);
        return t ? { ...t, user: users.get(t.userId) } : null;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const list = tokens.filter((t) => matchToken(t, where)).sort((a, b) => b.createdAt - a.createdAt);
        return list[0] ? { ...list[0] } : null;
      }),
      count: jest.fn(async ({ where }: any) =>
        tokens.filter((t) => t.userId === where.userId && t.kind === where.kind && t.createdAt >= where.createdAt.gte).length
      )
    },
    session: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const s of sessions) if (s.userId === where.userId && s.revokedAt === null) (Object.assign(s, data), count++);
        return { count };
      })
    },
    auditLog: { create: jest.fn(async ({ data }: any) => (audit.push(data), data)) },
    $transaction: jest.fn(async (ops: Promise<any>[]) => Promise.all(ops))
  };
  return prisma;
}

function addUser(prisma: any, overrides: any = {}) {
  const user = {
    id: crypto.randomUUID(),
    email: 'captain@example.org',
    fullName: 'Asha Verma',
    role: 'TEAM_CAPTAIN',
    isActive: true,
    passwordHash: 'x',
    emailVerifiedAt: null,
    mustChangePassword: false,
    isPasswordTemporary: false,
    ...overrides
  };
  prisma.users.set(user.id, user);
  return user;
}

const tokenFrom = (text: string, page: string) => {
  const m = new RegExp(`${page}\\?token=([A-Za-z0-9_-]+)`).exec(text);
  return m ? m[1] : '';
};

const errorBody = async (p: Promise<unknown>) => {
  const err: any = await p.then(
    () => null,
    (e) => e
  );
  expect(err).toBeInstanceOf(HttpException);
  return { status: err.getStatus(), body: err.getResponse() };
};

describe('Email verification and password reset (contract section 1)', () => {
  let prisma: any;
  let auth: AuthService;
  let recovery: AccountRecoveryService;
  const env = { ...process.env };

  beforeEach(() => {
    process.env.PUBLIC_SITE_URL = 'https://www.gcdis.example/';
    MailService.testOutbox = [];
    prisma = makePrisma();
    auth = new AuthService(prisma, new JwtService({ secret: 'r3_email_tokens_secret_0123456789abcdefgh' }), new TwoFactorService());
    recovery = new AccountRecoveryService(prisma, auth, new MailService());
  });
  afterEach(() => {
    process.env = { ...env };
  });

  test('tokens: 32 random bytes base64url, only the SHA-256 hash stored, correct lifetimes', async () => {
    const user = addUser(prisma);
    const raw = await recovery.issueToken(user.id, 'EMAIL_VERIFY' as any, EMAIL_VERIFY_TTL_MS);
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(raw, 'base64url')).toHaveLength(32);
    const row = prisma.tokens[0];
    expect(row.tokenHash).toBe(crypto.createHash('sha256').update(raw).digest('hex'));
    expect(JSON.stringify(prisma.tokens)).not.toContain(raw);
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(EMAIL_VERIFY_TTL_MS - 5000);
    expect(EMAIL_VERIFY_TTL_MS).toBe(24 * 3600_000);
    expect(PASSWORD_RESET_TTL_MS).toBe(30 * 60_000);
  });

  test('verification email: six-digit code in the subject and body, only a salted HMAC and a ciphertext stored', async () => {
    const user = addUser(prisma);
    expect(publicSiteBase()).toBe('https://www.gcdis.example');
    await recovery.sendVerificationEmail(user);
    expect(MailService.testOutbox).toHaveLength(1);
    const mail = MailService.testOutbox[0];
    const code = /code: (\d{6})/.exec(mail.subject.replace('Your GCDIS verification code:', 'code:'))![1];
    expect(mail.to).toBe('captain@example.org');
    expect(mail.subject).toBe(`Your GCDIS verification code: ${code}`);
    expect(mail.text).toContain('Dear Asha Verma,');
    expect(mail.text).toContain(code);
    expect(mail.text).toContain('expires in 15 minutes');
    expect(mail.text).not.toContain('verify-email?token=');
    expect(mail.html).not.toMatch(/<img|<script/i);
    const row = prisma.tokens[0];
    expect(row.kind).toBe('EMAIL_VERIFY');
    expect(row.tokenHash.startsWith('code1$')).toBe(true);
    expect(JSON.stringify(prisma.tokens)).not.toContain(code);
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(EMAIL_CODE_TTL_MS);
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(EMAIL_CODE_TTL_MS - 5000);

    await expect(recovery.verifyEmailCode(user.id, code, '10.0.0.1')).resolves.toEqual({ success: true });
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(row.usedAt).toBeInstanceOf(Date);
    expect(row.codeCipher).toBeNull();
    expect(prisma.audit.find((a: any) => a.action === 'AUTH_EMAIL_VERIFIED').afterState).toMatchObject({ method: 'CODE' });
  });

  test('legacy links: a link token still verifies once; a used link of a verified account answers alreadyVerified', async () => {
    const user = addUser(prisma);
    const link = await recovery.issueToken(user.id, 'EMAIL_VERIFY' as any, EMAIL_VERIFY_TTL_MS);
    await expect(recovery.verifyEmail(link, '10.0.0.1')).resolves.toEqual({ success: true });
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    await expect(recovery.verifyEmail(link)).resolves.toEqual({ success: true, alreadyVerified: true });
  });

  test('expired, wrong-kind, malformed and deactivated-user tokens are refused', async () => {
    const user = addUser(prisma);
    const raw = await recovery.issueToken(user.id, 'EMAIL_VERIFY' as any, 1);
    await new Promise((r) => setTimeout(r, 5));
    expect((await errorBody(recovery.verifyEmail(raw))).body.code).toBe('INVALID_OR_EXPIRED_TOKEN');
    const reset = await recovery.issueToken(user.id, 'PASSWORD_RESET' as any, PASSWORD_RESET_TTL_MS);
    expect((await errorBody(recovery.verifyEmail(reset))).body.code).toBe('INVALID_OR_EXPIRED_TOKEN');
    expect((await errorBody(recovery.verifyEmail('../etc/passwd'))).body.code).toBe('INVALID_OR_EXPIRED_TOKEN');
    expect((await errorBody(recovery.verifyEmail(undefined))).body.code).toBe('INVALID_OR_EXPIRED_TOKEN');
    const live = await recovery.issueToken(user.id, 'EMAIL_VERIFY' as any, EMAIL_VERIFY_TTL_MS);
    user.isActive = false;
    expect((await errorBody(recovery.verifyEmail(live))).body.code).toBe('INVALID_OR_EXPIRED_TOKEN');
  });

  test('resend-verification: no-op when verified, 60 s cooldown, capped at 5 codes per hour', async () => {
    const user = addUser(prisma);
    await recovery.sendVerificationEmail(user); // registration
    const cooldown = await errorBody(recovery.resendVerification(user.id));
    expect(cooldown.status).toBe(429);
    expect(cooldown.body.code).toBe('RESEND_COOLDOWN');
    const age = () => prisma.tokens.forEach((t: any) => (t.createdAt = new Date(t.createdAt.getTime() - 61_000)));
    for (let i = 0; i < 4; i++) {
      age();
      await expect(recovery.resendVerification(user.id)).resolves.toMatchObject({ success: true, expiresAt: expect.any(String) });
    }
    age();
    const limited = await errorBody(recovery.resendVerification(user.id));
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('VERIFICATION_EMAIL_LIMIT');
    expect(MailService.testOutbox).toHaveLength(5);

    const verified = addUser(prisma, { email: 'done@example.org', emailVerifiedAt: new Date() });
    await expect(recovery.resendVerification(verified.id)).resolves.toEqual({ success: true, alreadyVerified: true });
    expect(MailService.testOutbox).toHaveLength(5);
  });

  test('forgot-password: always { success: true }; only active team captains get an email; 3 per hour per account', async () => {
    const captain = addUser(prisma);
    addUser(prisma, { email: 'judge@example.org', role: 'JUDGE' });
    addUser(prisma, { email: 'off@example.org', isActive: false });

    expect(recovery.forgotPassword('nobody@example.org')).toEqual({ success: true });
    await expect(recovery.processForgotPassword('nobody@example.org')).resolves.toBe(false);
    await expect(recovery.processForgotPassword('judge@example.org')).resolves.toBe(false);
    await expect(recovery.processForgotPassword('off@example.org')).resolves.toBe(false);
    expect(MailService.testOutbox).toHaveLength(0);

    for (let i = 0; i < 3; i++) await expect(recovery.processForgotPassword(' Captain@Example.org ', '10.0.0.9')).resolves.toBe(true);
    await expect(recovery.processForgotPassword('captain@example.org')).resolves.toBe(false);
    expect(MailService.testOutbox).toHaveLength(3);
    const mail = MailService.testOutbox[2];
    expect(mail.subject).toBe('GCDIS: Password reset request');
    expect(mail.text).toContain('https://www.gcdis.example/portal/reset-password?token=');
    expect(mail.text).toContain('valid for 30 minutes');
    const requested = prisma.audit.filter((a: any) => a.action === 'AUTH_PASSWORD_RESET_REQUESTED');
    expect(requested).toHaveLength(3);
    expect(requested[0]).toMatchObject({ actorId: captain.id, ipAddress: '10.0.0.9' });
  });

  test('reset-password: weak password keeps the link, success revokes every session and is single use', async () => {
    const user = addUser(prisma, { emailVerifiedAt: null });
    prisma.sessions.push({ id: 's1', userId: user.id, revokedAt: null }, { id: 's2', userId: user.id, revokedAt: null });
    await recovery.processForgotPassword(user.email);
    const token = tokenFrom(MailService.testOutbox[0].text, 'reset-password');

    const weak = await errorBody(recovery.resetPassword(token, 'short'));
    expect(weak).toEqual({ status: 400, body: expect.objectContaining({ code: 'WEAK_PASSWORD' }) });
    const tooLong = await errorBody(recovery.resetPassword(token, 'Aa1!'.repeat(40)));
    expect(tooLong.body.code).toBe('WEAK_PASSWORD');

    await expect(recovery.resetPassword(token, STRONG, '10.0.0.2', 'jest')).resolves.toEqual({ success: true });
    expect(prisma.sessions.every((s: any) => s.revokedAt instanceof Date && s.isActive === false)).toBe(true);
    expect(user.passwordHash).not.toBe('x');
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(prisma.audit.find((a: any) => a.action === 'AUTH_PASSWORD_RESET_COMPLETED').afterState).toMatchObject({ sessionsRevoked: 2 });
    expect((await errorBody(recovery.resetPassword(token, STRONG))).body.code).toBe('INVALID_OR_EXPIRED_TOKEN');
    expect(MailService.testOutbox.map((m) => m.subject)).toContain('GCDIS: Your password has been changed');
  });

  test('hashToken is SHA-256 hex', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('EMAIL_NOT_VERIFIED enforcement', () => {
  const ctx = (req: any) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as any;

  test('guard: unverified captain -> 403 EMAIL_NOT_VERIFIED; verified captain and staff pass', async () => {
    const prisma: any = { user: { findUnique: jest.fn().mockResolvedValue({ emailVerifiedAt: null }) } };
    const guard = new EmailVerifiedGuard(prisma);
    const err: any = await guard.canActivate(ctx({ user: { id: 'c1', role: 'TEAM_CAPTAIN', emailVerified: false } })).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ statusCode: 403, code: 'EMAIL_NOT_VERIFIED', message: expect.any(String) });
    await expect(guard.canActivate(ctx({ user: { id: 'c1', role: 'TEAM_CAPTAIN', emailVerified: true } }))).resolves.toBe(true);
    await expect(guard.canActivate(ctx({ user: { id: 'a1', role: 'SUPER_ADMIN' } }))).resolves.toBe(true);
    // no flag on req.user -> falls back to the database
    await expect(guard.canActivate(ctx({ user: { id: 'c1', role: 'TEAM_CAPTAIN' } }))).rejects.toThrow(ForbiddenException);
  });

  test('applied to POST /registrations and POST /payments/create-order, after the session guards', () => {
    const regGuards = Reflect.getMetadata(GUARDS_METADATA, RegistrationsController.prototype.createRegistration);
    const payGuards = Reflect.getMetadata(GUARDS_METADATA, PaymentsController.prototype.createOrder);
    for (const guards of [regGuards, payGuards]) {
      expect(guards[guards.length - 1]).toBe(EmailVerifiedGuard);
      expect(guards.indexOf(EmailVerifiedGuard)).toBeGreaterThan(guards.indexOf(CsrfGuard));
    }
    // not on unrelated captain actions
    const verifyGuards = Reflect.getMetadata(GUARDS_METADATA, PaymentsController.prototype.verifyPaymentSignature) || [];
    expect(verifyGuards).not.toContain(EmailVerifiedGuard);
  });
});

describe('Auth controller wiring for the new endpoints', () => {
  const rule = (name: keyof AuthController) => Reflect.getMetadata(RATE_LIMIT_KEY, (AuthController.prototype as any)[name]);
  const guards = (name: keyof AuthController) => Reflect.getMetadata(GUARDS_METADATA, (AuthController.prototype as any)[name]);

  test('public routes are CSRF-origin checked and rate limited', () => {
    for (const name of ['verifyEmail', 'verifyEmailCode', 'forgotPassword', 'resetPassword', 'resendVerification'] as const) {
      expect(guards(name)).toEqual(expect.arrayContaining([AccountIpRateLimiterGuard, CsrfGuard]));
    }
    expect(rule('resendVerification')).toMatchObject({ points: 5, duration: 3600, ipPoints: 20 });
    expect(rule('verifyEmailCode')).toMatchObject({ points: 10, duration: 900, ipPoints: 30 });
    expect(rule('forgotPassword')).toMatchObject({ points: 3, duration: 3600, ipPoints: 3 });
  });

  test('register sends the verification email and reports whether it was delivered', async () => {
    const authService: any = {
      register: jest.fn().mockResolvedValue({ user: { id: 'u1', email: 'c@example.org', emailVerified: false }, accessToken: 'a', refreshToken: 'r' })
    };
    const recovery: any = { sendVerificationEmail: jest.fn().mockResolvedValue(true) };
    const controller = new AuthController(authService, {} as any, recovery);
    const res = { cookie: jest.fn() };
    const out = await controller.register(
      { email: 'c@example.org', password: STRONG, fullName: 'Cap Tain' },
      '10.0.0.1',
      res
    );
    expect(out).toEqual({
      user: expect.objectContaining({ id: 'u1' }),
      message: 'Registration successful',
      verificationEmailSent: true
    });
    expect(recovery.sendVerificationEmail).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }));

    // A failed send never fails the registration, but is reported so the portal can offer "Resend code"
    recovery.sendVerificationEmail.mockRejectedValueOnce(new Error('SMTP down'));
    const failed = await controller.register({ email: 'c@example.org', password: STRONG, fullName: 'Cap Tain' }, '10.0.0.1', res);
    expect(failed).toEqual(expect.objectContaining({ message: 'Registration successful', verificationEmailSent: false }));
  });

  test('forgot-password always answers { success: true } and validates the email shape', async () => {
    const recovery: any = { forgotPassword: jest.fn().mockReturnValue({ success: true }) };
    const controller = new AuthController({} as any, {} as any, recovery);
    await expect(controller.forgotPassword({ email: 'someone@example.org' }, '10.0.0.1', 'jest')).resolves.toEqual({ success: true });
    await expect(controller.forgotPassword({ email: 'not-an-email' }, '10.0.0.1', 'jest')).rejects.toThrow(BadRequestException);
  });

  test('main.ts marks every /api/auth response no-store', () => {
    const main = fs.readFileSync(path.join(rootDir, 'apps', 'api', 'src', 'main.ts'), 'utf-8');
    expect(main).toMatch(/app\.use\('\/api\/auth'[\s\S]*Cache-Control', 'no-store'/);
  });
});

describe('Schema and migration', () => {
  const migrationsDir = path.join(rootDir, 'apps', 'api', 'prisma', 'migrations');

  test('migration adds emailVerifiedAt (back-filled from createdAt) and auth_tokens', () => {
    const dir = fs.readdirSync(migrationsDir).find((d) => d.endsWith('_email_verification_and_tokens'));
    expect(dir).toBeDefined();
    const sql = fs.readFileSync(path.join(migrationsDir, dir!, 'migration.sql'), 'utf-8');
    expect(sql).toContain('ADD COLUMN "emailVerifiedAt" TIMESTAMP(3)');
    expect(sql).toMatch(/UPDATE "users" SET "emailVerifiedAt" = "createdAt"/);
    expect(sql).toContain('CREATE TABLE "auth_tokens"');
    expect(sql).toContain('CREATE UNIQUE INDEX "auth_tokens_tokenHash_key"');
    expect(sql).toContain("CREATE TYPE \"AuthTokenKind\" AS ENUM ('EMAIL_VERIFY', 'PASSWORD_RESET')");
  });

  test('Google sign-in accounts are created verified', () => {
    const code = fs.readFileSync(path.join(rootDir, 'apps', 'api', 'src', 'auth', 'google-auth.service.ts'), 'utf-8');
    expect(code).toMatch(/authProvider: 'google',[\s\S]*emailVerifiedAt: new Date\(\)/);
  });
});

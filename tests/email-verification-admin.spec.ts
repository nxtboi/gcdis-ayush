import 'reflect-metadata';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { HttpException, Logger } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { AuthController } from '../apps/api/src/auth/auth.controller';
import { TwoFactorService } from '../apps/api/src/auth/two-factor.service';
import {
  AccountRecoveryService,
  EMAIL_CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  MAX_VERIFICATION_EMAILS_PER_HOUR,
  emailLinkConfigErrors
} from '../apps/api/src/auth/account-recovery.service';
import {
  decryptVerificationCode,
  encryptVerificationCode,
  generateVerificationCode,
  hashVerificationCode,
  verificationCodeConfigErrors,
  verifyCodeHash
} from '../apps/api/src/auth/verification-code.util';
import {
  MailService,
  describeMailError,
  maskUser,
  mailConfigErrors,
  redactSecrets,
  smtpProviderName,
  smtpSettings
} from '../apps/api/src/mail/mail.service';
import { MailController } from '../apps/api/src/mail/mail.controller';
import { RATE_LIMIT_KEY, AccountIpRateLimiterGuard } from '../apps/api/src/common/guards/rate-limiter.guard';
import { CsrfGuard } from '../apps/api/src/common/guards/csrf.guard';
import { RolesGuard } from '../apps/api/src/auth/roles.guard';
import { ROLES_KEY } from '../apps/api/src/auth/roles.decorator';
import { StepUpGuard } from '../apps/api/src/auth/step-up.guard';
import { IS_PUBLIC_KEY } from '../apps/api/src/common/decorators/public.decorator';

const rootDir = path.resolve(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(rootDir, ...p), 'utf-8');

/** In-memory Prisma double: users, auth tokens, audit log (supports the operators the services use). */
function makePrisma() {
  const users = new Map<string, any>();
  const tokens: any[] = [];
  const audit: any[] = [];
  const matches = (row: any, where: any): boolean =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (v === null) return row[k] === null || row[k] === undefined;
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('not' in v) return v.not === null ? row[k] !== null && row[k] !== undefined : row[k] !== v.not;
        if ('gt' in v) return row[k] > v.gt;
        if ('gte' in v) return row[k] >= v.gte;
        if ('in' in v) return v.in.includes(row[k]);
      }
      return row[k] === v;
    });
  const apply = (row: any, data: any) => {
    for (const [k, v] of Object.entries(data) as [string, any][]) {
      if (v && typeof v === 'object' && 'increment' in v) row[k] = (row[k] ?? 0) + v.increment;
      else row[k] = v;
    }
  };
  const prisma: any = {
    users,
    tokens,
    audit,
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id) return users.get(where.id) ?? null;
        return [...users.values()].find((u) => u.email === where.email) ?? null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const u = users.get(where.id);
        Object.assign(u, data);
        return { ...u };
      }),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0)
    },
    authToken: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const t of tokens) if (matches(t, where)) (apply(t, data), count++);
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
        const list = tokens.filter((t) => matches(t, where)).sort((a, b) => b.createdAt - a.createdAt);
        return list[0] ? { ...list[0] } : null;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        tokens.filter((t) => matches(t, where)).sort((a, b) => b.createdAt - a.createdAt).map((t) => ({ ...t }))
      ),
      count: jest.fn(async ({ where }: any) => tokens.filter((t) => matches(t, where)).length)
    },
    auditLog: { create: jest.fn(async ({ data }: any) => (audit.push(data), data)) },
    $transaction: jest.fn(async (ops: Promise<any>[]) => Promise.all(ops))
  };
  return prisma;
}

function addUser(prisma: any, overrides: any = {}) {
  const user = {
    id: crypto.randomUUID(),
    email: `captain.${crypto.randomBytes(3).toString('hex')}@example.test`,
    fullName: 'Test Captain',
    role: 'TEAM_CAPTAIN',
    isActive: true,
    passwordHash: 'hash',
    googleSub: null,
    emailVerifiedAt: null,
    ...overrides
  };
  prisma.users.set(user.id, user);
  return user;
}

const errorOf = async (p: Promise<unknown>) => {
  const err: any = await p.then(
    () => null,
    (e) => e
  );
  expect(err).toBeInstanceOf(HttpException);
  return { status: err.getStatus(), body: err.getResponse() as any };
};

/** The code from the newest captured email. */
const lastCode = () => /Your GCDIS verification code: (\d{6})/.exec(MailService.testOutbox[MailService.testOutbox.length - 1].subject)![1];
/** A different six-digit code. */
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
/** Moves every token back in time (past the resend cooldown). */
const age = (prisma: any, ms = 61_000) => prisma.tokens.forEach((t: any) => (t.createdAt = new Date(t.createdAt.getTime() - ms)));

const ACTOR = { id: 'actor-super-admin', email: 'root@example.test', role: 'SUPER_ADMIN' };
const EVENT_ADMIN = { id: 'actor-event-admin', email: 'events@example.test', role: 'EVENT_ADMIN' };

function setup() {
  MailService.testOutbox = [];
  const prisma = makePrisma();
  const auth = new AuthService(prisma, new JwtService({ secret: 'email_verification_admin_secret_0123456789' }), new TwoFactorService());
  const recovery = new AccountRecoveryService(prisma, auth, new MailService());
  return { prisma, auth, recovery };
}

describe('Verification code primitives', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  test('codes are six digits from a CSPRNG (crypto.randomInt)', () => {
    const util = read('apps', 'api', 'src', 'auth', 'verification-code.util.ts');
    expect(util).toContain('crypto.randomInt(0, 1_000_000)');
    const codes = Array.from({ length: 200 }, () => generateVerificationCode());
    for (const c of codes) expect(c).toMatch(/^\d{6}$/);
    expect(new Set(codes).size).toBeGreaterThan(190);
  });

  test('hash: salted HMAC bound to the user, verified in constant time; never contains the code', () => {
    expect(read('apps', 'api', 'src', 'auth', 'verification-code.util.ts')).toContain('crypto.timingSafeEqual(');
    const h1 = hashVerificationCode('user-1', '123456');
    const h2 = hashVerificationCode('user-1', '123456');
    expect(h1).not.toBe(h2); // random salt: unique per issued code
    expect(h1).not.toContain('123456');
    expect(verifyCodeHash('user-1', '123456', h1)).toBe(true);
    expect(verifyCodeHash('user-1', '123457', h1)).toBe(false);
    expect(verifyCodeHash('user-2', '123456', h1)).toBe(false);
    expect(verifyCodeHash('user-1', 'abc', h1)).toBe(false);
    expect(verifyCodeHash('user-1', '123456', 'deadbeef')).toBe(false);
  });

  test('encryption: AES-256-GCM, bound to the user, tamper-evident, key-dependent', () => {
    const enc = encryptVerificationCode('user-1', '042917');
    expect(enc.startsWith('v1.')).toBe(true);
    expect(enc).not.toContain('042917');
    expect(decryptVerificationCode('user-1', enc)).toBe('042917');
    expect(decryptVerificationCode('user-2', enc)).toBeNull();
    const raw = Buffer.from(enc.slice(3), 'base64');
    raw[raw.length - 1] ^= 1;
    expect(decryptVerificationCode('user-1', 'v1.' + raw.toString('base64'))).toBeNull();
    const other = { ...process.env, VERIFICATION_CODE_KEY: 'a-completely-different-key-of-at-least-32-chars' } as any;
    expect(decryptVerificationCode('user-1', enc, other)).toBeNull();
    expect(decryptVerificationCode('user-1', null)).toBeNull();
  });

  test('production requires VERIFICATION_CODE_KEY (wired into main.ts and docker-compose.prod.yml)', () => {
    expect(verificationCodeConfigErrors({ NODE_ENV: 'development' } as any)).toEqual([]);
    expect(verificationCodeConfigErrors({ NODE_ENV: 'production' } as any)).toHaveLength(1);
    expect(verificationCodeConfigErrors({ NODE_ENV: 'production', VERIFICATION_CODE_KEY: 'short' } as any)).toHaveLength(1);
    expect(verificationCodeConfigErrors({ NODE_ENV: 'production', VERIFICATION_CODE_KEY: 'f'.repeat(64) } as any)).toEqual([]);
    expect(() => hashVerificationCode('u', '123456', { NODE_ENV: 'production' } as any)).toThrow(/VERIFICATION_CODE_KEY/);
    expect(read('apps', 'api', 'src', 'main.ts')).toContain('verificationCodeConfigErrors(process.env)');
    expect(read('docker-compose.prod.yml')).toContain('VERIFICATION_CODE_KEY=${VERIFICATION_CODE_KEY:?');
  });
});

describe('Captain email verification by code', () => {
  let prisma: any;
  let recovery: AccountRecoveryService;
  const env = { ...process.env };

  beforeEach(() => {
    ({ prisma, recovery } = setup());
  });
  afterEach(() => {
    process.env = { ...env };
  });

  test('registration code verifies once (single use); the address is verified at once', async () => {
    const user = addUser(prisma);
    await recovery.sendVerificationEmail(user);
    const code = lastCode();
    await expect(recovery.verifyEmailCode(user.id, code, '10.0.0.1', 'jest')).resolves.toEqual({ success: true });
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(prisma.tokens[0].codeCipher).toBeNull();
    // Re-using the code: the account is already verified
    await expect(recovery.verifyEmailCode(user.id, code)).resolves.toEqual({ success: true, alreadyVerified: true });
  });

  test('a consumed code cannot be used again even if the account were unverified (no second success)', async () => {
    const user = addUser(prisma);
    await recovery.sendVerificationEmail(user);
    const code = lastCode();
    await recovery.verifyEmailCode(user.id, code);
    user.emailVerifiedAt = null;
    expect((await errorOf(recovery.verifyEmailCode(user.id, code))).body.code).toBe('CODE_EXPIRED');
  });

  test('codes expire after 15 minutes', async () => {
    const user = addUser(prisma);
    await recovery.sendVerificationEmail(user);
    const row = prisma.tokens[0];
    const lifetime = row.expiresAt.getTime() - row.createdAt.getTime();
    expect(lifetime).toBeLessThanOrEqual(EMAIL_CODE_TTL_MS);
    expect(lifetime).toBeGreaterThan(EMAIL_CODE_TTL_MS - 1000);
    row.expiresAt = new Date(Date.now() - 1000);
    expect((await errorOf(recovery.verifyEmailCode(user.id, lastCode()))).body.code).toBe('CODE_EXPIRED');
    expect(user.emailVerifiedAt).toBeNull();
  });

  test('a new code invalidates the previous one', async () => {
    const user = addUser(prisma);
    await recovery.sendVerificationEmail(user);
    const first = lastCode();
    age(prisma);
    await recovery.resendVerification(user.id);
    const second = lastCode();
    expect(prisma.tokens[0].usedAt).toBeInstanceOf(Date);
    expect(prisma.tokens[0].codeCipher).toBeNull();
    if (first !== second) {
      expect((await errorOf(recovery.verifyEmailCode(user.id, first))).body.code).toBe('INVALID_CODE');
    }
    await expect(recovery.verifyEmailCode(user.id, second)).resolves.toEqual({ success: true });
  });

  test('five wrong attempts burn the code (then even the right code fails) and are audited', async () => {
    const user = addUser(prisma);
    await recovery.sendVerificationEmail(user);
    const code = lastCode();
    for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) {
      const res = await errorOf(recovery.verifyEmailCode(user.id, wrong(code)));
      expect(res.body).toMatchObject({ code: 'INVALID_CODE', attemptsRemaining: MAX_CODE_ATTEMPTS - i });
    }
    const locked = await errorOf(recovery.verifyEmailCode(user.id, wrong(code), '10.0.0.7'));
    expect(locked.body.code).toBe('CODE_LOCKED');
    expect(prisma.tokens[0].usedAt).toBeInstanceOf(Date);
    expect(prisma.tokens[0].codeCipher).toBeNull();
    expect((await errorOf(recovery.verifyEmailCode(user.id, code))).body.code).toBe('CODE_EXPIRED');
    expect(user.emailVerifiedAt).toBeNull();
    expect(prisma.audit.find((a: any) => a.action === 'AUTH_EMAIL_CODE_LOCKED')).toMatchObject({ actorId: user.id, ipAddress: '10.0.0.7' });
  });

  test('malformed codes are refused without touching the attempt counter', async () => {
    const user = addUser(prisma);
    await recovery.sendVerificationEmail(user);
    for (const bad of ['12345', '1234567', 'abcdef', '', undefined, 123456]) {
      expect((await errorOf(recovery.verifyEmailCode(user.id, bad as any))).body.code).toBe('INVALID_CODE_FORMAT');
    }
    expect(prisma.tokens[0].attempts).toBe(0);
  });

  test('status: pending expiry, attempts and cooldown, never the code', async () => {
    const user = addUser(prisma);
    await recovery.sendVerificationEmail(user);
    const status = await recovery.verificationStatus(user.id);
    expect(status).toMatchObject({ verified: false, pending: { attemptsRemaining: MAX_CODE_ATTEMPTS }, resendAvailableAt: expect.any(String) });
    expect(JSON.stringify(status)).not.toContain(lastCode());
  });

  test('resend: 60 s cooldown, 5 per hour, alreadyVerified when verified, 503 when the mail cannot be sent', async () => {
    const user = addUser(prisma);
    await recovery.sendVerificationEmail(user);
    expect((await errorOf(recovery.resendVerification(user.id))).body.code).toBe('RESEND_COOLDOWN');
    for (let i = 1; i < MAX_VERIFICATION_EMAILS_PER_HOUR; i++) {
      age(prisma);
      await recovery.resendVerification(user.id);
    }
    age(prisma);
    const limited = await errorOf(recovery.resendVerification(user.id));
    expect(limited).toMatchObject({ status: 429, body: expect.objectContaining({ code: 'VERIFICATION_EMAIL_LIMIT' }) });

    const verified = addUser(prisma, { emailVerifiedAt: new Date() });
    await expect(recovery.resendVerification(verified.id)).resolves.toEqual({ success: true, alreadyVerified: true });

    const other = addUser(prisma);
    const failing = new AccountRecoveryService(prisma, (recovery as any).authService, { sendSafe: jest.fn().mockResolvedValue(false) } as any);
    const failed = await errorOf(failing.resendVerification(other.id));
    expect(failed).toMatchObject({ status: 503, body: expect.objectContaining({ code: 'EMAIL_DELIVERY_FAILED' }) });
  });

  test('codes never reach logs outside the development outbox line', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SMTP_HOST = '';
    process.env.VERIFICATION_CODE_KEY = 'k'.repeat(48);
    const errors: string[] = [];
    const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation((msg: any) => void errors.push(String(msg)));
    const user = addUser(prisma);
    const sent = await recovery.sendVerificationEmail(user);
    spy.mockRestore();
    expect(sent).toBe(false);
    expect(errors.join('\n')).toContain('GCDIS verification code');
    expect(errors.join('\n')).not.toMatch(/\d{6}/);
  });

  test('email-delivery info: false only outside production without SMTP', () => {
    process.env.NODE_ENV = 'development';
    process.env.SMTP_HOST = '';
    expect(recovery.emailDeliveryInfo()).toEqual({ deliveryConfigured: false });
    process.env.SMTP_HOST = 'smtp.example.test';
    expect(recovery.emailDeliveryInfo()).toEqual({ deliveryConfigured: true });
    process.env.NODE_ENV = 'production';
    process.env.SMTP_HOST = '';
    expect(recovery.emailDeliveryInfo()).toEqual({ deliveryConfigured: true });
  });

  test('production requires an absolute PUBLIC_SITE_URL for emailed links (wired into main.ts)', () => {
    expect(emailLinkConfigErrors({ NODE_ENV: 'development' } as any)).toEqual([]);
    expect(emailLinkConfigErrors({ NODE_ENV: 'production' } as any)).toHaveLength(1);
    expect(emailLinkConfigErrors({ NODE_ENV: 'production', PUBLIC_SITE_URL: 'www.gcdis.in' } as any)).toHaveLength(1);
    expect(emailLinkConfigErrors({ NODE_ENV: 'production', PUBLIC_SITE_URL: 'https://www.gcdis.in' } as any)).toEqual([]);
    expect(read('apps', 'api', 'src', 'main.ts')).toContain('emailLinkConfigErrors(process.env)');
  });
});

describe('Admin: pending codes, reveal, resend and mark verified', () => {
  let prisma: any;
  let recovery: AccountRecoveryService;

  beforeEach(() => {
    ({ prisma, recovery } = setup());
  });

  test('reveal returns the current code and audits the staff member and target (without the code)', async () => {
    const captain = addUser(prisma);
    await recovery.sendVerificationEmail(captain);
    const code = lastCode();
    const out = await recovery.adminRevealVerificationCode(EVENT_ADMIN, captain.id, '10.3.3.3', 'jest');
    expect(out).toMatchObject({ code, attemptsRemaining: MAX_CODE_ATTEMPTS, expiresAt: expect.any(String) });
    const entry = prisma.audit.find((a: any) => a.action === 'USER_VERIFICATION_CODE_REVEALED');
    expect(entry).toMatchObject({ actorId: EVENT_ADMIN.id, actorRole: 'EVENT_ADMIN', entityId: captain.id, ipAddress: '10.3.3.3' });
    expect(JSON.stringify(prisma.audit)).not.toContain(code);
    // The revealed code works for the captain
    await expect(recovery.verifyEmailCode(captain.id, code)).resolves.toEqual({ success: true });
  });

  test('reveal: 404 without a live code, refused for staff, self, deactivated and verified accounts', async () => {
    const noCode = addUser(prisma);
    expect((await errorOf(recovery.adminRevealVerificationCode(ACTOR, noCode.id))).body.code).toBe('NO_PENDING_CODE');
    const expired = addUser(prisma);
    await recovery.sendVerificationEmail(expired);
    prisma.tokens[prisma.tokens.length - 1].expiresAt = new Date(Date.now() - 1);
    expect((await errorOf(recovery.adminRevealVerificationCode(ACTOR, expired.id))).body.code).toBe('NO_PENDING_CODE');
    for (const role of ['SUPER_ADMIN', 'EVENT_ADMIN', 'JUDGE', 'INSPECTOR']) {
      const staff = addUser(prisma, { role });
      expect((await errorOf(recovery.adminRevealVerificationCode(ACTOR, staff.id))).body.code).toBe('ROLE_BOUNDARY');
    }
    const self = addUser(prisma, { id: ACTOR.id });
    expect((await errorOf(recovery.adminRevealVerificationCode(ACTOR, self.id))).body.code).toBe('SELF_MODIFICATION_NOT_ALLOWED');
    const off = addUser(prisma, { isActive: false });
    expect((await errorOf(recovery.adminRevealVerificationCode(ACTOR, off.id))).body.code).toBe('ACCOUNT_DEACTIVATED');
    const done = addUser(prisma, { emailVerifiedAt: new Date() });
    expect((await errorOf(recovery.adminRevealVerificationCode(ACTOR, done.id))).body.code).toBe('ALREADY_VERIFIED');
    expect(prisma.audit.filter((a: any) => a.action === 'USER_VERIFICATION_CODE_REVEALED')).toHaveLength(0);
  });

  test('pending list carries code metadata (sent, expiry, attempts) but never the code or ciphertext', async () => {
    const auth = (recovery as any).authService as AuthService;
    const captain = addUser(prisma);
    await recovery.sendVerificationEmail(captain);
    const code = lastCode();
    prisma.user.findMany.mockResolvedValueOnce([
      { ...captain, teamsLed: [{ id: 't1', name: 'VGDUWU', code: 'T1', _count: { registrations: 0 } }] }
    ]);
    prisma.user.count.mockResolvedValueOnce(1);
    jest.spyOn(auth, 'findCaptainsAwaitingVerification');
    const result = await recovery.listPendingVerifications({ take: 25, skip: 0 });
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      id: captain.id,
      teams: [{ name: 'VGDUWU', registrationCount: 0 }],
      pendingCode: { attemptsRemaining: MAX_CODE_ATTEMPTS, sentAt: expect.any(String), expiresAt: expect.any(String) }
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain(code);
    expect(json).not.toContain('codeCipher');
    expect(json).not.toContain('passwordHash');
  });

  test('resend: sends a new code and audits it with the staff actor; shares the captain limits', async () => {
    const captain = addUser(prisma);
    await expect(recovery.adminResendVerification(ACTOR, captain.id, '10.1.1.1', 'jest')).resolves.toMatchObject({
      success: true,
      email: captain.email
    });
    expect(MailService.testOutbox[0].subject).toMatch(/^Your GCDIS verification code: \d{6}$/);
    expect(prisma.audit.find((a: any) => a.action === 'USER_VERIFICATION_EMAIL_RESENT')).toMatchObject({
      actorId: ACTOR.id,
      entityId: captain.id,
      afterState: expect.objectContaining({ targetEmail: captain.email, emailSent: true })
    });
    expect((await errorOf(recovery.adminResendVerification(ACTOR, captain.id))).body.code).toBe('RESEND_COOLDOWN');
  });

  test('mark verified: sets emailVerifiedAt, burns pending codes and writes an audit entry with the reason', async () => {
    const captain = addUser(prisma);
    await recovery.sendVerificationEmail(captain);
    const out = await recovery.adminMarkEmailVerified(EVENT_ADMIN, captain.id, '  Confirmed by telephone  ', '10.2.2.2', 'jest');
    expect(out).toMatchObject({ id: captain.id, emailVerified: true });
    expect(out).not.toHaveProperty('passwordHash');
    expect(prisma.tokens.every((t: any) => t.usedAt instanceof Date && t.codeCipher === null)).toBe(true);
    expect(prisma.audit.find((a: any) => a.action === 'USER_EMAIL_MARKED_VERIFIED')).toMatchObject({
      actorId: EVENT_ADMIN.id,
      entityId: captain.id,
      beforeState: { emailVerifiedAt: null },
      afterState: expect.objectContaining({ method: 'MANUAL', reason: 'Confirmed by telephone' })
    });
  });

  test('mark verified / resend refused for staff and super administrator accounts and the caller', async () => {
    for (const role of ['SUPER_ADMIN', 'EVENT_ADMIN', 'JUDGE', 'INSPECTOR']) {
      const staff = addUser(prisma, { role });
      expect((await errorOf(recovery.adminMarkEmailVerified(ACTOR, staff.id, undefined))).body.code).toBe('ROLE_BOUNDARY');
      expect((await errorOf(recovery.adminResendVerification(ACTOR, staff.id))).body.code).toBe('ROLE_BOUNDARY');
      expect(staff.emailVerifiedAt).toBeNull();
    }
    const self = addUser(prisma, { id: ACTOR.id });
    expect((await errorOf(recovery.adminMarkEmailVerified(ACTOR, self.id, undefined))).body.code).toBe('SELF_MODIFICATION_NOT_ALLOWED');
    const done = addUser(prisma, { emailVerifiedAt: new Date() });
    expect((await errorOf(recovery.adminMarkEmailVerified(ACTOR, done.id, undefined))).body.code).toBe('ALREADY_VERIFIED');
    expect(prisma.audit.filter((a: any) => a.action === 'USER_EMAIL_MARKED_VERIFIED')).toHaveLength(0);
  });

  test('user listing: captains scope, search and verification filter; staff scope unchanged', async () => {
    const auth = (recovery as any).authService as AuthService;
    prisma.user.findMany.mockResolvedValueOnce([]);
    await auth.findCaptainsAwaitingVerification({ take: 25, skip: 0 }, 'vgd');
    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual(
      expect.arrayContaining([{ role: 'TEAM_CAPTAIN' }, { emailVerifiedAt: null }, { isActive: true }, expect.objectContaining({ OR: expect.any(Array) })])
    );
    await auth.findUsersWithTotal({ take: 10, skip: 0 }, 'staff');
    expect(prisma.user.findMany.mock.calls[1][0].where).toEqual({ role: { in: ['SUPER_ADMIN', 'EVENT_ADMIN', 'JUDGE', 'INSPECTOR'] } });
  });
});

describe('Endpoint wiring: authorisation, step-up and rate limits', () => {
  const guards = (target: any, name: string) => Reflect.getMetadata(GUARDS_METADATA, target.prototype[name]) || [];
  const roles = (target: any, name: string) => Reflect.getMetadata(ROLES_KEY, target.prototype[name]);
  const rule = (target: any, name: string) => Reflect.getMetadata(RATE_LIMIT_KEY, target.prototype[name]);

  test('reveal code and mark verified: administrators, CSRF and step-up', () => {
    for (const name of ['adminRevealVerificationCode', 'adminMarkEmailVerified']) {
      expect(roles(AuthController, name)).toEqual(['SUPER_ADMIN', 'EVENT_ADMIN']);
      const g = guards(AuthController, name);
      expect(g).toEqual(expect.arrayContaining([RolesGuard, CsrfGuard, StepUpGuard]));
      expect(g.indexOf(StepUpGuard)).toBeGreaterThan(g.indexOf(CsrfGuard));
    }
    expect(rule(AuthController, 'adminRevealVerificationCode')).toMatchObject({ points: 30, duration: 3600 });
  });

  test('admin resend: administrators, CSRF, rate limited (10 per hour), no step-up', () => {
    expect(roles(AuthController, 'adminResendVerification')).toEqual(['SUPER_ADMIN', 'EVENT_ADMIN']);
    expect(guards(AuthController, 'adminResendVerification')).toEqual(expect.arrayContaining([RolesGuard, CsrfGuard, AccountIpRateLimiterGuard]));
    expect(guards(AuthController, 'adminResendVerification')).not.toContain(StepUpGuard);
    expect(rule(AuthController, 'adminResendVerification')).toMatchObject({ points: 10, duration: 3600 });
  });

  test('captain endpoints: verify-code and resend are captain-only, CSRF checked, limited per account and per IP', () => {
    for (const name of ['verifyEmailCode', 'resendVerification']) {
      expect(roles(AuthController, name)).toEqual(['TEAM_CAPTAIN']);
      expect(guards(AuthController, name)).toEqual(expect.arrayContaining([RolesGuard, CsrfGuard, AccountIpRateLimiterGuard]));
    }
    expect(rule(AuthController, 'verifyEmailCode')).toMatchObject({ points: 10, duration: 900, ipPoints: 30 });
    expect(rule(AuthController, 'resendVerification')).toMatchObject({ points: 5, duration: 3600, ipPoints: 20 });
    expect(roles(AuthController, 'verificationStatus')).toEqual(['TEAM_CAPTAIN']);
  });

  test('pending list: administrators; email-delivery is public', () => {
    expect(roles(AuthController, 'getCaptainsAwaitingVerification')).toEqual(['SUPER_ADMIN', 'EVENT_ADMIN']);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, (AuthController.prototype as any).getEmailDelivery)).toBe(true);
  });

  test('mail status / test: Super Administrator only; test is CSRF checked and rate limited', () => {
    expect(roles(MailController, 'status')).toEqual(['SUPER_ADMIN']);
    expect(roles(MailController, 'sendTest')).toEqual(['SUPER_ADMIN']);
    expect(guards(MailController, 'sendTest')).toEqual(expect.arrayContaining([RolesGuard, CsrfGuard, AccountIpRateLimiterGuard]));
    expect(rule(MailController, 'sendTest')).toMatchObject({ points: 5, duration: 900 });
  });

  const ctx = (handler: any, cls: any, user: any, ip = '10.9.9.9') =>
    ({
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => ({ user, ip, route: { path: '/x' } }), getResponse: () => ({ setHeader: jest.fn() }) })
    }) as any;

  test('RolesGuard: non-staff, judges and inspectors are denied the reveal; administrators pass', () => {
    const guard = new RolesGuard(new Reflector());
    const reveal = (AuthController.prototype as any).adminRevealVerificationCode;
    expect(guard.canActivate(ctx(reveal, AuthController, { id: 'a', role: 'SUPER_ADMIN', aud: 'gcdis-admin' }))).toBe(true);
    expect(guard.canActivate(ctx(reveal, AuthController, { id: 'e', role: 'EVENT_ADMIN', aud: 'gcdis-admin' }))).toBe(true);
    expect(guard.canActivate(ctx(reveal, AuthController, { id: 'j', role: 'JUDGE', aud: 'gcdis-admin' }))).toBe(false);
    expect(guard.canActivate(ctx(reveal, AuthController, { id: 'i', role: 'INSPECTOR', aud: 'gcdis-admin' }))).toBe(false);
    expect(() => guard.canActivate(ctx(reveal, AuthController, { id: 'c', role: 'TEAM_CAPTAIN', aud: 'gcdis-public' }))).toThrow(
      /Admin routes reject public tokens/
    );
    // A captain token presented as admin audience still fails the role check
    expect(guard.canActivate(ctx(reveal, AuthController, { id: 'c', role: 'TEAM_CAPTAIN', aud: 'gcdis-admin' }))).toBe(false);
  });

  test('StepUpGuard: reveal answers 403 STEP_UP_REQUIRED without a recent step-up', () => {
    const guard = new StepUpGuard();
    const reveal = (AuthController.prototype as any).adminRevealVerificationCode;
    let err: any = null;
    try {
      guard.canActivate(ctx(reveal, AuthController, { id: 'a', role: 'SUPER_ADMIN', stepUpAt: null }));
    } catch (e) {
      err = e;
    }
    expect(err.getResponse()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(guard.canActivate(ctx(reveal, AuthController, { id: 'a', role: 'SUPER_ADMIN', stepUpAt: new Date() }))).toBe(true);
  });

  test('rate limits: verify-code 429 after 10 per account+IP; resend 429 after 5; admin resend after 10', async () => {
    const guard = new AccountIpRateLimiterGuard(new Reflector());
    const run = async (name: string, allowed: number) => {
      const handler = (AuthController.prototype as any)[name];
      const user = { id: `u-${crypto.randomUUID()}` };
      const ip = `10.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}.9`;
      for (let i = 0; i < allowed; i++) await expect(guard.canActivate(ctx(handler, AuthController, user, ip))).resolves.toBe(true);
      const err: any = await guard.canActivate(ctx(handler, AuthController, user, ip)).catch((e) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(429);
    };
    await run('verifyEmailCode', 10);
    await run('resendVerification', 5);
    await run('adminResendVerification', 10);
  });

  test('verify-code per-IP limit applies across accounts (30 per IP)', async () => {
    const guard = new AccountIpRateLimiterGuard(new Reflector());
    const handler = (AuthController.prototype as any).verifyEmailCode;
    const ip = `10.250.${Math.floor(Math.random() * 200)}.1`;
    for (let i = 0; i < 30; i++) {
      await expect(guard.canActivate(ctx(handler, AuthController, { id: `acct-${i}-${crypto.randomUUID()}` }, ip))).resolves.toBe(true);
    }
    const err: any = await guard.canActivate(ctx(handler, AuthController, { id: 'fresh-account' }, ip)).catch((e) => e);
    expect(err.getStatus()).toBe(429);
  });

  test('controller: passes the staff actor; validates the code body', async () => {
    const recovery: any = {
      adminMarkEmailVerified: jest.fn().mockResolvedValue({ id: 'c1', emailVerified: true }),
      adminResendVerification: jest.fn().mockResolvedValue({ success: true }),
      adminRevealVerificationCode: jest.fn().mockResolvedValue({ code: '123456' }),
      verifyEmailCode: jest.fn().mockResolvedValue({ success: true })
    };
    const controller = new AuthController({} as any, {} as any, recovery);
    const req = { user: ACTOR };
    await controller.adminMarkEmailVerified(req, 'c1', { reason: 'Phoned' }, '10.0.0.1', 'jest');
    expect(recovery.adminMarkEmailVerified).toHaveBeenCalledWith(ACTOR, 'c1', 'Phoned', '10.0.0.1', 'jest');
    await expect(controller.adminMarkEmailVerified(req, 'c1', { reason: 'x', extra: 1 }, '10.0.0.1', 'jest')).rejects.toThrow();
    await controller.adminRevealVerificationCode(req, 'c1', '10.0.0.1', 'jest');
    expect(recovery.adminRevealVerificationCode).toHaveBeenCalledWith(ACTOR, 'c1', '10.0.0.1', 'jest');
    await controller.verifyEmailCode({ user: { id: 'cap' } }, { code: ' 123456 ' }, '10.0.0.1', 'jest');
    expect(recovery.verifyEmailCode).toHaveBeenCalledWith('cap', '123456', '10.0.0.1', 'jest');
    await expect(controller.verifyEmailCode({ user: { id: 'cap' } }, { code: '12ab56' }, '10.0.0.1', 'jest')).rejects.toThrow();
  });
});

describe('SMTP configuration and the staff test email', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    jest.resetModules();
  });

  test('provider settings: Gmail 587 STARTTLS (app password spaces removed), 465 implicit TLS, STARTTLS required in production', () => {
    const gmail = smtpSettings({ SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '587', SMTP_SECURE: 'false', SMTP_USER: ' me@gmail.com ', SMTP_PASSWORD: 'abcd efgh ijkl mnop' } as any)!;
    expect(gmail).toMatchObject({ host: 'smtp.gmail.com', port: 587, secure: false, user: 'me@gmail.com', pass: 'abcdefghijklmnop', requireTLS: false });
    expect(smtpSettings({ NODE_ENV: 'production', SMTP_HOST: 'smtp-relay.brevo.com', SMTP_PORT: '587' } as any)!.requireTLS).toBe(true);
    expect(smtpSettings({ SMTP_HOST: 'smtp.resend.com', SMTP_PORT: '465' } as any)!).toMatchObject({ secure: true, requireTLS: false });
    expect(smtpSettings({ SMTP_HOST: 'smtp.zoho.in', SMTP_REQUIRE_TLS: 'true' } as any)!).toMatchObject({ port: 587, requireTLS: true });
    // only Gmail app passwords lose their inner spaces
    expect(smtpSettings({ SMTP_HOST: 'smtp.zoho.com', SMTP_PASSWORD: ' a b ' } as any)!.pass).toBe('a b');
    expect(smtpSettings({ SMTP_HOST: '  ' } as any)).toBeNull();
    expect(smtpProviderName('smtp-relay.brevo.com')).toBe('Brevo');
    expect(smtpProviderName('smtp.gmail.com')).toMatch(/Gmail/);
    expect(maskUser('admin@example.test')).toBe('ad***@example.test');
    expect(mailConfigErrors({ NODE_ENV: 'production', SMTP_HOST: 'h', MAIL_FROM: 'no address' } as any)).toHaveLength(1);
  });

  test('errors never contain the password or user, and carry a provider hint', () => {
    const e = { SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'owner@gmail.com', SMTP_PASSWORD: 'abcd efgh ijkl mnop' } as any;
    const b64 = Buffer.from('\u0000owner@gmail.com\u0000abcdefghijklmnop').toString('base64');
    const details = describeMailError(
      { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN', message: `Invalid login: 535 for owner@gmail.com pass abcdefghijklmnop ${b64}` },
      e
    );
    expect(details.message).not.toContain('abcdefghijklmnop');
    expect(details.message).not.toContain('owner@gmail.com');
    expect(details.message).not.toContain(b64);
    expect(details).toMatchObject({ code: 'EAUTH', responseCode: 535 });
    expect(details.hint).toMatch(/app password/i);
    expect(describeMailError({ code: 'ETIMEDOUT', message: 'Connection timeout' }, { SMTP_HOST: 'smtp.example.test' } as any).hint).toMatch(/connect/i);
    expect(redactSecrets('x', {} as any)).toBe('x');
  });

  test('describeConfig is secret-free', () => {
    process.env.NODE_ENV = 'development';
    process.env.SMTP_HOST = 'smtp.gmail.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'owner@gmail.com';
    process.env.SMTP_PASSWORD = 'super-secret-app-pass';
    process.env.MAIL_FROM = 'GCDIS <other@example.test>';
    const summary = new MailService().describeConfig();
    expect(summary).toMatchObject({ mode: 'smtp', configured: true, host: 'smtp.gmail.com', port: 587, passwordSet: true, authUser: 'ow***@gmail.com' });
    expect(JSON.stringify(summary)).not.toContain('super-secret-app-pass');
    expect(JSON.stringify(summary)).not.toContain('owner@gmail.com');
    expect(summary.warnings.join(' ')).toMatch(/MAIL_FROM differs/);
  });

  test('sendTest reports the SMTP failure without secrets; dev without SMTP reports the outbox', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.MAIL_OUTBOX_DIR;
    process.env.SMTP_HOST = '';
    MailService.testOutbox = [];
    const local = await new MailService().sendTest('staff@example.test', 'staff@example.test');
    expect(local).toMatchObject({ ok: true, configured: false, mode: 'test-memory' });
    expect(MailService.testOutbox[0].subject).toBe('GCDIS: Outgoing email test');

    process.env.SMTP_HOST = 'smtp.example.test';
    process.env.SMTP_USER = 'mailer@example.test';
    process.env.SMTP_PASSWORD = 'pw-0123456789';
    const err: any = new Error('Invalid login: 535 Authentication failed for mailer@example.test with pw-0123456789');
    err.code = 'EAUTH';
    err.responseCode = 535;
    jest.doMock('nodemailer', () => ({ createTransport: () => ({ sendMail: jest.fn().mockRejectedValue(err) }) }));
    const { MailService: Fresh } = require('../apps/api/src/mail/mail.service');
    const result = await new Fresh().sendTest('staff@example.test', 'staff@example.test');
    expect(result).toMatchObject({ ok: false, configured: true, mode: 'smtp', error: { code: 'EAUTH', responseCode: 535 } });
    expect(JSON.stringify(result)).not.toContain('pw-0123456789');
    expect(JSON.stringify(result)).not.toContain('mailer@example.test');
  });

  test('MailController.sendTest sends to the signed-in staff member and audits the outcome', async () => {
    const mail: any = { sendTest: jest.fn().mockResolvedValue({ ok: false, mode: 'smtp', error: { code: 'EAUTH', responseCode: 535 } }) };
    const audit: any = { logAction: jest.fn().mockResolvedValue(undefined) };
    const controller = new MailController(mail, audit);
    await controller.sendTest({ user: ACTOR }, '10.0.0.5', 'jest');
    expect(mail.sendTest).toHaveBeenCalledWith(ACTOR.email, ACTOR.email);
    expect(audit.logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MAIL_TEST_SENT', actorId: ACTOR.id, afterState: expect.objectContaining({ ok: false, errorCode: 'EAUTH' }) })
    );
  });

  test('.env.example documents the SMTP variables with a commented Gmail example and no credentials', () => {
    for (const file of [read('.env.example'), read('apps', 'api', '.env.example')]) {
      for (const key of ['SMTP_HOST=', 'SMTP_PORT=', 'SMTP_USER=', 'SMTP_PASSWORD=', 'SMTP_SECURE=', 'MAIL_FROM=']) expect(file).toContain(key);
      expect(file).toMatch(/^#\s+SMTP_HOST=smtp\.gmail\.com/m);
      expect(file).toMatch(/App password/i);
      expect(file).toMatch(/^SMTP_PASSWORD=$/m);
      expect(file).toMatch(/^SMTP_USER=$/m);
    }
  });
});

describe('Portal and console UI wiring', () => {
  test('portal: six-box code step with paste, numeric input, one-time-code autofill, resend cooldown', () => {
    const step = read('apps', 'web', 'src', 'app', 'portal', '_components', 'EmailCodeVerification.tsx');
    expect(step).toContain('inputMode="numeric"');
    expect(step).toContain("autoComplete={i === 0 ? 'one-time-code' : 'off'}");
    expect(step).toContain('onPaste=');
    expect(step).toContain("'/auth/verify-email-code'");
    expect(step).toContain("'/auth/resend-verification'");
    expect(step).toContain("'/auth/verification-status'");
    expect(step).toMatch(/Resend code \(\$\{formatSeconds\(cooldown\)\}\)/);
    expect(step).toContain('announceEmailVerified()');
    expect(step).toMatch(/process\.env\.NODE_ENV !== 'production' && deliveryConfigured === false/);
    const banner = read('apps', 'web', 'src', 'app', 'portal', '_components', 'EmailVerificationBanner.tsx');
    expect(banner).toContain('Verify your email');
    expect(banner).toContain('<EmailCodeVerification');
  });

  test('portal: the blocker is shown where the captain registers and pays, and success unlocks at once', () => {
    const setup = read('apps', 'web', 'src', 'app', 'portal', '_components', 'TeamSetupPanel.tsx');
    expect(setup).toContain('<VerificationRequiredNotice gate={verificationGate} action="submit the registration" />');
    const overview = read('apps', 'web', 'src', 'app', 'portal', '_components', 'OverviewTab.tsx');
    expect(overview).toContain('action="pay the entry fee"');
    const notice = read('apps', 'web', 'src', 'app', 'portal', '_components', 'VerificationRequiredNotice.tsx');
    expect(notice).toContain('focusCodeInput');
    const page = read('apps', 'web', 'src', 'app', 'portal', 'page.tsx');
    expect(page).toContain('onVerified={handleEmailVerified}');
    expect(page).toContain('setEmailVerified(true);');
    expect(page).toContain('onEmailVerifiedElsewhere(');
  });

  test('console: pending verifications with masked codes and Reveal, badge on the menu, mail diagnostics', () => {
    const panel = read('apps', 'admin', 'src', 'app', '_components', 'AwaitingVerificationPanel.tsx');
    expect(panel).toContain('Pending Email Verifications');
    expect(panel).toContain('/reveal-verification-code');
    expect(panel).toContain("MASKED_CODE = '••••••'");
    expect(panel).toContain('Resend Code');
    expect(panel).toContain('Mark Verified');
    const regs = read('apps', 'admin', 'src', 'app', '_components', 'RegistrationsTab.tsx');
    expect(regs).toContain('<AwaitingVerificationPanel />');
    const page = read('apps', 'admin', 'src', 'app', 'page.tsx');
    expect(page).toContain("{id === 'registrations' && <PendingVerificationBadge");
    const users = read('apps', 'admin', 'src', 'app', '_components', 'UsersTab.tsx');
    expect(users).toContain('{canManage && <CaptainAccounts />}');
    const security = read('apps', 'admin', 'src', 'app', '_components', 'SecurityTab.tsx');
    expect(security).toContain("currentUser?.role === 'SUPER_ADMIN' && <MailDiagnostics");
  });
});

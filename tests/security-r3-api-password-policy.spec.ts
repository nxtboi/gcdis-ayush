import 'reflect-metadata';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';

jest.mock('bcryptjs', () => {
  const actual = jest.requireActual('bcryptjs');
  return { ...actual, compare: jest.fn((...args: any[]) => actual.compare(...args)) };
});
import {
  checkPasswordRules,
  evaluatePasswordPolicy,
  isHibpCheckEnabled,
  isPasswordBreached,
  PASSWORD_POLICY_MESSAGES
} from '../apps/api/src/auth/password-policy';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { TwoFactorService } from '../apps/api/src/auth/two-factor.service';

const rootDir = path.resolve(__dirname, '..');

function sha1(value: string) {
  return crypto.createHash('sha1').update(value).digest('hex').toUpperCase();
}

/** fetch mock answering the HIBP range API; `breached` passwords are listed with a count, plus padding rows. */
function hibpFetch(breached: string[] = []) {
  return jest.fn(async (url: string, init?: any) => {
    const prefix = String(url).split('/').pop()!;
    const rows = breached
      .map(sha1)
      .filter((h) => h.startsWith(prefix))
      .map((h) => `${h.slice(5)}:42`);
    rows.push('0000000000000000000000000000000000A:0'); // padding row
    return { ok: true, status: 200, text: async () => rows.join('\r\n') } as any;
  });
}

const STRONG = 'Quiet-Harbour-Lantern-58';

describe('Password policy rules (security round 3)', () => {
  test('length bounds: 12 minimum, 128 maximum', () => {
    expect(checkPasswordRules('Ab1!short')).toMatchObject({ ok: false, reason: 'TOO_SHORT' });
    expect(checkPasswordRules(undefined)).toMatchObject({ ok: false, reason: 'TOO_SHORT' });
    expect(checkPasswordRules('Aa1!'.repeat(32))).toEqual({ ok: true });
    expect(checkPasswordRules('Aa1!'.repeat(32) + 'x')).toMatchObject({ ok: false, reason: 'TOO_LONG' });
  });

  test('requires at least three of four character classes', () => {
    expect(checkPasswordRules('alllowercaseletters')).toMatchObject({ ok: false, reason: 'CHARACTER_CLASSES' });
    expect(checkPasswordRules('lowercaseand12345')).toMatchObject({ ok: false, reason: 'CHARACTER_CLASSES' });
    // three classes are enough (no symbol)
    expect(checkPasswordRules('Lowercase12345')).toEqual({ ok: true });
    // three classes are enough (no digit)
    expect(checkPasswordRules('Lower-Case-Words')).toEqual({ ok: true });
  });

  test('rejects passwords containing the email local part (case-insensitive), ignores very short local parts', () => {
    expect(checkPasswordRules('My-Jane.Doe-2026', 'jane.doe@example.org')).toMatchObject({ ok: false, reason: 'CONTAINS_EMAIL' });
    expect(checkPasswordRules('Quiet-Harbour-58', 'jane.doe@example.org')).toEqual({ ok: true });
    expect(checkPasswordRules('Quiet-Harbour-58a', 'a@example.org')).toEqual({ ok: true });
  });

  test('messages are formal sentences', () => {
    for (const message of Object.values(PASSWORD_POLICY_MESSAGES)) {
      expect(message).toMatch(/^[A-Z][^!]*\.$/);
    }
  });
});

describe('Have I Been Pwned k-anonymity check', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.HIBP_CHECK = 'true';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  test('sends only the 5-character SHA-1 prefix with Add-Padding and detects a breached password', async () => {
    const fetchImpl = hibpFetch(['Password123!']);
    await expect(isPasswordBreached('Password123!', { fetchImpl: fetchImpl as any })).resolves.toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as any[];
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${sha1('Password123!').slice(0, 5)}`);
    expect(url).not.toContain(sha1('Password123!').slice(5));
    expect(init.headers['Add-Padding']).toBe('true');
    expect(init.signal).toBeDefined();
  });

  test('not listed (or only padding rows with count 0) -> false', async () => {
    await expect(isPasswordBreached(STRONG, { fetchImpl: hibpFetch(['Password123!']) as any })).resolves.toBe(false);
  });

  test('fails open with a warning on network error, HTTP error and timeout', async () => {
    const warn = jest.fn();
    const failing = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));
    await expect(isPasswordBreached(STRONG, { fetchImpl: failing as any, logger: { warn } })).resolves.toBeNull();
    const http503 = jest.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '' });
    await expect(isPasswordBreached(STRONG, { fetchImpl: http503 as any, logger: { warn } })).resolves.toBeNull();
    const hanging = jest.fn(
      (_url: string, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })
    );
    await expect(
      isPasswordBreached(STRONG, { fetchImpl: hanging as any, logger: { warn }, timeoutMs: 20 })
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[2][0]).toMatch(/timed out/);
  });

  test('HIBP_CHECK=false disables the lookup; off by default under NODE_ENV=test', async () => {
    process.env.HIBP_CHECK = 'false';
    const fetchImpl = hibpFetch(['Password123!']);
    await expect(isPasswordBreached('Password123!', { fetchImpl: fetchImpl as any })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(isHibpCheckEnabled({ NODE_ENV: 'test' } as any)).toBe(false);
    expect(isHibpCheckEnabled({ NODE_ENV: 'production' } as any)).toBe(true);
    expect(isHibpCheckEnabled({ NODE_ENV: 'production', HIBP_CHECK: 'false' } as any)).toBe(false);
  });

  test('evaluatePasswordPolicy combines the rules and the breach lookup', async () => {
    const fetchImpl = hibpFetch(['Password123!']);
    await expect(evaluatePasswordPolicy('Password123!', 'x@example.org', { fetchImpl: fetchImpl as any })).resolves.toMatchObject({
      ok: false,
      reason: 'BREACHED'
    });
    await expect(evaluatePasswordPolicy(STRONG, 'x@example.org', { fetchImpl: fetchImpl as any })).resolves.toEqual({ ok: true });
    // rule failures never reach the network
    fetchImpl.mockClear();
    await expect(evaluatePasswordPolicy('short', 'x@example.org', { fetchImpl: fetchImpl as any })).resolves.toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('AuthService applies the policy (WEAK_PASSWORD) and login hardening', () => {
  const env = { ...process.env };
  const realFetch = (globalThis as any).fetch;
  let prisma: any;
  let svc: AuthService;
  let created: any = null;

  beforeEach(() => {
    process.env.HIBP_CHECK = 'true';
    (globalThis as any).fetch = hibpFetch(['Password123!']);
    prisma = {
      user: {
        // lookup by email: no existing account; lookup by id (createSession): the created row
        findUnique: jest.fn().mockImplementation(({ where }: any) => Promise.resolve(where.id ? created : null)),
        create: jest.fn().mockImplementation(({ data }: any) => {
          created = { id: 'u-new', ...data };
          return Promise.resolve(created);
        })
      },
      session: { create: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      loginAttempt: { count: jest.fn().mockResolvedValue(0), create: jest.fn().mockResolvedValue({}) }
    };
    svc = new AuthService(prisma, new JwtService({ secret: 'r3_password_policy_test_secret_0123456789abcdef' }), new TwoFactorService());
  });
  afterEach(() => {
    (globalThis as any).fetch = realFetch;
    process.env = { ...env };
  });

  const weak = async (p: Promise<unknown>) => {
    const err: any = await p.then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ statusCode: 400, code: 'WEAK_PASSWORD' });
    return err.getResponse().message as string;
  };

  test('register refuses a breached password (HIBP, mocked fetch) and accepts a strong one', async () => {
    const message = await weak(svc.register({ email: 'cap@example.org', password: 'Password123!', fullName: 'Cap Tain' } as any));
    expect(message).toBe(PASSWORD_POLICY_MESSAGES.BREACHED);
    const ok = await svc.register({ email: 'cap@example.org', password: STRONG, fullName: 'Cap Tain' } as any, '10.0.0.1');
    expect(ok.user).toMatchObject({ email: 'cap@example.org', emailVerified: false });
    expect(ok.user.passwordHash).toBeUndefined();
  });

  test('register refuses passwords containing the email local part and passwords over 128 characters', async () => {
    await weak(svc.register({ email: 'harbour@example.org', password: 'Quiet-Harbour-Lantern-58', fullName: 'Cap Tain' } as any));
    expect(await weak(svc.register({ email: 'c@example.org', password: 'Aa1!'.repeat(40), fullName: 'Cap Tain' } as any))).toBe(
      PASSWORD_POLICY_MESSAGES.TOO_LONG
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  test('change-password validates the new password against the account email', async () => {
    const hash = await bcrypt.hash('Current-Passw0rd!', 4);
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'harbour@example.org', passwordHash: hash });
    prisma.user.update = jest.fn().mockResolvedValue({});
    await weak(svc.changePassword('u1', 'Current-Passw0rd!', 'Quiet-Harbour-Lantern-58'));
    await weak(svc.changePassword('u1', 'Current-Passw0rd!', 'Password123!'));
    await expect(svc.changePassword('u1', 'Current-Passw0rd!', 'Amber-Falcon-Orchard-73')).resolves.toMatchObject({ success: true });
  });

  test('login refuses passwords over 128 characters before any database or bcrypt work', async () => {
    const compare = bcrypt.compare as unknown as jest.Mock;
    compare.mockClear();
    await expect(svc.login({ email: 'cap@example.org', password: 'x'.repeat(129) } as any, '10.0.0.1')).rejects.toThrow(
      UnauthorizedException
    );
    expect(prisma.loginAttempt.count).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  });

  test('unknown and deactivated accounts still run bcrypt (constant-time-ish login)', async () => {
    const compare = bcrypt.compare as unknown as jest.Mock;
    compare.mockClear();
    await expect(svc.login({ email: 'nobody@example.org', password: STRONG } as any, '10.0.0.1')).rejects.toThrow(
      'Invalid email or password'
    );
    expect(compare).toHaveBeenCalledTimes(1);
    prisma.user.findUnique.mockResolvedValue({ id: 'u2', email: 'gone@example.org', isActive: false, passwordHash: 'x' });
    // Wrong password for a deactivated account: the generic answer (the state is not revealed)
    await expect(svc.login({ email: 'gone@example.org', password: STRONG } as any, '10.0.0.1')).rejects.toThrow(
      'Invalid email or password'
    );
    expect(compare).toHaveBeenCalledTimes(2);
  });

  test('bootstrap-admin uses the shared policy', () => {
    const code = fs.readFileSync(path.join(rootDir, 'apps', 'api', 'prisma', 'bootstrap-admin.ts'), 'utf-8');
    expect(code).toContain("from '../src/auth/password-policy'");
    expect(code).toContain('evaluatePasswordPolicy(tempPassword, adminEmail)');
  });
});

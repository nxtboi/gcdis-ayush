/**
 * Security audit 2026-10 (data protection): recovery-code strength and storage, production startup
 * checks (https site URLs, PASS_SIGNING_SECRET) and environment-specific session cookie names.
 * Prisma is mocked throughout; no database or network access.
 */
import * as crypto from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { AuthController } from '../apps/api/src/auth/auth.controller';
import { TwoFactorService, RECOVERY_CODE_FORMAT_VERSION } from '../apps/api/src/auth/two-factor.service';
import {
  getPassSigningSecret,
  productionDataProtectionConfigErrors,
  productionSecretConfigErrors
} from '../apps/api/src/auth/jwt-secrets';
import { emailLinkConfigErrors, publicSiteBase } from '../apps/api/src/auth/account-recovery.service';
import {
  REFRESH_COOKIE_PATH,
  accessTokenFromCookies,
  adminAccessTokenFromCookieHeader,
  clearCookieOptions,
  cookiesToClear,
  refreshTokenFromCookies,
  sessionCookieConfig,
  sessionCookieNames
} from '../apps/api/src/auth/session-cookies.util';

const JWT_SECRET = 'security_audit_2026_10_data_protection_secret_32+';
const savedEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...savedEnv };
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.TWO_FACTOR_ENCRYPTION_KEY = 'data_protection_spec_2fa_key_value_0123456789';
  delete process.env.REDIS_URL;
  process.env.NODE_ENV = 'test';
});

afterAll(() => {
  process.env = savedEnv;
});

const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}(-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}){3}$/;

// ---------------------------------------------------------------------------------------------------
describe('Recovery codes: format, entropy and HMAC storage', () => {
  test('10 codes, XXXX-XXXX-XXXX-XXXX in Crockford base32 (80 bits each), all distinct', () => {
    const { plaintextCodes, hashedRecords } = new TwoFactorService().generateRecoveryCodes();
    expect(plaintextCodes).toHaveLength(10);
    expect(hashedRecords).toHaveLength(10);
    for (const code of plaintextCodes) {
      expect(code).toMatch(CROCKFORD);
      // 16 symbols x log2(32) = 80 bits >= 64
      expect(code.replace(/-/g, '').length * Math.log2(32)).toBeGreaterThanOrEqual(64);
    }
    expect(new Set(plaintextCodes).size).toBe(10);
  });

  test('symbols are spread across the whole alphabet (no truncated / biased generator)', () => {
    const svc = new TwoFactorService();
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      for (const code of svc.generateRecoveryCodes().plaintextCodes) for (const ch of code.replace(/-/g, '')) seen.add(ch);
    }
    expect(seen.size).toBe(32);
  });

  test('records are { hash, used: false, v: 2 } with an HMAC-SHA256 under a key derived from the 2FA key', () => {
    const svc = new TwoFactorService();
    const { plaintextCodes, hashedRecords } = svc.generateRecoveryCodes();
    const record = hashedRecords[0];
    expect(record).toEqual({ hash: expect.stringMatching(/^[0-9a-f]{64}$/), used: false, v: RECOVERY_CODE_FORMAT_VERSION });
    expect(RECOVERY_CODE_FORMAT_VERSION).toBe(2);

    // Not an unsalted SHA-256 of the code
    expect(record.hash).not.toBe(crypto.createHash('sha256').update(plaintextCodes[0]).digest('hex'));
    // Not an HMAC directly under the raw 2FA key either (distinct label)
    const encKey = crypto.createHash('sha256').update(process.env.TWO_FACTOR_ENCRYPTION_KEY as string).digest();
    expect(record.hash).not.toBe(crypto.createHmac('sha256', encKey).update(plaintextCodes[0]).digest('hex'));
    // It is HMAC-SHA256(HMAC(encKey, label), code)
    const subKey = crypto.createHmac('sha256', encKey).update('gcdis-2fa-recovery-code-hmac-v2').digest();
    expect(record.hash).toBe(crypto.createHmac('sha256', subKey).update(plaintextCodes[0]).digest('hex'));
  });

  test('a different server key cannot verify the stored records', () => {
    const { plaintextCodes, hashedRecords } = new TwoFactorService().generateRecoveryCodes();
    process.env.TWO_FACTOR_ENCRYPTION_KEY = 'a_completely_different_2fa_key_value_9876543210';
    expect(new TwoFactorService().verifyRecoveryCode(plaintextCodes[0], hashedRecords).isValid).toBe(false);
  });

  test('input is normalised: lower case, spaces, missing hyphens and I/L/O aliases are accepted', () => {
    const svc = new TwoFactorService();
    const { plaintextCodes, hashedRecords } = svc.generateRecoveryCodes();
    const code = plaintextCodes[3];
    const sloppy = ` ${code.replace(/-/g, ' ').toLowerCase()} `;
    expect(svc.verifyRecoveryCode(sloppy, hashedRecords).isValid).toBe(true);
    expect(TwoFactorService.normalizeRecoveryCode('oooo-iiii-llll-0000')).toBe('0000-1111-1111-0000');
    expect(TwoFactorService.normalizeRecoveryCode('ABCD-EFGH-JKMN-PQRU')).toBeNull(); // U is not Crockford
    expect(TwoFactorService.normalizeRecoveryCode('ABCD-EFGH')).toBeNull();
  });

  test('wrong, empty and oversized inputs are rejected', () => {
    const svc = new TwoFactorService();
    const { hashedRecords } = svc.generateRecoveryCodes();
    expect(svc.verifyRecoveryCode('0000-0000-0000-0000', hashedRecords).isValid).toBe(false);
    expect(svc.verifyRecoveryCode('', hashedRecords).isValid).toBe(false);
    expect(svc.verifyRecoveryCode('A'.repeat(5000), hashedRecords).isValid).toBe(false);
    expect(svc.verifyRecoveryCode('123456', hashedRecords).isValid).toBe(false);
  });

  test('a code is single use: the matched record is marked used and cannot verify again', () => {
    const svc = new TwoFactorService();
    const { plaintextCodes, hashedRecords } = svc.generateRecoveryCodes();
    const first = svc.verifyRecoveryCode(plaintextCodes[5], hashedRecords);
    expect(first.isValid).toBe(true);
    expect(first.updatedRecords![5]).toMatchObject({ used: true, v: 2, hash: hashedRecords[5].hash });
    expect(first.updatedRecords!.filter((r) => r.used)).toHaveLength(1);
    expect(hashedRecords[5].used).toBe(false); // input not mutated
    expect(svc.verifyRecoveryCode(plaintextCodes[5], first.updatedRecords!).isValid).toBe(false);
    // the others still work
    expect(svc.verifyRecoveryCode(plaintextCodes[6], first.updatedRecords!).isValid).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('Recovery codes: legacy SHA-256 records keep working', () => {
  function legacyRecords() {
    const codes = ['A1B2-C3D4', '9F00-0E1D', 'BEEF-CAFE'];
    const records = codes.map((c) => ({ hash: crypto.createHash('sha256').update(c).digest('hex'), used: false }));
    return { codes, records };
  }

  test('a legacy (no v) record verifies with the old method, case-insensitively, and is consumed once', () => {
    const svc = new TwoFactorService();
    const { codes, records } = legacyRecords();
    const res = svc.verifyRecoveryCode(` ${codes[1].toLowerCase()} `, records);
    expect(res.isValid).toBe(true);
    expect(res.updatedRecords![1]).toMatchObject({ used: true, hash: records[1].hash });
    expect(res.updatedRecords![1].v).toBeUndefined();
    expect(svc.verifyRecoveryCode(codes[1], res.updatedRecords!).isValid).toBe(false);
  });

  test('a legacy hash is never accepted for a v2 record, nor a v2 HMAC for a legacy record', () => {
    const svc = new TwoFactorService();
    const { plaintextCodes, hashedRecords } = svc.generateRecoveryCodes();
    // v2 code against a record holding its plain SHA-256 but tagged v2: must fail
    const forged = [{ hash: crypto.createHash('sha256').update(plaintextCodes[0]).digest('hex'), used: false, v: 2 }];
    expect(svc.verifyRecoveryCode(plaintextCodes[0], forged).isValid).toBe(false);
    // v2 HMAC stored without the version tag: treated as legacy, so the code does not verify
    const untagged = [{ hash: hashedRecords[0].hash, used: false }];
    expect(svc.verifyRecoveryCode(plaintextCodes[0], untagged).isValid).toBe(false);
    // unknown future version is ignored
    expect(svc.verifyRecoveryCode(plaintextCodes[0], [{ ...hashedRecords[0], v: 3 }]).isValid).toBe(false);
  });

  test('mixed legacy and v2 records both verify', () => {
    const svc = new TwoFactorService();
    const { codes, records } = legacyRecords();
    const fresh = svc.generateRecoveryCodes();
    const mixed = [...records, ...fresh.hashedRecords];
    expect(svc.verifyRecoveryCode(codes[0], mixed).isValid).toBe(true);
    expect(svc.verifyRecoveryCode(fresh.plaintextCodes[9], mixed).isValid).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('Recovery codes: login consumption stays compare-and-swap', () => {
  async function setup(backupCodes: any[], claimCount = 1) {
    const twoFactor = new TwoFactorService();
    const secret = twoFactor.generateBase32Secret();
    const userId = `u-${crypto.randomUUID()}`;
    const user = {
      id: userId,
      email: 'cap@example.org',
      role: 'TEAM_CAPTAIN',
      isActive: true,
      isTwoFactorEnabled: true,
      mustChangePassword: false,
      twoFactor: { isEnabled: true, secret: twoFactor.encryptSecret(secret), lastUsedStep: null, backupCodes }
    };
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      twoFactor: { updateMany: jest.fn().mockResolvedValue({ count: claimCount }), update: jest.fn() },
      auditLog: { create: jest.fn() }
    };
    const svc = new AuthService(prisma, new JwtService({ secret: JWT_SECRET }), twoFactor, undefined as any, undefined as any);
    jest.spyOn(svc as any, 'createSession').mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
    const { twoFactorStateFingerprint } = await import('../apps/api/src/auth/auth.service');
    const challenge = (svc as any).signChallengeToken(userId, '2fa_challenge', '5m', { st: twoFactorStateFingerprint(user.twoFactor) });
    return { prisma, svc, challenge };
  }

  test('a v2 code signs in once, with the swap conditional on the unchanged records', async () => {
    const { plaintextCodes, hashedRecords } = new TwoFactorService().generateRecoveryCodes();
    const { prisma, svc, challenge } = await setup(hashedRecords);
    await expect(svc.verify2faLogin(challenge, plaintextCodes[0], '10.0.0.1')).resolves.toHaveProperty('accessToken', 'a');
    const call = prisma.twoFactor.updateMany.mock.calls[0][0];
    expect(call.where.backupCodes).toEqual({ equals: hashedRecords });
    expect(call.data.backupCodes.filter((r: any) => r.used)).toHaveLength(1);
    expect(call.data.backupCodes.every((r: any) => r.v === 2)).toBe(true);
  });

  test('a legacy code still signs in', async () => {
    const legacy = [{ hash: crypto.createHash('sha256').update('ABCD-1234').digest('hex'), used: false }];
    const { svc, challenge } = await setup(legacy);
    await expect(svc.verify2faLogin(challenge, 'abcd-1234', '10.0.0.1')).resolves.toHaveProperty('accessToken', 'a');
  });

  test('a lost race (count 0) issues no session', async () => {
    const { plaintextCodes, hashedRecords } = new TwoFactorService().generateRecoveryCodes();
    const { svc, challenge } = await setup(hashedRecords, 0);
    await expect(svc.verify2faLogin(challenge, plaintextCodes[0], '10.0.0.1')).rejects.toThrow(
      'This sign-in request has already been used or has expired. Please sign in again.'
    );
  });
});

// ---------------------------------------------------------------------------------------------------
describe('Production startup checks', () => {
  const strong = (tag: string) => `${tag}-${crypto.randomBytes(24).toString('hex')}`;
  const prodEnv = (extra: Record<string, string | undefined> = {}) =>
    ({
      NODE_ENV: 'production',
      JWT_SECRET: strong('jwt'),
      PASS_SIGNING_SECRET: strong('pass'),
      UPLOAD_SIGNING_SECRET: strong('upload'),
      PUBLIC_SITE_URL: 'https://www.gcdis.in',
      ADMIN_SITE_URL: 'https://admin.gcdis.in',
      ...extra
    }) as NodeJS.ProcessEnv;

  test('a complete https production config passes; development checks nothing', () => {
    expect(productionDataProtectionConfigErrors(prodEnv())).toEqual([]);
    expect(emailLinkConfigErrors(prodEnv())).toEqual([]);
    expect(productionDataProtectionConfigErrors({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toEqual([]);
    expect(emailLinkConfigErrors({ NODE_ENV: 'development', PUBLIC_SITE_URL: 'http://localhost:3000' } as any)).toEqual([]);
  });

  test('an http:// PUBLIC_SITE_URL is refused in production, and emailed links refuse to build', () => {
    const env = prodEnv({ PUBLIC_SITE_URL: 'http://www.gcdis.in' });
    expect(emailLinkConfigErrors(env)).toEqual([
      'PUBLIC_SITE_URL must be an absolute https:// URL such as https://www.gcdis.in (verification and password reset links).'
    ]);
    expect(() => publicSiteBase(env)).toThrow(/https/);
    expect(publicSiteBase(prodEnv())).toBe('https://www.gcdis.in');
    expect(publicSiteBase({ NODE_ENV: 'development' } as any)).toBe('http://localhost:3000');
  });

  test('UPLOAD_SIGNING_SECRET: missing, short, placeholder or equal to JWT_SECRET is refused', () => {
    expect(productionDataProtectionConfigErrors(prodEnv({ UPLOAD_SIGNING_SECRET: undefined }))).toEqual([
      'UPLOAD_SIGNING_SECRET is required in production.'
    ]);
    expect(productionDataProtectionConfigErrors(prodEnv({ UPLOAD_SIGNING_SECRET: 'short' }))[0]).toMatch(/at least/);
    expect(productionDataProtectionConfigErrors(prodEnv({ UPLOAD_SIGNING_SECRET: 'REPLACE_WITH_A_LONG_RANDOM_VALUE_0123456789' }))[0]).toMatch(/placeholder/);
    const shared = strong('same');
    expect(productionDataProtectionConfigErrors(prodEnv({ JWT_SECRET: shared, UPLOAD_SIGNING_SECRET: shared }))[0]).toMatch(
      /differ from JWT_SECRET/
    );
  });

  test('ADMIN_SITE_URL must be https when set (optional otherwise)', () => {
    expect(productionDataProtectionConfigErrors(prodEnv({ ADMIN_SITE_URL: 'http://admin.gcdis.in' }))).toEqual([
      'ADMIN_SITE_URL must be an absolute https:// URL in production (for example https://www.gcdis.in).'
    ]);
    expect(productionDataProtectionConfigErrors(prodEnv({ ADMIN_SITE_URL: 'admin.gcdis.in' }))).toHaveLength(1);
    expect(productionDataProtectionConfigErrors(prodEnv({ ADMIN_SITE_URL: undefined }))).toEqual([]);
  });

  test('PASS_SIGNING_SECRET: missing, short, placeholder or equal to JWT_SECRET is refused (never echoed)', () => {
    expect(productionDataProtectionConfigErrors(prodEnv({ PASS_SIGNING_SECRET: undefined }))).toEqual([
      'PASS_SIGNING_SECRET is required in production.'
    ]);
    expect(productionDataProtectionConfigErrors(prodEnv({ PASS_SIGNING_SECRET: 'short' }))).toEqual([
      'PASS_SIGNING_SECRET must be at least 32 characters in production.'
    ]);
    const placeholder = 'REPLACE_WITH_MINIMUM_32_CHAR_CRYPTO_SECURE_PASS_SIGNING_KEY';
    const errs = productionDataProtectionConfigErrors(prodEnv({ PASS_SIGNING_SECRET: placeholder }));
    expect(errs).toEqual(['PASS_SIGNING_SECRET contains placeholder text in production.']);
    expect(errs.join(' ')).not.toContain(placeholder);

    const reused = strong('shared');
    const reuseErrs = productionDataProtectionConfigErrors(prodEnv({ JWT_SECRET: reused, PASS_SIGNING_SECRET: reused }));
    expect(reuseErrs).toEqual(['PASS_SIGNING_SECRET must differ from JWT_SECRET in production.']);
    expect(reuseErrs.join(' ')).not.toContain(reused);
  });

  test('pass signing never falls back to JWT_SECRET in production; development derives a distinct key', () => {
    expect(() => getPassSigningSecret(prodEnv({ PASS_SIGNING_SECRET: undefined }))).toThrow(/PASS_SIGNING_SECRET/);
    const env = prodEnv();
    expect(getPassSigningSecret(env)).toBe(env.PASS_SIGNING_SECRET);

    const dev = { NODE_ENV: 'development', JWT_SECRET } as NodeJS.ProcessEnv;
    const derived = getPassSigningSecret(dev);
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    expect(derived).not.toBe(JWT_SECRET);
    expect(getPassSigningSecret({ ...dev, PASS_SIGNING_SECRET: 'dedicated-dev-pass-key' })).toBe('dedicated-dev-pass-key');
  });

  test('the existing secret check is unchanged and main.ts runs the new check', () => {
    expect(productionSecretConfigErrors({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const main = fs.readFileSync(path.join(__dirname, '../apps/api/src/main.ts'), 'utf-8');
    expect(main).toContain('productionDataProtectionConfigErrors(process.env)');
    expect(main).toContain('emailLinkConfigErrors(process.env)');
    const certs = fs.readFileSync(path.join(__dirname, '../apps/api/src/certificates/certificates.service.ts'), 'utf-8');
    expect(certs).not.toMatch(/PASS_SIGNING_SECRET\s*\|\|\s*process\.env\.JWT_SECRET/);
    const compose = fs.readFileSync(path.join(__dirname, '../docker-compose.prod.yml'), 'utf-8');
    expect(compose).not.toContain('JWT_REFRESH_SECRET:?');
    expect(compose).toContain('PASS_SIGNING_SECRET:?');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('Session cookies per environment', () => {
  const prod = {
    NODE_ENV: 'production',
    PUBLIC_SITE_URL: 'https://www.gcdis.in',
    ADMIN_SITE_URL: 'https://admin.gcdis.in'
  } as NodeJS.ProcessEnv;
  const dev = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;

  test('development keeps the legacy names over plain http at Path=/', () => {
    const cfg = sessionCookieConfig(dev);
    expect(cfg.names).toEqual({
      publicAccess: 'gcdis_access_token',
      publicRefresh: 'gcdis_refresh_token',
      adminAccess: 'gcdis_admin_access_token',
      adminRefresh: 'gcdis_admin_refresh_token'
    });
    expect(cfg.access).toEqual({ httpOnly: true, secure: false, sameSite: 'lax', path: '/' });
    expect(cfg.refresh).toEqual({ httpOnly: true, secure: false, sameSite: 'lax', path: '/' });
  });

  test('production uses __Host- access cookies (Path=/) and __Secure- refresh cookies at /api/auth', () => {
    const cfg = sessionCookieConfig(prod);
    expect(cfg.names).toEqual({
      publicAccess: '__Host-gcdis_access_token',
      publicRefresh: '__Secure-gcdis_refresh_token',
      adminAccess: '__Host-gcdis_admin_access_token',
      adminRefresh: '__Secure-gcdis_admin_refresh_token'
    });
    expect(cfg.access).toEqual({ httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
    expect(cfg.refresh).toEqual({ httpOnly: true, secure: true, sameSite: 'strict', path: REFRESH_COOKIE_PATH });
    expect(REFRESH_COOKIE_PATH).toBe('/api/auth');
    // __Host- requirements: Secure, Path=/, no Domain
    expect(cfg.access).not.toHaveProperty('domain');
    expect(cfg.refresh).not.toHaveProperty('domain');
  });

  test('reads use the environment names (legacy cookies are ignored in production)', () => {
    const adminReq = (cookies: Record<string, string>) => ({ headers: { origin: 'https://admin.gcdis.in' }, cookies });
    const legacy = { gcdis_admin_access_token: 'old-a', gcdis_admin_refresh_token: 'old-r' };
    expect(accessTokenFromCookies(adminReq(legacy), prod)).toBeNull();
    expect(refreshTokenFromCookies(adminReq(legacy), prod)).toBeNull();
    const current = { '__Host-gcdis_admin_access_token': 'new-a', '__Secure-gcdis_admin_refresh_token': 'new-r' };
    expect(accessTokenFromCookies(adminReq(current), prod)).toBe('new-a');
    expect(refreshTokenFromCookies(adminReq(current), prod)).toBe('new-r');

    const devReq = { headers: { origin: 'http://localhost:3000' }, cookies: { gcdis_access_token: 'p', gcdis_refresh_token: 'pr' } };
    expect(accessTokenFromCookies(devReq, dev)).toBe('p');
    expect(refreshTokenFromCookies(devReq, dev)).toBe('pr');
  });

  test('WebSocket handshakes read the staff cookie through the same helper', () => {
    expect(adminAccessTokenFromCookieHeader('a=1; __Host-gcdis_admin_access_token=tok%2E1', prod)).toBe('tok.1');
    expect(adminAccessTokenFromCookieHeader('gcdis_admin_access_token=old', prod)).toBeUndefined();
    expect(adminAccessTokenFromCookieHeader('gcdis_admin_access_token=dev', dev)).toBe('dev');
    expect(adminAccessTokenFromCookieHeader(undefined, dev)).toBeUndefined();
  });

  test('sign-out clears both the prefixed and the legacy names in production, with matching paths', () => {
    const adminReq = { headers: { origin: 'https://admin.gcdis.in' } };
    expect(cookiesToClear(adminReq, prod)).toEqual([
      '__Host-gcdis_admin_access_token',
      '__Secure-gcdis_admin_refresh_token',
      'gcdis_admin_access_token',
      'gcdis_admin_refresh_token'
    ]);
    expect(cookiesToClear({ headers: {} }, prod)).toHaveLength(8);
    expect(clearCookieOptions('__Secure-gcdis_admin_refresh_token', prod)).toMatchObject({ path: '/api/auth', secure: true });
    expect(clearCookieOptions('__Host-gcdis_admin_access_token', prod)).toMatchObject({ path: '/', secure: true });
    expect(clearCookieOptions('gcdis_admin_refresh_token', prod)).toMatchObject({ path: '/', secure: true });
    // development: unchanged
    expect(cookiesToClear({ headers: { origin: 'http://localhost:3000' } }, dev)).toEqual(['gcdis_access_token', 'gcdis_refresh_token']);
    expect(clearCookieOptions('gcdis_refresh_token', dev)).toEqual({ path: '/' });
  });

  test('the controller sets and clears cookies through the helper (production)', async () => {
    Object.assign(process.env, prod);
    const prisma: any = { session: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const svc = new AuthService(prisma, new JwtService({ secret: JWT_SECRET }), new TwoFactorService(), undefined as any, undefined as any);
    const controller = new AuthController(svc, {} as any);

    const res = { cookie: jest.fn(), clearCookie: jest.fn() };
    (controller as any).setAuthCookies(res, 'acc', 'ref', true);
    expect(res.cookie).toHaveBeenCalledWith('__Host-gcdis_admin_access_token', 'acc', expect.objectContaining({ secure: true, path: '/' }));
    expect(res.cookie).toHaveBeenCalledWith(
      '__Secure-gcdis_admin_refresh_token',
      'ref',
      expect.objectContaining({ secure: true, path: '/api/auth', httpOnly: true })
    );
    expect(sessionCookieNames().adminAccess).toBe('__Host-gcdis_admin_access_token');

    const req = { headers: { origin: 'https://admin.gcdis.in' }, cookies: { '__Secure-gcdis_admin_refresh_token': 'raw' }, body: {} };
    await controller.logout(req, res);
    expect(prisma.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { refreshTokenHash: crypto.createHash('sha256').update('raw').digest('hex') } })
    );
    const cleared = res.clearCookie.mock.calls.map((c: any[]) => [c[0], c[1].path]);
    expect(cleared).toEqual([
      ['__Host-gcdis_admin_access_token', '/'],
      ['__Secure-gcdis_admin_refresh_token', '/api/auth'],
      ['gcdis_admin_access_token', '/'],
      ['gcdis_admin_refresh_token', '/']
    ]);
  });

  test('development controller output is unchanged', () => {
    process.env.NODE_ENV = 'development';
    const controller = new AuthController({} as any, {} as any);
    const res = { cookie: jest.fn(), clearCookie: jest.fn() };
    (controller as any).setAuthCookies(res, 'acc', 'ref', false);
    expect(res.cookie).toHaveBeenCalledWith('gcdis_access_token', 'acc', expect.objectContaining({ secure: false, path: '/', sameSite: 'lax' }));
    expect(res.cookie).toHaveBeenCalledWith('gcdis_refresh_token', 'ref', expect.objectContaining({ secure: false, path: '/' }));
  });
});

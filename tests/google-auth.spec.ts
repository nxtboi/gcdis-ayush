import * as path from 'path';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { AuthController } from '../apps/api/src/auth/auth.controller';
import { TwoFactorService } from '../apps/api/src/auth/two-factor.service';
import { GoogleAuthService, STAFF_GOOGLE_REFUSAL } from '../apps/api/src/auth/google-auth.service';
import { CsrfGuard } from '../apps/api/src/common/guards/csrf.guard';
import { AccountIpRateLimiterGuard } from '../apps/api/src/common/guards/rate-limiter.guard';
import { IS_PUBLIC_KEY } from '../apps/api/src/common/decorators/public.decorator';

// Resolve google-auth-library exactly as the API resolves it (it may live in apps/api/node_modules).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { OAuth2Client } = require(require.resolve('google-auth-library', {
  paths: [path.join(__dirname, '../apps/api/src/auth')]
}));

const JWT_SECRET = 'google_auth_regression_test_secret_value_32+';
const CLIENT_ID = '1234567890-abc.apps.googleusercontent.com';
const GOOGLE_SUB = '109876543210987654321';

function payload(overrides: Record<string, any> = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: GOOGLE_SUB,
    email: 'Captain@Example.org',
    email_verified: true,
    name: 'Asha Captain',
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides
  };
}

describe('Sign in with Google (GIS ID-token flow)', () => {
  const savedEnv = { ...process.env };
  let verifySpy: jest.SpyInstance;
  let mockPrisma: any;
  let authService: AuthService;
  let googleService: GoogleAuthService;
  let controller: AuthController;

  const captain = (overrides: Record<string, any> = {}) => ({
    id: 'captain-1',
    email: 'captain@example.org',
    passwordHash: '$2a$12$hash',
    fullName: 'Existing Captain',
    role: 'TEAM_CAPTAIN',
    googleSub: null,
    isActive: true,
    mustChangePassword: false,
    isTwoFactorEnabled: false,
    ...overrides
  });

  const mockVerify = (p: any) =>
    verifySpy.mockResolvedValue({ getPayload: () => p });

  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
    delete process.env.GOOGLE_ALLOWED_HOSTED_DOMAINS;
    delete process.env.JWT_ADMIN_SECRET;
    process.env.NODE_ENV = 'test';

    verifySpy = jest.spyOn(OAuth2Client.prototype, 'verifyIdToken');

    const users = new Map<string, any>();
    mockPrisma = {
      _users: users,
      user: {
        findUnique: jest.fn(async ({ where }: any) => {
          if (where.id) return users.get(where.id) ?? null;
          if (where.googleSub) return [...users.values()].find((u) => u.googleSub === where.googleSub) ?? null;
          if (where.email) return [...users.values()].find((u) => u.email === where.email) ?? null;
          return null;
        }),
        findFirst: jest.fn(async ({ where }: any) => {
          const target = String(where.email.equals).toLowerCase();
          return [...users.values()].find((u) => u.email.toLowerCase() === target) ?? null;
        }),
        create: jest.fn(async ({ data }: any) => {
          const user = { id: `user-${users.size + 1}`, ...data };
          users.set(user.id, user);
          return user;
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const user = { ...users.get(where.id), ...data };
          users.set(where.id, user);
          return user;
        })
      },
      session: { create: jest.fn(async () => ({})) },
      loginAttempt: { create: jest.fn(async () => ({})) },
      auditLog: { create: jest.fn(async () => ({})) }
    };

    const jwtService = new JwtService({ secret: JWT_SECRET, signOptions: { expiresIn: '10m' } });
    authService = new AuthService(mockPrisma, jwtService, new TwoFactorService());
    googleService = new GoogleAuthService(mockPrisma, authService);
    controller = new AuthController(authService, googleService);
  });

  afterEach(() => {
    verifySpy.mockRestore();
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  const seed = (u: any) => mockPrisma._users.set(u.id, u);

  test('creates a new TEAM_CAPTAIN with an unusable password and issues a session', async () => {
    mockVerify(payload());
    const res = { cookie: jest.fn() };

    const body = await controller.googleLogin({ credential: 'id-token' }, '10.0.0.1', 'jest', res);

    expect(verifySpy).toHaveBeenCalledWith({ idToken: 'id-token', audience: CLIENT_ID });
    const created = mockPrisma.user.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      email: 'captain@example.org',
      fullName: 'Asha Captain',
      role: 'TEAM_CAPTAIN',
      googleSub: GOOGLE_SUB,
      authProvider: 'google',
      mustChangePassword: false,
      isActive: true
    });
    expect(created.passwordHash).toMatch(/^\$2[aby]\$12\$/);

    expect(body.user.email).toBe('captain@example.org');
    expect(body.user).not.toHaveProperty('passwordHash');
    expect(body.user).not.toHaveProperty('googleSub');
    expect(body.mustChangePassword).toBe(false);
    expect(res.cookie).toHaveBeenCalledWith('gcdis_access_token', expect.any(String), expect.objectContaining({ httpOnly: true }));
    expect(res.cookie).toHaveBeenCalledWith('gcdis_refresh_token', expect.any(String), expect.objectContaining({ httpOnly: true }));
    expect(mockPrisma.session.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.loginAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: 'captain@example.org', successful: true })
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'AUTH_GOOGLE_REGISTER', actorRole: 'TEAM_CAPTAIN' })
    });
  });

  test('links an existing captain by case-insensitive email, then logs in by googleSub', async () => {
    // A verified address keeps its password on linking (unverified accounts: takeover protection, see
    // security-audit-2026-10-auth.spec.ts)
    seed(captain({ emailVerifiedAt: new Date('2026-01-01T00:00:00Z') }));
    mockVerify(payload());

    const first = await googleService.loginWithGoogle('id-token', '10.0.0.1', 'jest');
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).toHaveBeenCalledWith({ where: { id: 'captain-1' }, data: { googleSub: GOOGLE_SUB } });
    expect(first.user.id).toBe('captain-1');
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'AUTH_GOOGLE_LINK' }) });

    mockPrisma.user.update.mockClear();
    const second = await googleService.loginWithGoogle('id-token', '10.0.0.1', 'jest');
    expect(second.user.id).toBe('captain-1');
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  test.each(['SUPER_ADMIN', 'EVENT_ADMIN', 'JUDGE', 'INSPECTOR'])(
    'refuses a %s email with 403 and never issues a session (staff 2FA cannot be bypassed)',
    async (role) => {
      seed(captain({ id: 'staff-1', email: 'captain@example.org', role, isTwoFactorEnabled: true }));
      mockVerify(payload());

      const err = await googleService.loginWithGoogle('id-token').catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.message).toBe(STAFF_GOOGLE_REFUSAL);
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockPrisma.session.create).not.toHaveBeenCalled();
      expect(mockPrisma.loginAttempt.create).toHaveBeenCalledWith({ data: expect.objectContaining({ successful: false }) });
    }
  );

  test('refuses a staff user even when a googleSub is already present on the row', async () => {
    seed(captain({ id: 'staff-2', role: 'SUPER_ADMIN', googleSub: GOOGLE_SUB }));
    mockVerify(payload());
    await expect(googleService.loginWithGoogle('id-token')).rejects.toThrow(ForbiddenException);
    expect(mockPrisma.session.create).not.toHaveBeenCalled();
  });

  test('refuses inactive captains', async () => {
    seed(captain({ isActive: false }));
    mockVerify(payload());
    await expect(googleService.loginWithGoogle('id-token')).rejects.toThrow(UnauthorizedException);
    expect(mockPrisma.session.create).not.toHaveBeenCalled();
  });

  test.each([
    ['email_verified false', { email_verified: false }],
    ['email_verified as string', { email_verified: 'true' }],
    ['missing email', { email: undefined }]
  ])('refuses an unverified email (%s)', async (_label, overrides) => {
    mockVerify(payload(overrides));
    await expect(googleService.loginWithGoogle('id-token')).rejects.toThrow(UnauthorizedException);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  test('refuses an invalid token or wrong audience with 401', async () => {
    verifySpy.mockRejectedValue(new Error('Wrong recipient, payload audience != requiredAudience'));
    await expect(googleService.loginWithGoogle('junk')).rejects.toThrow(UnauthorizedException);

    mockVerify(payload({ aud: 'someone-else.apps.googleusercontent.com' }));
    await expect(googleService.loginWithGoogle('id-token')).rejects.toThrow(UnauthorizedException);

    mockVerify(payload({ iss: 'https://evil.example.com' }));
    await expect(googleService.loginWithGoogle('id-token')).rejects.toThrow(UnauthorizedException);

    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockPrisma.session.create).not.toHaveBeenCalled();
  });

  test('accepts the bare accounts.google.com issuer', async () => {
    mockVerify(payload({ iss: 'accounts.google.com' }));
    await expect(googleService.loginWithGoogle('id-token')).resolves.toHaveProperty('user');
  });

  test('rejects a missing or malformed credential body with 400 before verifying', async () => {
    const res = { cookie: jest.fn() };
    await expect(controller.googleLogin({}, '1.1.1.1', 'jest', res)).rejects.toThrow(BadRequestException);
    await expect(controller.googleLogin({ credential: 42 }, '1.1.1.1', 'jest', res)).rejects.toThrow(BadRequestException);
    await expect(controller.googleLogin({ credential: 'x'.repeat(9000) }, '1.1.1.1', 'jest', res)).rejects.toThrow(BadRequestException);
    expect(verifySpy).not.toHaveBeenCalled();
  });

  test('is disabled when GOOGLE_CLIENT_ID is unset: config enabled=false and /auth/google 404', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    expect(controller.getGoogleConfig()).toEqual({ enabled: false });
    await expect(
      controller.googleLogin({ credential: 'id-token' }, '1.1.1.1', 'jest', { cookie: jest.fn() })
    ).rejects.toThrow(NotFoundException);
    expect(verifySpy).not.toHaveBeenCalled();

    process.env.GOOGLE_CLIENT_ID = `  ${CLIENT_ID}  `;
    expect(controller.getGoogleConfig()).toEqual({ enabled: true, clientId: CLIENT_ID });
  });

  test('enforces GOOGLE_ALLOWED_HOSTED_DOMAINS against the hd claim', async () => {
    process.env.GOOGLE_ALLOWED_HOSTED_DOMAINS = 'galgotiasuniversity.edu.in, example.org';

    mockVerify(payload()); // consumer account: no hd claim
    await expect(googleService.loginWithGoogle('id-token')).rejects.toThrow(ForbiddenException);

    mockVerify(payload({ hd: 'other.edu' }));
    await expect(googleService.loginWithGoogle('id-token')).rejects.toThrow(ForbiddenException);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();

    mockVerify(payload({ hd: 'Example.org' }));
    await expect(googleService.loginWithGoogle('id-token')).resolves.toHaveProperty('user');
  });

  test('routes are public, CSRF-guarded and rate-limited like login', () => {
    const handler = AuthController.prototype.googleLogin;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
    const guards = Reflect.getMetadata(GUARDS_METADATA, handler);
    expect(guards).toEqual(expect.arrayContaining([CsrfGuard, AccountIpRateLimiterGuard]));
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AuthController.prototype.getGoogleConfig)).toBe(true);
  });
});

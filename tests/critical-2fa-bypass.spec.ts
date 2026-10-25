import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { JwtStrategy } from '../apps/api/src/auth/jwt.strategy';
import { TwoFactorService } from '../apps/api/src/auth/two-factor.service';

/**
 * Regression tests for two critical 2FA bypasses:
 *  1. 2FA challenge tokens (issued after password-only login) were accepted as access tokens.
 *  2. /auth/2fa/generate and /auth/2fa/enable accepted a raw userId, letting anyone reset
 *     another user's 2FA secret without authenticating.
 */
describe('Critical: 2FA challenge token & enrolment bypass', () => {
  const JWT_SECRET = 'critical_2fa_regression_test_secret_value_32+';
  const USER_ID = '3f1c2a9e-7b4d-4e8f-9a1b-2c3d4e5f6a7b';

  let jwtService: JwtService;
  let mockPrisma: any;
  let authService: AuthService;

  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    delete process.env.JWT_ADMIN_SECRET;
    jwtService = new JwtService({ secret: JWT_SECRET, signOptions: { expiresIn: '10m' } });
    mockPrisma = {
      user: { findUnique: jest.fn() },
      twoFactor: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
      session: { findUnique: jest.fn(), create: jest.fn() },
      $transaction: jest.fn()
    };
    authService = new AuthService(mockPrisma, jwtService, new TwoFactorService());
  });

  const issueEnrolmentChallenge = (): string =>
    (authService as any).signChallengeToken(USER_ID, '2fa_enrolment_challenge', '15m');

  describe('Challenge tokens cannot be used as access tokens', () => {
    test('a challenge token does not verify with the public access-token secret', () => {
      const challenge = issueEnrolmentChallenge();
      expect(() => jwtService.verify(challenge, { secret: JWT_SECRET })).toThrow();
    });

    test('JwtStrategy rejects tokens with a type claim, no session id, or an unknown audience', async () => {
      const strategy = new JwtStrategy(mockPrisma);
      const req = { originalUrl: '/api/registrations' };

      await expect(
        strategy.validate(req, { sub: USER_ID, type: '2fa_enrolment_challenge' } as any)
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        strategy.validate(req, { sub: USER_ID, aud: 'gcdis-admin' } as any)
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        strategy.validate(req, { sub: USER_ID, aud: 'gcdis-2fa-challenge', sid: 's1' } as any)
      ).rejects.toThrow(UnauthorizedException);
      expect(mockPrisma.session.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    test('JwtStrategy rejects a session that belongs to a different user', async () => {
      const strategy = new JwtStrategy(mockPrisma);
      mockPrisma.session.findUnique.mockResolvedValue({
        userId: 'someone-else',
        isActive: true,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        user: { id: 'someone-else', isActive: true }
      });
      await expect(
        strategy.validate({ originalUrl: '/x' }, { sub: USER_ID, aud: 'gcdis-public', sid: 's1' } as any)
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('2FA enrolment endpoints require a valid enrolment challenge token', () => {
    test('generate2faSecret rejects a raw userId and never touches the 2FA record', async () => {
      await expect(authService.generate2faSecret(USER_ID)).rejects.toThrow(UnauthorizedException);
      expect(mockPrisma.twoFactor.upsert).not.toHaveBeenCalled();
    });

    test('enable2fa rejects a raw userId', async () => {
      await expect(authService.enable2fa(USER_ID, '123456')).rejects.toThrow(UnauthorizedException);
      expect(mockPrisma.twoFactor.update).not.toHaveBeenCalled();
    });

    test('generate2faSecret rejects an ordinary access token signed with JWT_SECRET', async () => {
      const accessLike = jwtService.sign({ sub: USER_ID, aud: 'gcdis-public', sid: 's1' });
      await expect(authService.generate2faSecret(accessLike)).rejects.toThrow(UnauthorizedException);
      expect(mockPrisma.twoFactor.upsert).not.toHaveBeenCalled();
    });

    test('generate2faSecret rejects a login (non-enrolment) challenge token', async () => {
      const loginChallenge = (authService as any).signChallengeToken(USER_ID, '2fa_challenge', '5m');
      await expect(authService.generate2faSecret(loginChallenge)).rejects.toThrow(UnauthorizedException);
    });

    test('generate2faSecret refuses to overwrite an already-enabled 2FA secret', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: USER_ID,
        email: 'staff@gcdis.org',
        isActive: true,
        isTwoFactorEnabled: true,
        twoFactor: { isEnabled: true }
      });
      await expect(authService.generate2faSecret(issueEnrolmentChallenge())).rejects.toThrow(
        'already enabled'
      );
      expect(mockPrisma.twoFactor.upsert).not.toHaveBeenCalled();
    });

    test('generate2faSecret succeeds with a valid enrolment challenge for a user without 2FA', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: USER_ID,
        email: 'staff@gcdis.org',
        isActive: true,
        isTwoFactorEnabled: false,
        twoFactor: null
      });
      const result = await authService.generate2faSecret(issueEnrolmentChallenge());
      expect(result.secret).toMatch(/^[A-Z2-7]+$/);
      expect(mockPrisma.twoFactor.upsert).toHaveBeenCalledTimes(1);
      expect(mockPrisma.twoFactor.upsert.mock.calls[0][0].where.userId).toBe(USER_ID);
    });

    test('generate2faSecret reuses a pending key so a second sign-in does not invalidate the authenticator entry', async () => {
      const twoFactorService = new TwoFactorService();
      const pendingKey = twoFactorService.generateBase32Secret();
      mockPrisma.user.findUnique.mockResolvedValue({
        id: USER_ID,
        email: 'staff@gcdis.org',
        isActive: true,
        isTwoFactorEnabled: false,
        twoFactor: { isEnabled: false, secret: twoFactorService.encryptSecret(pendingKey) }
      });
      const result = await authService.generate2faSecret(issueEnrolmentChallenge());
      expect(result.secret).toBe(pendingKey);
      expect(result.otpAuthUrl).toContain(`secret=${pendingKey}`);
      expect(result.otpAuthUrl).toContain('otpauth://totp/GCDIS%3Astaff%40gcdis.org?');
      expect(mockPrisma.twoFactor.upsert).not.toHaveBeenCalled();
    });
  });
});

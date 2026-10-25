import * as fs from 'fs';
import * as path from 'path';
import { TwoFactorService } from '../apps/api/src/auth/two-factor.service';
import { RolesGuard } from '../apps/api/src/auth/roles.guard';
import { CsrfGuard } from '../apps/api/src/common/guards/csrf.guard';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@gcdis/shared';
import { ExecutionContext, ForbiddenException, UnauthorizedException, BadRequestException } from '@nestjs/common';

describe('Phase 2: Authentication, 2FA, Sessions & Infrastructure Hardening', () => {
  const rootDir = path.resolve(__dirname, '..');
  const mainTsPath = path.join(rootDir, 'apps', 'api', 'src', 'main.ts');
  const authControllerPath = path.join(rootDir, 'apps', 'api', 'src', 'auth', 'auth.controller.ts');
  const authServicePath = path.join(rootDir, 'apps', 'api', 'src', 'auth', 'auth.service.ts');

  describe('1. AuthController register() Bug Fix', () => {
    test('register() defines result and passes tokens to setAuthCookies without ReferenceError', () => {
      const code = fs.readFileSync(authControllerPath, 'utf-8');
      expect(code).toContain('const result = await this.authService.register(input, ip);');
      expect(code).toContain('this.setAuthCookies(res, result.accessToken, result.refreshToken');
    });
  });

  describe('2. TwoFactorService Engine & Replay Protection', () => {
    let twoFactorService: TwoFactorService;

    beforeEach(() => {
      twoFactorService = new TwoFactorService();
    });

    test('Base32 encoding and decoding operates accurately without data loss', () => {
      const raw = Buffer.from('GCDIS_CHAMPIONSHIP_TEST_KEY_2026', 'utf-8');
      const encoded = twoFactorService.encodeBase32(raw);
      expect(encoded).toMatch(/^[A-Z2-7]+$/);

      const decoded = twoFactorService.decodeBase32(encoded);
      expect(decoded.toString('utf-8')).toBe('GCDIS_CHAMPIONSHIP_TEST_KEY_2026');
    });

    test('AES-256-GCM encryption and decryption at rest with authenticated tags', () => {
      const secret = twoFactorService.generateBase32Secret();
      const encrypted = twoFactorService.encryptSecret(secret);

      // Must be formatted as iv:authTag:ciphertext
      const parts = encrypted.split(':');
      expect(parts.length).toBe(3);
      expect(parts[0].length).toBe(24); // 12-byte IV in hex
      expect(parts[1].length).toBe(32); // 16-byte auth tag in hex

      const decrypted = twoFactorService.decryptSecret(encrypted);
      expect(decrypted).toBe(secret);
    });

    test('TOTP verifies valid code for current time step', () => {
      const secret = twoFactorService.generateBase32Secret();
      const currentStep = Math.floor(Date.now() / 1000 / 30);
      const validCode = twoFactorService.computeTotp(secret, currentStep);

      const result = twoFactorService.verifyTotp(secret, validCode);
      expect(result.isValid).toBe(true);
      expect(result.matchedStep).toBe(currentStep);
    });

    test('TOTP strictly rejects wrong code', () => {
      const secret = twoFactorService.generateBase32Secret();
      const wrongCode = '000000';
      const result = twoFactorService.verifyTotp(secret, wrongCode);
      expect(result.isValid).toBe(false);
    });

    test('Replay Protection: rejects replaying same code or previous step', () => {
      const secret = twoFactorService.generateBase32Secret();
      const currentStep = Math.floor(Date.now() / 1000 / 30);
      const code = twoFactorService.computeTotp(secret, currentStep);

      // First verification succeeds
      const firstTry = twoFactorService.verifyTotp(secret, code, undefined);
      expect(firstTry.isValid).toBe(true);

      // Replaying with lastUsedStep set to currentStep MUST fail
      const replayedTry = twoFactorService.verifyTotp(secret, code, currentStep);
      expect(replayedTry.isValid).toBe(false);

      // Replaying an earlier step MUST fail
      const earlierStepCode = twoFactorService.computeTotp(secret, currentStep - 1);
      const earlierTry = twoFactorService.verifyTotp(secret, earlierStepCode, currentStep);
      expect(earlierTry.isValid).toBe(false);
    });

    test('Generates 10 single-use recovery codes with SHA-256 hashes', () => {
      const { plaintextCodes, hashedRecords } = twoFactorService.generateRecoveryCodes();
      expect(plaintextCodes.length).toBe(10);
      expect(hashedRecords.length).toBe(10);

      // Verify and consume the first code
      const testCode = plaintextCodes[0];
      const verifyResult = twoFactorService.verifyRecoveryCode(testCode, hashedRecords);
      expect(verifyResult.isValid).toBe(true);
      expect(verifyResult.updatedRecords?.[0].used).toBe(true);

      // Reusing the already-consumed code fails
      const reuseResult = twoFactorService.verifyRecoveryCode(testCode, verifyResult.updatedRecords!);
      expect(reuseResult.isValid).toBe(false);
    });

    test('Per-user rate limit enforces cooldown lockout after 5 failed 2FA attempts', async () => {
      const testUserId = 'test-user-rate-limit-123';
      await twoFactorService.clearUserAttempts(testUserId);

      for (let i = 0; i < 4; i++) {
        await twoFactorService.recordFailedAttempt(testUserId);
      }
      await expect(twoFactorService.checkUserRateLimit(testUserId)).resolves.toBeUndefined();

      // 5th failed attempt triggers lockout
      await twoFactorService.recordFailedAttempt(testUserId);
      await expect(twoFactorService.checkUserRateLimit(testUserId)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('3. Audience & Session Separation (Public vs Admin)', () => {
    let rolesGuard: RolesGuard;
    let reflector: Reflector;

    beforeEach(() => {
      reflector = new Reflector();
      rolesGuard = new RolesGuard(reflector);
    });

    const createMockContext = (user: any, requiredRoles: UserRole[]): ExecutionContext => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(requiredRoles);
      return {
        switchToHttp: () => ({
          getRequest: () => ({ user })
        }),
        getHandler: () => ({}),
        getClass: () => ({})
      } as any;
    };

    test('Admin route strictly rejects public tokens with gcdis-public audience', () => {
      const mockContext = createMockContext(
        { id: '1', role: UserRole.SUPER_ADMIN, aud: 'gcdis-public' },
        [UserRole.SUPER_ADMIN]
      );

      expect(() => rolesGuard.canActivate(mockContext)).toThrow(ForbiddenException);
    });

    test('Admin route allows valid token with gcdis-admin audience', () => {
      const mockContext = createMockContext(
        { id: '1', role: UserRole.SUPER_ADMIN, aud: 'gcdis-admin' },
        [UserRole.SUPER_ADMIN]
      );

      expect(rolesGuard.canActivate(mockContext)).toBe(true);
    });

    test('Public route rejects administrative token with gcdis-admin audience', () => {
      const mockContext = createMockContext(
        { id: '2', role: UserRole.TEAM_CAPTAIN, aud: 'gcdis-admin' },
        [UserRole.TEAM_CAPTAIN]
      );

      expect(() => rolesGuard.canActivate(mockContext)).toThrow(ForbiddenException);
    });
  });

  describe('4. Login Hardening, Dummy Bcrypt & Lockout Defences', () => {
    test('AuthService performs dummy bcrypt comparison for unknown users to prevent timing enumeration', () => {
      const code = fs.readFileSync(authServicePath, 'utf-8');
      expect(code).toContain('DUMMY_HASH');
      expect(code).toContain('await bcrypt.compare(input.password, DUMMY_HASH)');
    });

    test('Lockout check keys on email AND ipAddress to prevent cross-user lockout DoS', () => {
      const code = fs.readFileSync(authServicePath, 'utf-8');
      expect(code).toContain('failedAttempts');
      expect(code).toMatch(/where:\s*\{[\s\S]*email,[\s\S]*ipAddress,[\s\S]*successful:\s*false/);
    });

    test('Password policy enforces minimum 12 chars and dictionary breach checks', () => {
      const code = fs.readFileSync(authServicePath, 'utf-8');
      expect(code).toContain('validatePasswordPolicy');
      expect(code).toContain('password.length < 12');
      expect(code).toContain('BREACHED_PASSWORDS');
    });

    test('Server-side mustChangePassword blocks access to protected routes', () => {
      const jwtStrategyPath = path.join(rootDir, 'apps', 'api', 'src', 'auth', 'jwt.strategy.ts');
      const code = fs.readFileSync(jwtStrategyPath, 'utf-8');
      expect(code).toContain('PASSWORD_CHANGE_REQUIRED');
      expect(code).toContain('/auth/change-password');
    });
  });

  describe('5. CSRF Protection Guard', () => {
    let csrfGuard: CsrfGuard;

    beforeEach(() => {
      csrfGuard = new CsrfGuard();
    });

    const createMockContext = (method: string, headers: Record<string, string>): ExecutionContext => {
      return {
        switchToHttp: () => ({
          getRequest: () => ({
            method,
            headers,
            originalUrl: '/api/auth/register'
          })
        })
      } as any;
    };

    test('Safe GET requests bypass CSRF validation', () => {
      const ctx = createMockContext('GET', {});
      expect(csrfGuard.canActivate(ctx)).toBe(true);
    });

    test('State-changing POST with unauthorized Origin is strictly rejected', () => {
      const ctx = createMockContext('POST', {
        origin: 'https://malicious-attacker-site.com',
        'content-type': 'application/json'
      });
      expect(() => csrfGuard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    test('State-changing POST with authorized Origin and custom header succeeds', () => {
      const ctx = createMockContext('POST', {
        origin: 'http://localhost:3000',
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/json'
      });
      expect(csrfGuard.canActivate(ctx)).toBe(true);
    });
  });

  describe('6. Infrastructure & main.ts Security Hardening', () => {
    test('main.ts configures helmet, cookie-parser, trust proxy, body limits, exception filter, and graceful shutdown', () => {
      const code = fs.readFileSync(mainTsPath, 'utf-8');
      expect(code).toContain('helmet');
      expect(code).toContain('cookieParser');
      // trust proxy is configurable via TRUST_PROXY (QA L8); see tests/qa-fixes-api.spec.ts
      expect(code).toContain("set('trust proxy', resolveTrustProxy())");
      // JSON limit lowered to 1 MB (JSON_BODY_LIMIT); see tests/security-headers-hardening.spec.ts
      expect(code).toContain('express.json({ limit: JSON_BODY_LIMIT })');
      expect(code).toContain('GlobalExceptionFilter');
      expect(code).toContain('app.enableShutdownHooks()');
    });

    test('AccountIpRateLimiterGuard implements Redis-backed throttling using Express trust proxy IP', () => {
      const limiterPath = path.join(rootDir, 'apps', 'api', 'src', 'common', 'guards', 'rate-limiter.guard.ts');
      const code = fs.readFileSync(limiterPath, 'utf-8');
      expect(code).toContain('ioredis');
      expect(code).toContain('req.ip');
      expect(code).toContain('Retry-After');
      expect(code).toContain('ratelimit:');
    });
  });
});

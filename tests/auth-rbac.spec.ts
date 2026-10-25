import { ForbiddenException, UnauthorizedException, ConflictException } from '@nestjs/common';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { UserRole } from '@gcdis/shared';
import * as bcrypt from 'bcryptjs';

describe('Auth & RBAC Security Verification (Execution Engine)', () => {
  let authService: AuthService;
  let mockPrisma: any;
  let mockJwt: any;
  let mockAudit: any;
  let usersDb: Map<string, any>;
  let attemptsDb: any[];

  beforeEach(() => {
    usersDb = new Map();
    attemptsDb = [];

    mockAudit = {
      logAction: jest.fn().mockResolvedValue({})
    };

    mockJwt = {
      sign: jest.fn((payload) => `signed_jwt_${payload.sub}_${payload.role}`)
    };

    mockPrisma = {
      user: {
        findUnique: jest.fn(async ({ where }) => {
          if (where.email) {
            for (const u of usersDb.values()) {
              if (u.email === where.email.toLowerCase()) return u;
            }
            return null;
          }
          return usersDb.get(where.id) || null;
        }),
        create: jest.fn(async ({ data }) => {
          const user = { id: `usr-${usersDb.size + 1}`, ...data, createdAt: new Date() };
          usersDb.set(user.id, user);
          return user;
        }),
        findMany: jest.fn(async () => Array.from(usersDb.values()))
      },
      session: {
        create: jest.fn(async ({ data }) => ({ id: `sess-1`, ...data })),
        findUnique: jest.fn().mockResolvedValue(null)
      },
      loginAttempt: {
        create: jest.fn(async ({ data }) => {
          attemptsDb.push({ ...data, attemptedAt: new Date() });
          return data;
        }),
        count: jest.fn(async ({ where }) => {
          return attemptsDb.filter(
            (a) =>
              (!where.email || a.email === where.email) &&
              (!where.ipAddress || a.ipAddress === where.ipAddress) &&
              (!where.successful === !a.successful)
          ).length;
        })
      }
    };

    authService = new AuthService(mockPrisma as any, mockJwt as any, mockAudit as any);
  });

  test('1. Public registration creates TEAM_CAPTAIN and returns sanitized user without passwordHash', async () => {
    const regResult = await authService.register(
      {
        email: 'captain@nitk.edu.in',
        password: 'ValidSecurePassword123!',
        fullName: 'Captain Neha',
        role: UserRole.TEAM_CAPTAIN,
        phone: '+919876543210'
      },
      '127.0.0.1'
    );

    expect(regResult.accessToken).toBeDefined();
    expect(regResult.user.email).toBe('captain@nitk.edu.in');
    expect(regResult.user.role).toBe(UserRole.TEAM_CAPTAIN);
    expect((regResult.user as any).passwordHash).toBeUndefined();
  });

  test('2. Duplicate registration throws ConflictException', async () => {
    await authService.register(
      {
        email: 'captain@nitk.edu.in',
        password: 'ValidSecurePassword123!',
        fullName: 'Captain Neha',
        role: UserRole.TEAM_CAPTAIN
      },
      '127.0.0.1'
    );

    await expect(
      authService.register(
        {
          email: 'captain@nitk.edu.in',
          password: 'AnotherPassword123!',
          fullName: 'Duplicate',
          role: UserRole.TEAM_CAPTAIN
        },
        '127.0.0.1'
      )
    ).rejects.toThrow(ConflictException);
  });

  test('3. Staff account creation requires SUPER_ADMIN caller role', async () => {
    // Seed non-admin user
    usersDb.set('u-1', { id: 'u-1', email: 'judge@gcdis.org', role: UserRole.JUDGE });

    await expect(
      authService.createStaffUser(
        'u-1',
        {
          email: 'new.judge@gcdis.org',
          fullName: 'New Technical Judge',
          role: UserRole.JUDGE as any
        },
        '127.0.0.1'
      )
    ).rejects.toThrow(ForbiddenException);

    // Seed super admin user
    usersDb.set('sa-1', { id: 'sa-1', email: 'director@gcdis.org', role: UserRole.SUPER_ADMIN });

    const staffRes = await authService.createStaffUser(
      'sa-1',
      {
        email: 'new.judge@gcdis.org',
        fullName: 'New Technical Judge',
        role: UserRole.JUDGE as any
      },
      '127.0.0.1'
    );

    expect(staffRes.user.email).toBe('new.judge@gcdis.org');
    expect(staffRes.tempPassword).toBeDefined();
  });

  test('4. Brute force protection locks account after 5 consecutive failed attempts', async () => {
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash('CorrectPassword123!', salt);
    await mockPrisma.user.create({
      data: {
        email: 'target@gcdis.org',
        passwordHash: hash,
        role: UserRole.TEAM_CAPTAIN,
        isActive: true
      }
    });

    // 4 failed attempts
    for (let i = 0; i < 4; i++) {
      await expect(
        authService.login({ email: 'target@gcdis.org', password: 'WrongPassword!' }, '10.0.0.1')
      ).rejects.toThrow(UnauthorizedException);
    }

    // 5th failed attempt
    await expect(
      authService.login({ email: 'target@gcdis.org', password: 'WrongPassword!' }, '10.0.0.1')
    ).rejects.toThrow(UnauthorizedException);

    // 6th attempt should be blocked by lockout policy
    await expect(
      authService.login({ email: 'target@gcdis.org', password: 'CorrectPassword123!' }, '10.0.0.1')
    ).rejects.toThrow(ForbiddenException);
  });
});

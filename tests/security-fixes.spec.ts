import { BadRequestException, ExecutionContext, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { sanitizeRichText, sanitizeUrl, deepSanitizeContent } from '../apps/api/src/common/utils/cms-sanitizer.util';
import { CsrfGuard, buildAllowedOrigins } from '../apps/api/src/common/guards/csrf.guard';
import { JwtStrategy, isPasswordChangeAllowedPath } from '../apps/api/src/auth/jwt.strategy';
import { TeamsService } from '../apps/api/src/teams/teams.service';
import { CMSService } from '../apps/api/src/cms/cms.service';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { TwoFactorService } from '../apps/api/src/auth/two-factor.service';
import { getAdminJwtSecret } from '../apps/api/src/auth/jwt-secrets';
import { toPrismaPagination } from '../apps/api/src/common/dto/pagination-query.dto';

const JWT_SECRET = 'security_fixes_regression_test_secret_value_32+';

describe('Security fixes regression suite', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    delete process.env.JWT_ADMIN_SECRET;
    delete process.env.PUBLIC_SITE_URL;
    delete process.env.ADMIN_SITE_URL;
    delete process.env.PUBLIC_ORIGIN;
    delete process.env.ADMIN_ORIGIN;
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  describe('1. Rich text sanitizer (sanitize-html allow-list)', () => {
    test.each([
      '<img/src=x/onerror=alert(1)>',
      '<img src=x onerror=alert(1)//',
      '<svg/onload=alert(1)>',
      '<a href="&#106;avascript:alert(1)">x</a>',
      '<a href="jav&#x09;ascript:alert(1)">x</a>',
      '<a href="  JaVaScRiPt:alert(1)">x</a>',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      '<p style="background:url(javascript:alert(1))" onclick="x()">t</p>',
      '<scr<script>ipt>alert(1)</script>',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>'
    ])('neutralises %s', (payload) => {
      const clean = sanitizeRichText(payload).toLowerCase();
      // No event-handler attribute may survive (text inside a quoted attribute value is inert)
      expect(clean).not.toMatch(/<[^>]*\son[a-z]+\s*=/);
      expect(clean).not.toContain('javascript:');
      expect(clean).not.toContain('<script');
      expect(clean).not.toContain('<svg');
      expect(clean).not.toContain('<iframe');
      expect(clean).not.toContain('style=');
    });

    test('keeps allowed formatting and safe links', () => {
      expect(sanitizeRichText('<p>Hi <strong>there</strong></p>')).toBe('<p>Hi <strong>there</strong></p>');
      expect(sanitizeRichText('<a href="https://gcdis.org">x</a>')).toBe('<a href="https://gcdis.org">x</a>');
      expect(sanitizeRichText('<a href="mailto:info@gcdis.org">m</a>')).toContain('mailto:info@gcdis.org');
    });

    test('plain text without markup is left untouched (no double encoding)', () => {
      expect(sanitizeRichText('Tom & Jerry • 2026')).toBe('Tom & Jerry • 2026');
    });

    test('URL sanitizer allows only http(s), mailto and same-origin relative paths', () => {
      expect(sanitizeUrl('mailto:info@gcdis.org')).toBe('mailto:info@gcdis.org');
      expect(sanitizeUrl('/rules.pdf')).toBe('/rules.pdf');
      expect(() => sanitizeUrl('//evil.com/x')).toThrow(BadRequestException);
      expect(() => sanitizeUrl('/\\evil.com')).toThrow(BadRequestException);
      expect(() => sanitizeUrl('java\tscript:alert(1)')).toThrow(BadRequestException);
      expect(() => sanitizeUrl('javascript:alert(1)')).toThrow(BadRequestException);
    });

    test('deepSanitizeContent drops prototype-pollution keys', () => {
      const out = deepSanitizeContent(JSON.parse('{"__proto__":{"polluted":true},"a":"<img src=x onerror=1>"}'));
      expect(({} as any).polluted).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
      expect(out.a).not.toContain('onerror');
    });
  });

  describe('2. CSRF guard exact origin matching', () => {
    const ctx = (headers: Record<string, string>, url = '/api/cms/admin/section/hero/draft'): ExecutionContext =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ method: 'POST', headers, originalUrl: url }) })
      }) as any;

    test('rejects look-alike origins that merely start with an allowed origin', () => {
      process.env.PUBLIC_SITE_URL = 'https://site.com';
      const guard = new CsrfGuard();
      expect(() => guard.canActivate(ctx({ origin: 'https://site.com.evil.com', 'content-type': 'application/json' }))).toThrow(ForbiddenException);
      expect(() => guard.canActivate(ctx({ origin: 'https://site.com:8443', 'content-type': 'application/json' }))).toThrow(ForbiddenException);
      expect(() => guard.canActivate(ctx({ origin: 'http://localhost:30001', 'content-type': 'application/json' }))).toThrow(ForbiddenException);
      expect(() => guard.canActivate(ctx({ referer: 'https://site.com.evil.com/page', 'content-type': 'application/json' }))).toThrow(ForbiddenException);
      expect(guard.canActivate(ctx({ origin: 'https://site.com', 'content-type': 'application/json' }))).toBe(true);
      expect(guard.canActivate(ctx({ referer: 'https://site.com/admin?x=1', 'content-type': 'application/json' }))).toBe(true);
    });

    test('localhost origins are only trusted outside production', () => {
      expect(buildAllowedOrigins({ NODE_ENV: 'development' } as any).has('http://localhost:3000')).toBe(true);
      const prod = buildAllowedOrigins({ NODE_ENV: 'production', PUBLIC_SITE_URL: 'https://gcdis.in' } as any);
      expect(prod.has('http://localhost:3000')).toBe(false);
      expect(prod.has('https://gcdis.in')).toBe(true);

      process.env.NODE_ENV = 'production';
      process.env.PUBLIC_SITE_URL = 'https://gcdis.in';
      const guard = new CsrfGuard();
      expect(() => guard.canActivate(ctx({ origin: 'http://localhost:3000', 'content-type': 'application/json' }))).toThrow(ForbiddenException);
    });

    test('webhook exemption matches the pathname, not the query string', () => {
      const guard = new CsrfGuard();
      expect(() =>
        guard.canActivate(ctx({ origin: 'https://evil.com' }, '/api/cms/admin/section/hero/draft?next=/payments/webhook'))
      ).toThrow(ForbiddenException);
      expect(guard.canActivate(ctx({}, '/api/payments/webhook'))).toBe(true);
    });
  });

  describe('4. mustChangePassword allow-list compares exact pathnames', () => {
    test('path helper', () => {
      expect(isPasswordChangeAllowedPath('/api/auth/change-password')).toBe(true);
      expect(isPasswordChangeAllowedPath('/api/auth/me?x=1')).toBe(true);
      expect(isPasswordChangeAllowedPath('/auth/logout')).toBe(true);
      expect(isPasswordChangeAllowedPath('/api/teams?x=/auth/me')).toBe(false);
      expect(isPasswordChangeAllowedPath('/api/registrations/auth/me')).toBe(false);
      expect(isPasswordChangeAllowedPath('/api/auth/meeting')).toBe(false);
      expect(isPasswordChangeAllowedPath('/api/auth/me%2F..%2F..%2Fusers')).toBe(false);
    });

    test('JwtStrategy blocks a query-string bypass for users who must change password', async () => {
      const prisma: any = {
        session: {
          findUnique: jest.fn().mockResolvedValue({
            userId: 'u1',
            isActive: true,
            revokedAt: null,
            expiresAt: new Date(Date.now() + 60_000),
            user: { id: 'u1', isActive: true, mustChangePassword: true, role: 'EVENT_ADMIN', email: 'a@b.c' }
          })
        }
      };
      const strategy = new JwtStrategy(prisma);
      const payload: any = { sub: 'u1', aud: 'gcdis-admin', sid: 's1' };
      await expect(strategy.validate({ originalUrl: '/api/registrations?x=/auth/me' }, payload)).rejects.toThrow(ForbiddenException);
      await expect(strategy.validate({ originalUrl: '/api/auth/me' }, payload)).resolves.toMatchObject({ id: 'u1' });
    });
  });

  describe('5. Admin JWT secret', () => {
    test('production requires a dedicated JWT_ADMIN_SECRET', () => {
      process.env.NODE_ENV = 'production';
      expect(() => getAdminJwtSecret()).toThrow(/JWT_ADMIN_SECRET/);
      process.env.JWT_ADMIN_SECRET = 'short';
      expect(() => getAdminJwtSecret()).toThrow(/JWT_ADMIN_SECRET/);
      process.env.JWT_ADMIN_SECRET = 'x'.repeat(40);
      expect(getAdminJwtSecret()).toBe('x'.repeat(40));
      expect(() => new JwtStrategy({} as any)).not.toThrow();
    });

    test('development keeps the derived fallback', () => {
      expect(getAdminJwtSecret()).toBe(JWT_SECRET + '_admin_secret_key_override_32');
    });
  });

  describe('7. Request validation (missing 2FA fields never 500)', () => {
    test('verify2faLogin without code is a 400, without token a 401', async () => {
      const jwtService = new JwtService({ secret: JWT_SECRET });
      const auth = new AuthService({} as any, jwtService, new TwoFactorService());
      const challenge = (auth as any).signChallengeToken('u1', '2fa_challenge', '5m');
      await expect(auth.verify2faLogin(challenge, undefined as any)).rejects.toThrow(BadRequestException);
      await expect(auth.verify2faLogin(undefined as any, '123456')).rejects.toThrow(UnauthorizedException);
    });

    test('recovery-code verification tolerates missing input', () => {
      expect(new TwoFactorService().verifyRecoveryCode(undefined as any, []).isValid).toBe(false);
    });

    test('updatePrize rejects non-whitelisted fields before touching Prisma', async () => {
      const prisma: any = { prize: { findUnique: jest.fn(), update: jest.fn() } };
      const cms = new CMSService(prisma, { logAction: jest.fn() } as any);
      await expect(cms.updatePrize('p1', { amount: 10, id: 'other', createdAt: 'x' } as any)).rejects.toThrow(BadRequestException);
      await expect(cms.updatePrize('p1', { amount: '10' } as any)).rejects.toThrow(BadRequestException);
      expect(prisma.prize.update).not.toHaveBeenCalled();
    });
  });

  describe('8. CMS drafts never change live content', () => {
    test('public read serves the latest published snapshot, not the draft working copy', async () => {
      const section: any = {
        id: 'sec-1',
        key: 'hero',
        title: 'DRAFT TITLE',
        subtitle: 'draft sub',
        data: { headline: 'draft' },
        isPublished: true,
        publishedAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-02-01T00:00:00Z'),
        versions: [{ versionNumber: 3, title: 'LIVE TITLE', data: { headline: 'live' }, createdAt: new Date('2026-01-01T00:00:00Z') }]
      };
      const prisma: any = { contentSection: { findUnique: jest.fn().mockResolvedValue(section) } };
      const cms = new CMSService(prisma, { logAction: jest.fn() } as any);
      const res: any = await cms.getPublicSection('hero');
      expect(res.title).toBe('LIVE TITLE');
      expect(res.data).toEqual({ headline: 'live' });
      expect(res.subtitle).toBeNull();
      expect(res.versions).toBeUndefined();
    });

    test('first draft on a legacy live section snapshots live content, new sections start unpublished', async () => {
      const prisma: any = {
        contentSection: {
          findUnique: jest.fn().mockResolvedValue({ id: 'sec-1', key: 'hero', title: 'LIVE', data: { a: 1 }, isPublished: true, versions: [] }),
          upsert: jest.fn().mockImplementation(async ({ update }) => ({ id: 'sec-1', ...update }))
        },
        contentVersion: { create: jest.fn().mockResolvedValue({}) }
      };
      const cms = new CMSService(prisma, { logAction: jest.fn() } as any);
      await cms.saveSectionDraft('hero', { a: 2 }, 'NEW', undefined, 'admin', 'a@b.c');
      expect(prisma.contentVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ versionNumber: 1, title: 'LIVE', data: { a: 1 } }) })
      );
      const upsertArgs = prisma.contentSection.upsert.mock.calls[0][0];
      expect(upsertArgs.create.isPublished).toBe(false);
    });
  });

  describe('9. Public team detail', () => {
    const fullTeam = {
      id: 'team-1',
      captainId: 'captain-user-1',
      isApprovedPublic: true,
      name: 'FALCONS',
      members: [{ id: 'm1', fullName: 'A', memberRole: 'PILOT', status: 'PENDING' }],
      captain: { id: 'captain-user-1', fullName: 'Cap', organization: 'Org' }
    };

    test('does not expose captain user IDs to the public', async () => {
      const prisma: any = { team: { findUnique: jest.fn().mockResolvedValue({ ...fullTeam }) } };
      const res: any = await new TeamsService(prisma).findById('team-1');
      expect(res.captainId).toBeUndefined();
      expect(res.captain.id).toBeUndefined();
      expect(JSON.stringify(res)).not.toContain('captain-user-1');
    });

    test('unapproved teams are hidden from the public but visible to owner and staff', async () => {
      const unapproved = { ...fullTeam, isApprovedPublic: false };
      const prisma: any = { team: { findUnique: jest.fn().mockResolvedValue(unapproved) } };
      const svc = new TeamsService(prisma);
      await expect(svc.findById('team-1')).rejects.toThrow(NotFoundException);
      await expect(svc.findById('team-1', { id: 'someone', role: 'TEAM_CAPTAIN', aud: 'gcdis-public' })).rejects.toThrow(NotFoundException);
      await expect(svc.findById('team-1', { id: 'captain-user-1', role: 'TEAM_CAPTAIN', aud: 'gcdis-public' })).resolves.toBeDefined();
      await expect(svc.findById('team-1', { id: 'admin', role: 'EVENT_ADMIN', aud: 'gcdis-admin' })).resolves.toBeDefined();
    });

    test('public team listings strip captainId', async () => {
      const prisma: any = { team: { findMany: jest.fn().mockResolvedValue([{ ...fullTeam }]) } };
      const svc = new TeamsService(prisma);
      const list: any[] = await svc.findPublicTeams();
      expect(list[0].captainId).toBeUndefined();
      expect(prisma.team.findMany.mock.calls[0][0].take).toBeLessThanOrEqual(100);
    });

    test('ID proofs must be private uploads by the same captain', async () => {
      const prisma: any = {
        team: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
        category: { findUnique: jest.fn().mockResolvedValue({ id: 'cat-1' }) },
        mediaAsset: { findFirst: jest.fn().mockResolvedValue(null) }
      };
      const svc = new TeamsService(prisma);
      const base = { categoryId: 'cat-1', teamName: 'X', members: [{ fullName: 'A', idProofUrl: 'https://evil.com/a.pdf' }] };
      await expect(svc.createTeam('cap-1', base)).rejects.toThrow(BadRequestException);
      await expect(
        svc.createTeam('cap-1', { ...base, members: [{ fullName: 'A', idProofUrl: '/api/uploads/files/abc.pdf' }] })
      ).rejects.toThrow(BadRequestException);
      expect(prisma.mediaAsset.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { fileUrl: '/api/uploads/files/abc.pdf', uploadedBy: 'cap-1' } })
      );
      expect(prisma.team.create).not.toHaveBeenCalled();
    });
  });

  describe('10. Pagination clamp', () => {
    test('limits are clamped to the max page size', () => {
      expect(toPrismaPagination({ limit: 100000, offset: -5 })).toEqual({ take: 100, skip: 0 });
      expect(toPrismaPagination({ limit: 'abc' })).toEqual({ take: 50, skip: 0 });
    });
  });

  describe('3. 2FA attempt tracker is pruned', () => {
    test('expired entries are removed', async () => {
      const svc = new TwoFactorService();
      const realNow = Date.now;
      try {
        const start = realNow();
        Date.now = () => start;
        await svc.recordFailedAttempt('prune-user');
        const before = TwoFactorService.trackedAttemptCount();
        Date.now = () => start + 60 * 60 * 1000;
        await svc.checkUserRateLimit('another-user');
        expect(TwoFactorService.trackedAttemptCount()).toBeLessThan(before);
      } finally {
        Date.now = realNow;
      }
    });
  });
});

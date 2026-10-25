import * as fs from 'fs';
import * as path from 'path';
import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { UserRole } from '@gcdis/shared';
import { GlobalExceptionFilter } from '../apps/api/src/common/filters/global-exception.filter';
import { rejectNullBytes, urlContainsNullByte } from '../apps/api/src/common/middleware/null-byte.middleware';
import { resolveTrustProxy } from '../apps/api/src/common/utils/trust-proxy.util';
import { sanitizeHeroTextFields, HERO_TEXT_LIMITS } from '../apps/api/src/common/utils/cms-sanitizer.util';
import { toPrismaPagination } from '../apps/api/src/common/dto/pagination-query.dto';
import { AudienceRolesGuard, AUDIENCE_ROLES_KEY } from '../apps/api/src/auth/audience-roles.guard';
import { RolesGuard } from '../apps/api/src/auth/roles.guard';
import { ROLES_KEY } from '../apps/api/src/auth/roles.decorator';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { AuthController } from '../apps/api/src/auth/auth.controller';
import { AppController } from '../apps/api/src/app.controller';
import { PaymentsController } from '../apps/api/src/payments/payments.controller';
import { UploadsController } from '../apps/api/src/uploads/uploads.controller';
import { CsrfGuard } from '../apps/api/src/common/guards/csrf.guard';

function runFilter(exception: unknown) {
  const filter = new GlobalExceptionFilter();
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host: any = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url: '/api/test', headers: { 'x-request-id': 'req_test' } })
    })
  };
  (filter as any).logger = { error: jest.fn(), warn: jest.fn() };
  filter.catch(exception, host);
  return { code: (status.mock.calls[0] as any[])[0] as number, body: (json.mock.calls[0] as any[])[0] as any };
}

function httpContext(user: any, handler: any, cls: any = class {}): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => ({ user }) })
  } as any;
}

describe('QA fixes (API): M1 / L1 global exception filter', () => {
  test('PrismaClientValidationError maps to 400 "Invalid request parameters" without a stack', () => {
    const err = new Prisma.PrismaClientValidationError('Invalid `prisma.team.findUnique()` invocation in C:\\x\\teams.service.ts', {
      clientVersion: '5.22.0'
    });
    const { code, body } = runFilter(err);
    expect(code).toBe(400);
    expect(body.message).toBe('Invalid request parameters');
    expect(body.stack).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('teams.service.ts');
  });

  test('unhandled errors never include a stack, in any environment', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const { code, body } = runFilter(new Error('boom at C:\\secret\\path.ts'));
      expect(code).toBe(500);
      expect(body.stack).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('secret');
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  test('HttpExceptions keep their status', () => {
    expect(runFilter(new NotFoundException('nope')).code).toBe(404);
  });

  test('body-parser errors: entity.too.large -> 413, entity.parse.failed -> 400', () => {
    const tooLarge: any = Object.assign(new Error('request entity too large'), { type: 'entity.too.large', status: 413 });
    expect(runFilter(tooLarge).code).toBe(413);
    const badJson: any = Object.assign(new Error('Unexpected token'), { type: 'entity.parse.failed', status: 400 });
    const res = runFilter(badJson);
    expect(res.code).toBe(400);
    expect(res.body.message).toBe('Malformed JSON request body.');
  });

  test('main.ts registers the body-parser error middleware and the NUL-byte guard', () => {
    const code = fs.readFileSync(path.join(__dirname, '../apps/api/src/main.ts'), 'utf-8');
    expect(code).toContain('app.use(rejectNullBytes)');
    expect(code).toContain('app.use(bodyParserErrorHandler)');
    expect(code).toContain("entity.too.large");
  });
});

describe('QA fixes (API): M1 NUL-byte middleware', () => {
  test('detects encoded, raw and double-encoded NUL bytes in path and query', () => {
    expect(urlContainsNullByte('/api/teams/%00')).toBe(true);
    expect(urlContainsNullByte('/api/events?x=a%00b')).toBe(true);
    expect(urlContainsNullByte('/api/events/%2500')).toBe(true);
    expect(urlContainsNullByte('/api/events/%E0%A4%A')).toBe(false);
    expect(urlContainsNullByte('/api/events/drone-soccer?page=2')).toBe(false);
  });

  test('responds 400 and does not call next()', () => {
    const json = jest.fn();
    const res: any = { status: jest.fn(() => ({ json })) };
    const next = jest.fn();
    rejectNullBytes({ originalUrl: '/api/teams/%00', headers: {}, query: {} } as any, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();

    const next2 = jest.fn();
    rejectNullBytes({ originalUrl: '/api/teams', headers: {}, query: { q: 'ok' } } as any, res, next2);
    expect(next2).toHaveBeenCalled();
  });
});

describe('QA fixes (API): L2 captain-only routes and M8 CSRF', () => {
  const reflector = new Reflector();

  test('create-order and verify-signature require TEAM_CAPTAIN and reject admin sessions', () => {
    for (const handler of [PaymentsController.prototype.createOrder, PaymentsController.prototype.verifyPaymentSignature]) {
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.TEAM_CAPTAIN]);
      const guard = new RolesGuard(reflector);
      expect(() => guard.canActivate(httpContext({ role: UserRole.SUPER_ADMIN, aud: 'gcdis-admin' }, handler))).toThrow();
      expect(guard.canActivate(httpContext({ role: UserRole.TEAM_CAPTAIN, aud: 'gcdis-public' }, handler))).toBe(true);
    }
  });

  test('uploads accept captains (public) and content admins (admin) but not judges or admin tokens on a public role', () => {
    const handler = UploadsController.prototype.uploadFileStream;
    const guard = new AudienceRolesGuard(reflector);
    expect(Reflect.getMetadata(AUDIENCE_ROLES_KEY, handler)).toBeDefined();
    expect(guard.canActivate(httpContext({ role: UserRole.TEAM_CAPTAIN, aud: 'gcdis-public' }, handler))).toBe(true);
    expect(guard.canActivate(httpContext({ role: UserRole.EVENT_ADMIN, aud: 'gcdis-admin' }, handler))).toBe(true);
    expect(() => guard.canActivate(httpContext({ role: UserRole.JUDGE, aud: 'gcdis-admin' }, handler))).toThrow();
    expect(() => guard.canActivate(httpContext({ role: UserRole.SUPER_ADMIN, aud: 'gcdis-public' }, handler))).toThrow();
  });

  test('signed URLs stay available to inspectors reviewing documents', () => {
    const guard = new AudienceRolesGuard(reflector);
    const handler = UploadsController.prototype.getSignedUrl;
    expect(guard.canActivate(httpContext({ role: UserRole.INSPECTOR, aud: 'gcdis-admin' }, handler))).toBe(true);
  });

  test('CsrfGuard is applied to state-changing payments and uploads routes, not the webhook', () => {
    const guardsOf = (fn: any) => (Reflect.getMetadata('__guards__', fn) || []) as any[];
    for (const fn of [
      PaymentsController.prototype.createOrder,
      PaymentsController.prototype.verifyPaymentSignature,
      PaymentsController.prototype.runReconciliation,
      PaymentsController.prototype.refundPayment,
      UploadsController.prototype.uploadFile,
      UploadsController.prototype.uploadFileStream
    ]) {
      expect(guardsOf(fn)).toContain(CsrfGuard);
    }
    expect(guardsOf(PaymentsController.prototype.handleWebhook)).not.toContain(CsrfGuard);
  });
});

describe('QA fixes (API): L4 / L5 / L7 auth', () => {
  function makeService(overrides: any = {}) {
    const prisma: any = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([{ id: 'u1', email: 'a@b.c', role: 'JUDGE', passwordHash: 'x' }]),
        count: jest.fn().mockResolvedValue(7)
      },
      session: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
      ...overrides
    };
    const audit = { logAction: jest.fn().mockResolvedValue({}) };
    const service = new AuthService(prisma, {} as any, {} as any, audit as any);
    return { service, prisma, audit };
  }

  test('duplicate registration returns 409 with the formal message', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ id: 'existing' });
    await expect(service.register({ email: 'X@Y.com' } as any)).rejects.toMatchObject({
      status: 409,
      message: 'An account with this email address already exists. Please sign in or reset your password.'
    });
  });

  test('logout-all writes AUTH_LOGOUT_ALL', async () => {
    const { service, audit } = makeService();
    await service.logoutAll('u1', { email: 'a@b.c', role: 'TEAM_CAPTAIN', ipAddress: '1.2.3.4' });
    expect(audit.logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'AUTH_LOGOUT_ALL', actorId: 'u1' }));
  });

  test('password change writes AUTH_PASSWORD_CHANGED', async () => {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('OldPassw0rd!xyz', 4);
    const { service, prisma, audit } = makeService();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.c', role: 'TEAM_CAPTAIN', passwordHash: hash });
    await service.changePassword('u1', 'OldPassw0rd!xyz', 'N3w-Strong-Passphrase!', '1.2.3.4', 'jest');
    expect(audit.logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AUTH_PASSWORD_CHANGED', actorId: 'u1', ipAddress: '1.2.3.4' })
    );
  });

  test('auth.service emits AUTH_2FA_ENABLED and AUTH_RECOVERY_CODE_USED', () => {
    const code = fs.readFileSync(path.join(__dirname, '../apps/api/src/auth/auth.service.ts'), 'utf-8');
    expect(code).toContain("auditAuthEvent('AUTH_2FA_ENABLED'");
    expect(code).toContain("auditAuthEvent('AUTH_RECOVERY_CODE_USED'");
  });

  test('GET /auth/users?scope=staff&withMeta=true filters to staff roles and returns { items, total, page, limit }', async () => {
    const { service, prisma } = makeService();
    const controller = new AuthController(service, {} as any);
    const result: any = await controller.getAllUsers({ scope: 'staff', withMeta: true, page: 3, limit: 20 } as any);
    expect(result).toEqual(expect.objectContaining({ total: 7, page: 3, limit: 20 }));
    expect(Array.isArray(result.items)).toBe(true);
    const args = prisma.user.findMany.mock.calls[0][0];
    expect(args.skip).toBe(40);
    expect(args.take).toBe(20);
    expect(args.where.role.in.sort()).toEqual(['EVENT_ADMIN', 'INSPECTOR', 'JUDGE', 'SUPER_ADMIN']);

    const bare: any = await controller.getAllUsers({} as any);
    expect(Array.isArray(bare)).toBe(true);
    expect(prisma.user.findMany.mock.calls[1][0].where).toBeUndefined();
  });

  test('toPrismaPagination supports page when no offset is given', () => {
    expect(toPrismaPagination({ page: 2, limit: 25 })).toEqual({ take: 25, skip: 25 });
    expect(toPrismaPagination({ page: 5, limit: 25, offset: 10 })).toEqual({ take: 25, skip: 10 });
  });
});

describe('QA fixes (API): L8 / L9 / M5', () => {
  test('TRUST_PROXY: default 1 in production, false in development, explicit values honoured', () => {
    expect(resolveTrustProxy({ NODE_ENV: 'production' } as any)).toBe(1);
    expect(resolveTrustProxy({ NODE_ENV: 'development' } as any)).toBe(false);
    expect(resolveTrustProxy({ NODE_ENV: 'production', TRUST_PROXY: 'false' } as any)).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: '2' } as any)).toBe(2);
    expect(resolveTrustProxy({ TRUST_PROXY: 'loopback, 10.0.0.0/8' } as any)).toBe('loopback, 10.0.0.0/8');
  });

  test('public /health exposes no node version or memory; details endpoint is SUPER_ADMIN only', async () => {
    const controller = new AppController({ $queryRaw: jest.fn().mockResolvedValue([1]) } as any);
    const health: any = await controller.getHealthStatus();
    expect(health).not.toHaveProperty('services');
    expect(health).not.toHaveProperty('uptimeSeconds');
    expect(Reflect.getMetadata(ROLES_KEY, AppController.prototype.getDetailedHealth)).toEqual([UserRole.SUPER_ADMIN]);
  });

  test('hero text fields are sanitised to plain text and length-limited', () => {
    const out = sanitizeHeroTextFields({
      focusX: 50,
      headline: '<b>Drone</b> <script>alert(1)</script>Soccer &amp; more',
      announcementBody: 'Line 1\nLine 2'
    });
    expect(out.headline).toBe('Drone Soccer & more');
    expect(out.announcementBody).toBe('Line 1\nLine 2');
    expect(out.focusX).toBe(50);
    expect(() => sanitizeHeroTextFields({ headline: 'x'.repeat(HERO_TEXT_LIMITS.headline + 1) })).toThrow(/at most 200/);
    expect(() => sanitizeHeroTextFields({ tagline: 42 as any })).toThrow(/must be a string/);
  });

  test('audit TRUNCATE guard migration exists', () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '../apps/api/prisma/migrations/20261011150000_audit_truncate_guard/migration.sql'),
      'utf-8'
    );
    expect(sql).toMatch(/BEFORE TRUNCATE ON audit_logs\s+FOR EACH STATEMENT/);
  });
});

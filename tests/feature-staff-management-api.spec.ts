import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { AuthController } from '../apps/api/src/auth/auth.controller';
import { TwoFactorService } from '../apps/api/src/auth/two-factor.service';
import { StepUpGuard } from '../apps/api/src/auth/step-up.guard';
import { RolesGuard } from '../apps/api/src/auth/roles.guard';
import { CsrfGuard } from '../apps/api/src/common/guards/csrf.guard';
import { SecurityAlertService } from '../apps/api/src/security/security-alert.service';

/**
 * Staff management (feature): PATCH /auth/users/:id/role and PATCH /auth/users/:id/status.
 * Super Administrator only, CSRF + step-up protected; self-protection, last Super Administrator
 * protection, participant/staff boundary, session revocation, audit entries and security alerts.
 */

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SA_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const CAPTAIN_ID = '44444444-4444-4444-8444-444444444444';
const JUDGE_ID = '55555555-5555-4555-8555-555555555555';
const MISSING_ID = '99999999-9999-4999-8999-999999999999';

interface FakeUser {
  id: string;
  email: string;
  fullName: string;
  role: string;
  isActive: boolean;
  passwordHash: string;
  emailVerifiedAt: Date | null;
  isTwoFactorEnabled: boolean;
}
interface FakeSession {
  id: string;
  userId: string;
  isActive: boolean;
  revokedAt: Date | null;
}

function buildFixture() {
  const users: FakeUser[] = [
    { id: ACTOR_ID, email: 'actor@example.test', fullName: 'Actor', role: 'SUPER_ADMIN', isActive: true, passwordHash: 'h', emailVerifiedAt: new Date(), isTwoFactorEnabled: true },
    { id: OTHER_SA_ID, email: 'other.sa@example.test', fullName: 'Other SA', role: 'SUPER_ADMIN', isActive: true, passwordHash: 'h', emailVerifiedAt: new Date(), isTwoFactorEnabled: true },
    { id: EVENT_ADMIN_ID, email: 'event@example.test', fullName: 'Event Admin', role: 'EVENT_ADMIN', isActive: true, passwordHash: 'h', emailVerifiedAt: new Date(), isTwoFactorEnabled: true },
    { id: CAPTAIN_ID, email: 'captain@example.test', fullName: 'Captain', role: 'TEAM_CAPTAIN', isActive: true, passwordHash: 'h', emailVerifiedAt: null, isTwoFactorEnabled: false },
    { id: JUDGE_ID, email: 'judge@example.test', fullName: 'Judge', role: 'JUDGE', isActive: false, passwordHash: 'h', emailVerifiedAt: new Date(), isTwoFactorEnabled: true }
  ];
  const sessions: FakeSession[] = [
    { id: 's-actor', userId: ACTOR_ID, isActive: true, revokedAt: null },
    { id: 's-other-1', userId: OTHER_SA_ID, isActive: true, revokedAt: null },
    { id: 's-event-1', userId: EVENT_ADMIN_ID, isActive: true, revokedAt: null },
    { id: 's-event-2', userId: EVENT_ADMIN_ID, isActive: true, revokedAt: null },
    { id: 's-captain', userId: CAPTAIN_ID, isActive: true, revokedAt: null }
  ];
  const transactionOptions: any[] = [];

  const matchesUser = (u: FakeUser, where: any) =>
    (where.role === undefined || u.role === where.role) &&
    (where.isActive === undefined || u.isActive === where.isActive) &&
    (where.id?.not === undefined || u.id !== where.id.not);

  const prisma: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        const u = users.find((x) => x.id === where.id);
        return u ? { ...u } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const u = users.find((x) => x.id === where.id)!;
        Object.assign(u, data);
        return { ...u };
      }),
      count: jest.fn(async ({ where }: any) => users.filter((u) => matchesUser(u, where)).length)
    },
    session: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const s of sessions) {
          if (s.userId === where.userId && (where.revokedAt !== null || s.revokedAt === null)) {
            Object.assign(s, data);
            count++;
          }
        }
        return { count };
      })
    },
    $transaction: jest.fn(async (work: any, options: any) => {
      transactionOptions.push(options);
      return work(prisma);
    })
  };
  const audit = { logAction: jest.fn().mockResolvedValue(undefined) };
  const alerts = { alert: jest.fn().mockResolvedValue(true) } as unknown as SecurityAlertService;
  const service = new AuthService(prisma, new JwtService({ secret: 'staff_mgmt_test_secret_0123456789abcdef' }), new TwoFactorService(), audit as any, alerts);
  const actor = { id: ACTOR_ID, email: 'actor@example.test', role: 'SUPER_ADMIN' };
  return { users, sessions, prisma, audit, alerts: alerts as any, service, actor, transactionOptions };
}

const responseOf = (err: any) => (typeof err?.getResponse === 'function' ? err.getResponse() : undefined);

async function expectRejection(promise: Promise<unknown>, type: any, code?: string) {
  let caught: any;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(type);
  if (code) expect(responseOf(caught)).toMatchObject({ code });
  return caught;
}

describe('Staff management routes: guards and validation', () => {
  const p: any = AuthController.prototype;
  const guardsOf = (name: string) => (Reflect.getMetadata(GUARDS_METADATA, p[name]) || []) as any[];

  test.each([
    ['changeUserRole', 'users/:id/role'],
    ['setUserStatus', 'users/:id/status']
  ])('%s is PATCH %s with Roles, CSRF and step-up guards', (name, route) => {
    expect(Reflect.getMetadata(PATH_METADATA, p[name])).toBe(route);
    expect(Reflect.getMetadata(METHOD_METADATA, p[name])).toBe(4); // RequestMethod.PATCH
    const guards = guardsOf(name);
    expect(guards).toEqual(expect.arrayContaining([RolesGuard, CsrfGuard, StepUpGuard]));
    // Step-up is checked after authentication, role and CSRF
    expect(guards.indexOf(StepUpGuard)).toBeGreaterThan(guards.indexOf(CsrfGuard));
    expect(guards.indexOf(StepUpGuard)).toBeGreaterThan(guards.indexOf(RolesGuard));
    expect(Reflect.getMetadata('roles', p[name])).toEqual(['SUPER_ADMIN']);
  });

  test('the :id parameter is validated with ParseUUIDPipe', () => {
    for (const name of ['changeUserRole', 'setUserStatus']) {
      const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, AuthController, name) || {};
      const pipes = Object.values(args).flatMap((a: any) => a.pipes || []);
      expect(pipes.some((pipe: any) => pipe?.constructor?.name === 'ParseUUIDPipe')).toBe(true);
    }
  });

  test('RolesGuard admits only a Super Administrator on an administrative session', () => {
    const guard = new RolesGuard(new Reflector());
    const ctx = (user: any) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ user }) }), getHandler: () => p.changeUserRole, getClass: () => AuthController }) as any;
    expect(guard.canActivate(ctx({ role: 'SUPER_ADMIN', aud: 'gcdis-admin' }))).toBe(true);
    expect(guard.canActivate(ctx({ role: 'EVENT_ADMIN', aud: 'gcdis-admin' }))).toBe(false);
    expect(guard.canActivate(ctx({ role: 'JUDGE', aud: 'gcdis-admin' }))).toBe(false);
    expect(() => guard.canActivate(ctx({ role: 'SUPER_ADMIN', aud: 'gcdis-public' }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx({ role: 'TEAM_CAPTAIN', aud: 'gcdis-public' }))).toThrow(ForbiddenException);
  });

  test('StepUpGuard answers 403 STEP_UP_REQUIRED without a recent step-up', () => {
    const guard = new StepUpGuard();
    const ctx = (user: any) => ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as any;
    let caught: any;
    try {
      guard.canActivate(ctx({ id: ACTOR_ID, role: 'SUPER_ADMIN', stepUpAt: null }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect(caught.getResponse()).toMatchObject({ statusCode: 403, code: 'STEP_UP_REQUIRED' });
    expect(guard.canActivate(ctx({ id: ACTOR_ID, stepUpAt: new Date(Date.now() - 30_000) }))).toBe(true);
  });

  test('request bodies are validated (role string, isActive boolean, reason up to 300 characters, no extra keys)', async () => {
    const controller = new AuthController({ changeUserRole: jest.fn(), setUserActiveStatus: jest.fn() } as any, {} as any);
    const req = { user: { id: ACTOR_ID } };
    await expect(controller.changeUserRole(req, EVENT_ADMIN_ID, {}, '127.0.0.1', 'ua')).rejects.toThrow(BadRequestException);
    await expect(controller.changeUserRole(req, EVENT_ADMIN_ID, { role: 'JUDGE', extra: 1 }, '127.0.0.1', 'ua')).rejects.toThrow(BadRequestException);
    await expect(controller.setUserStatus(req, EVENT_ADMIN_ID, { isActive: 'false' }, '127.0.0.1', 'ua')).rejects.toThrow(BadRequestException);
    await expect(controller.setUserStatus(req, EVENT_ADMIN_ID, { isActive: false, reason: 'x'.repeat(301) }, '127.0.0.1', 'ua')).rejects.toThrow(
      BadRequestException
    );
    await expect(controller.setUserStatus(req, EVENT_ADMIN_ID, { isActive: false, reason: 'x'.repeat(300) }, '127.0.0.1', 'ua')).resolves.toBeUndefined();
  });

  test('the controller passes the authenticated actor, target, body and request metadata to the service', async () => {
    const svc = { changeUserRole: jest.fn().mockResolvedValue({ id: EVENT_ADMIN_ID }), setUserActiveStatus: jest.fn().mockResolvedValue({ id: EVENT_ADMIN_ID }) };
    const controller = new AuthController(svc as any, {} as any);
    const req = { user: { id: ACTOR_ID, email: 'actor@example.test', role: 'SUPER_ADMIN' } };
    await controller.changeUserRole(req, EVENT_ADMIN_ID, { role: ' JUDGE ' }, '10.0.0.1', 'agent');
    expect(svc.changeUserRole).toHaveBeenCalledWith(req.user, EVENT_ADMIN_ID, 'JUDGE', '10.0.0.1', 'agent');
    await controller.setUserStatus(req, EVENT_ADMIN_ID, { isActive: false, reason: '  Left the event  ' }, '10.0.0.1', 'agent');
    expect(svc.setUserActiveStatus).toHaveBeenCalledWith(req.user, EVENT_ADMIN_ID, false, 'Left the event', '10.0.0.1', 'agent');
  });
});

describe('PATCH /auth/users/:id/role', () => {
  test('changes a staff role, revokes the target sessions, audits from/to and returns the sanitised user', async () => {
    const f = buildFixture();
    const result: any = await f.service.changeUserRole(f.actor, EVENT_ADMIN_ID, 'JUDGE', '10.0.0.1', 'agent');
    expect(result).toMatchObject({ id: EVENT_ADMIN_ID, role: 'JUDGE', isActive: true, emailVerified: true });
    expect(result.passwordHash).toBeUndefined();
    expect(f.users.find((u) => u.id === EVENT_ADMIN_ID)!.role).toBe('JUDGE');
    expect(f.sessions.filter((s) => s.userId === EVENT_ADMIN_ID).every((s) => s.revokedAt && !s.isActive)).toBe(true);
    // Nobody else is signed out
    expect(f.sessions.find((s) => s.id === 's-actor')!.revokedAt).toBeNull();
    expect(f.audit.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'STAFF_ROLE_CHANGED',
        actorId: ACTOR_ID,
        actorEmail: 'actor@example.test',
        entityType: 'User',
        entityId: EVENT_ADMIN_ID,
        beforeState: { role: 'EVENT_ADMIN' },
        afterState: expect.objectContaining({ role: 'JUDGE', sessionsRevoked: 2, targetEmail: 'event@example.test' }),
        ipAddress: '10.0.0.1'
      })
    );
    // Only a promotion to Super Administrator raises an alert
    expect(f.alerts.alert).not.toHaveBeenCalled();
    expect(f.transactionOptions[0]).toEqual({ isolationLevel: 'Serializable' });
  });

  test('a promotion to Super Administrator raises a security alert', async () => {
    const f = buildFixture();
    await f.service.changeUserRole(f.actor, EVENT_ADMIN_ID, 'SUPER_ADMIN', '10.0.0.1');
    expect(f.alerts.alert).toHaveBeenCalledWith(
      'SUPER_ADMIN_ROLE_GRANTED',
      'event@example.test',
      expect.objectContaining({ previousRole: 'EVENT_ADMIN', changedBy: 'actor@example.test' })
    );
  });

  test('another Super Administrator may be demoted while one active Super Administrator remains', async () => {
    const f = buildFixture();
    await expect(f.service.changeUserRole(f.actor, OTHER_SA_ID, 'EVENT_ADMIN')).resolves.toMatchObject({ role: 'EVENT_ADMIN' });
  });

  test('the caller cannot change their own role', async () => {
    const f = buildFixture();
    const err = await expectRejection(f.service.changeUserRole(f.actor, ACTOR_ID, 'EVENT_ADMIN'), BadRequestException, 'SELF_MODIFICATION_NOT_ALLOWED');
    expect(responseOf(err).message).toBe('You cannot change the role of your own account.');
    expect(f.prisma.user.update).not.toHaveBeenCalled();
  });

  test('the last active Super Administrator cannot be demoted', async () => {
    const f = buildFixture();
    // The actor is deactivated in this scenario (e.g. a concurrent change), so the target is the only active one
    f.users.find((u) => u.id === ACTOR_ID)!.isActive = false;
    const err = await expectRejection(f.service.changeUserRole(f.actor, OTHER_SA_ID, 'JUDGE'), ConflictException, 'LAST_SUPER_ADMIN');
    expect(responseOf(err).message).toMatch(/last active Super Administrator/);
    expect(f.users.find((u) => u.id === OTHER_SA_ID)!.role).toBe('SUPER_ADMIN');
    expect(f.sessions.find((s) => s.id === 's-other-1')!.revokedAt).toBeNull();
    expect(f.audit.logAction).not.toHaveBeenCalled();
  });

  test('a participant account cannot be changed into staff', async () => {
    const f = buildFixture();
    const err = await expectRejection(f.service.changeUserRole(f.actor, CAPTAIN_ID, 'EVENT_ADMIN'), BadRequestException, 'ROLE_BOUNDARY');
    expect(responseOf(err).message).toMatch(/participant account cannot be changed to a staff role/);
    expect(f.users.find((u) => u.id === CAPTAIN_ID)!.role).toBe('TEAM_CAPTAIN');
  });

  test('a staff account cannot be changed into a participant', async () => {
    const f = buildFixture();
    for (const role of ['TEAM_CAPTAIN', 'TEAM_MEMBER']) {
      const err = await expectRejection(f.service.changeUserRole(f.actor, EVENT_ADMIN_ID, role), BadRequestException, 'ROLE_BOUNDARY');
      expect(responseOf(err).message).toMatch(/staff account cannot be changed to a participant role/);
    }
    expect(f.users.find((u) => u.id === EVENT_ADMIN_ID)!.role).toBe('EVENT_ADMIN');
  });

  test('unknown roles, unchanged roles and missing accounts are rejected formally', async () => {
    const f = buildFixture();
    await expectRejection(f.service.changeUserRole(f.actor, EVENT_ADMIN_ID, 'ROOT'), BadRequestException, 'INVALID_ROLE');
    await expectRejection(f.service.changeUserRole(f.actor, EVENT_ADMIN_ID, 'EVENT_ADMIN'), BadRequestException, 'ROLE_UNCHANGED');
    const err = await expectRejection(f.service.changeUserRole(f.actor, MISSING_ID, 'JUDGE'), NotFoundException);
    expect(err.message).toBe('The requested account could not be found.');
  });

  test('a serialization conflict is answered with 409 CONCURRENT_UPDATE', async () => {
    const f = buildFixture();
    f.prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('write conflict'), { code: 'P2034' }));
    await expectRejection(f.service.changeUserRole(f.actor, EVENT_ADMIN_ID, 'JUDGE'), ConflictException, 'CONCURRENT_UPDATE');
  });
});

describe('PATCH /auth/users/:id/status', () => {
  test('deactivating staff revokes every session immediately, audits the reason and raises an alert', async () => {
    const f = buildFixture();
    const result: any = await f.service.setUserActiveStatus(f.actor, EVENT_ADMIN_ID, false, '  Contract ended  ', '10.0.0.1', 'agent');
    expect(result).toMatchObject({ id: EVENT_ADMIN_ID, isActive: false, role: 'EVENT_ADMIN' });
    expect(result.passwordHash).toBeUndefined();
    expect(f.sessions.filter((s) => s.userId === EVENT_ADMIN_ID).every((s) => s.revokedAt && !s.isActive)).toBe(true);
    expect(f.audit.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'USER_DEACTIVATED',
        entityId: EVENT_ADMIN_ID,
        beforeState: { isActive: true },
        afterState: expect.objectContaining({
          isActive: false,
          role: 'EVENT_ADMIN',
          accountType: 'STAFF',
          reason: 'Contract ended',
          sessionsRevoked: 2
        })
      })
    );
    expect(f.alerts.alert).toHaveBeenCalledWith(
      'STAFF_ACCOUNT_DEACTIVATED',
      'event@example.test',
      expect.objectContaining({ role: 'EVENT_ADMIN', reason: 'Contract ended', deactivatedBy: 'actor@example.test' })
    );
  });

  test('a team captain may be deactivated for moderation; the audit entry states the role and no staff alert is raised', async () => {
    const f = buildFixture();
    await expect(f.service.setUserActiveStatus(f.actor, CAPTAIN_ID, false)).resolves.toMatchObject({ isActive: false, role: 'TEAM_CAPTAIN' });
    expect(f.sessions.find((s) => s.id === 's-captain')!.revokedAt).not.toBeNull();
    expect(f.audit.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'USER_DEACTIVATED',
        afterState: expect.objectContaining({ role: 'TEAM_CAPTAIN', accountType: 'PARTICIPANT', reason: null })
      })
    );
    expect(f.alerts.alert).not.toHaveBeenCalled();
  });

  test('reactivation is audited with the reason and does not touch sessions', async () => {
    const f = buildFixture();
    await expect(f.service.setUserActiveStatus(f.actor, JUDGE_ID, true, 'Returned to the panel')).resolves.toMatchObject({ isActive: true });
    expect(f.prisma.session.updateMany).not.toHaveBeenCalled();
    expect(f.audit.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'USER_REACTIVATED',
        beforeState: { isActive: false },
        afterState: expect.objectContaining({ isActive: true, reason: 'Returned to the panel', role: 'JUDGE' })
      })
    );
    expect(f.alerts.alert).not.toHaveBeenCalled();
  });

  test('the caller cannot deactivate their own account', async () => {
    const f = buildFixture();
    const err = await expectRejection(f.service.setUserActiveStatus(f.actor, ACTOR_ID, false), BadRequestException, 'SELF_MODIFICATION_NOT_ALLOWED');
    expect(responseOf(err).message).toBe('You cannot change the status of your own account.');
    expect(f.sessions.find((s) => s.id === 's-actor')!.revokedAt).toBeNull();
  });

  test('the last active Super Administrator cannot be deactivated', async () => {
    const f = buildFixture();
    f.users.find((u) => u.id === ACTOR_ID)!.isActive = false;
    await expectRejection(f.service.setUserActiveStatus(f.actor, OTHER_SA_ID, false), ConflictException, 'LAST_SUPER_ADMIN');
    expect(f.users.find((u) => u.id === OTHER_SA_ID)!.isActive).toBe(true);
    expect(f.prisma.session.updateMany).not.toHaveBeenCalled();
  });

  test('another Super Administrator may be deactivated while one remains active', async () => {
    const f = buildFixture();
    await expect(f.service.setUserActiveStatus(f.actor, OTHER_SA_ID, false)).resolves.toMatchObject({ isActive: false });
    expect(f.sessions.find((s) => s.id === 's-other-1')!.revokedAt).not.toBeNull();
  });

  test('an unchanged status and a missing account are rejected formally', async () => {
    const f = buildFixture();
    const err = await expectRejection(f.service.setUserActiveStatus(f.actor, EVENT_ADMIN_ID, true), BadRequestException, 'STATUS_UNCHANGED');
    expect(responseOf(err).message).toBe('The account is already active.');
    await expectRejection(f.service.setUserActiveStatus(f.actor, JUDGE_ID, false), BadRequestException, 'STATUS_UNCHANGED');
    await expectRejection(f.service.setUserActiveStatus(f.actor, MISSING_ID, false), NotFoundException);
  });

  test('an audit write failure never undoes the committed change', async () => {
    const f = buildFixture();
    f.audit.logAction.mockRejectedValueOnce(new Error('db down'));
    await expect(f.service.setUserActiveStatus(f.actor, EVENT_ADMIN_ID, false)).resolves.toMatchObject({ isActive: false });
  });
});

describe('Staff management: security alert catalogue', () => {
  test('the new alert events have formal titles', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'apps', 'api', 'src', 'security', 'security-alert.service.ts'), 'utf-8');
    expect(source).toContain("SUPER_ADMIN_ROLE_GRANTED: 'A staff account was granted the Super Administrator role'");
    expect(source).toContain("STAFF_ACCOUNT_DEACTIVATED: 'A staff account was deactivated'");
  });
});

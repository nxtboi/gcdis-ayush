import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ParseUUIDPipe,
  RequestMethod
} from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { UserRole, TeamMemberRole, RegistrationStatus, POST_APPROVAL_STATUSES } from '@gcdis/shared';
import { TeamsService, ROSTER_LOCKED_STATUSES } from '../apps/api/src/teams/teams.service';
import { TeamsController } from '../apps/api/src/teams/teams.controller';
import { CsrfGuard } from '../apps/api/src/common/guards/csrf.guard';
import { RolesGuard } from '../apps/api/src/auth/roles.guard';
import { ROLES_KEY } from '../apps/api/src/auth/roles.decorator';

const CAPTAIN = { id: 'cap-1', email: 'asha@example.test', role: UserRole.TEAM_CAPTAIN };
const TEAM_ID = 'team-1';

function roster() {
  return [
    { id: 'm-captain', email: CAPTAIN.email, memberRole: TeamMemberRole.CAPTAIN, userId: CAPTAIN.id },
    { id: 'm-pilot', email: 'pilot@example.test', memberRole: TeamMemberRole.PILOT, userId: null },
    { id: 'm-coach', email: 'coach@example.test', memberRole: TeamMemberRole.COACH, userId: null }
  ];
}

const FULL_ROWS: Record<string, any> = {
  'm-pilot': { id: 'm-pilot', fullName: 'Ravi Pilot', memberRole: 'PILOT', email: 'pilot@example.test', mobile: '9999999999' },
  'm-coach': { id: 'm-coach', fullName: 'Meera Coach', memberRole: 'COACH', email: 'coach@example.test', mobile: '8888888888' }
};

function prismaDouble(opts: { captainId?: string; lockedStatus?: string | null; team?: any | null } = {}) {
  const team =
    opts.team === null
      ? null
      : opts.team ?? { id: TEAM_ID, name: 'QA SQUAD', captainId: opts.captainId ?? CAPTAIN.id, category: { maxTeamSize: 10 }, members: roster() };
  const prisma: any = {
    team: { findUnique: jest.fn().mockResolvedValue(team) },
    registration: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (!opts.lockedStatus) return null;
        return where.status.in.includes(opts.lockedStatus) ? { id: 'reg-1', status: opts.lockedStatus } : null;
      })
    },
    teamMember: {
      delete: jest.fn(async ({ where, select }: any) => {
        const row = FULL_ROWS[where.id];
        if (!select) return row;
        return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
      })
    },
    auditLog: { create: jest.fn(async ({ data }: any) => ({ id: 'audit-1', ...data })) },
    $executeRaw: jest.fn().mockResolvedValue(1)
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  return prisma;
}

describe('Feature: a captain removes a member from the roster (service)', () => {
  test('removes a non-captain member and returns the new roster size', async () => {
    const prisma = prismaDouble();
    const svc = new TeamsService(prisma);
    const res = await svc.removeMember(CAPTAIN, TEAM_ID, 'm-pilot', { ip: '10.0.0.1', userAgent: 'jest' });
    expect(res).toEqual({ success: true, memberId: 'm-pilot', memberCount: 2 });
    expect(prisma.teamMember.delete).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'm-pilot' } }));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Team row lock taken inside the transaction, as for addMember/updateMember
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  test('writes a REMOVE_TEAM_MEMBER audit entry with name and role only (no email or phone)', async () => {
    const prisma = prismaDouble();
    await new TeamsService(prisma).removeMember(CAPTAIN, TEAM_ID, 'm-coach', { ip: '10.0.0.1', userAgent: 'jest' });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      actorId: CAPTAIN.id,
      actorRole: UserRole.TEAM_CAPTAIN,
      action: 'REMOVE_TEAM_MEMBER',
      entityType: 'TeamMember',
      entityId: 'm-coach',
      ipAddress: '10.0.0.1',
      userAgent: 'jest'
    });
    expect(data.beforeState).toEqual({ teamId: TEAM_ID, teamName: 'QA SQUAD', memberName: 'Meera Coach', memberRole: 'COACH' });
    const serialised = JSON.stringify(data.beforeState) + JSON.stringify(data.afterState ?? null);
    expect(serialised).not.toContain('coach@example.test');
    expect(serialised).not.toContain('8888888888');
  });

  test('the captain member row is protected (by role)', async () => {
    const prisma = prismaDouble();
    await expect(new TeamsService(prisma).removeMember(CAPTAIN, TEAM_ID, 'm-captain')).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(prisma.teamMember.delete).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test("the captain's own linked row is protected even if its role was altered", async () => {
    const members = roster();
    members[0].memberRole = TeamMemberRole.PILOT;
    const prisma = prismaDouble({ team: { id: TEAM_ID, name: 'X', captainId: CAPTAIN.id, category: {}, members } });
    await expect(new TeamsService(prisma).removeMember(CAPTAIN, TEAM_ID, 'm-captain')).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(prisma.teamMember.delete).not.toHaveBeenCalled();
  });

  test("another captain's team is refused with 403", async () => {
    const prisma = prismaDouble({ captainId: 'someone-else' });
    await expect(new TeamsService(prisma).removeMember(CAPTAIN, TEAM_ID, 'm-pilot')).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(prisma.teamMember.delete).not.toHaveBeenCalled();
  });

  test('a member of another team (not on this roster) is 404', async () => {
    const prisma = prismaDouble();
    await expect(new TeamsService(prisma).removeMember(CAPTAIN, TEAM_ID, 'member-of-other-team')).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(prisma.teamMember.delete).not.toHaveBeenCalled();
  });

  test('a missing team is 404', async () => {
    const prisma = prismaDouble({ team: null });
    await expect(new TeamsService(prisma).removeMember(CAPTAIN, 'nope', 'm-pilot')).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  test.each(POST_APPROVAL_STATUSES)('removal is refused with 409 once the registration is %s', async (status) => {
    const prisma = prismaDouble({ lockedStatus: status });
    const err = await new TeamsService(prisma).removeMember(CAPTAIN, TEAM_ID, 'm-pilot').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/roster is final/i);
    expect(err.message).not.toContain('!');
    expect(prisma.teamMember.delete).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test.each([
    RegistrationStatus.SUBMITTED,
    RegistrationStatus.PAYMENT_PENDING,
    RegistrationStatus.PAYMENT_VERIFIED,
    RegistrationStatus.ELIGIBILITY_REVIEW,
    RegistrationStatus.REQUIRES_ACTION
  ])('removal is allowed while the registration is %s', async (status) => {
    const prisma = prismaDouble({ lockedStatus: status });
    await expect(new TeamsService(prisma).removeMember(CAPTAIN, TEAM_ID, 'm-pilot')).resolves.toMatchObject({ success: true });
  });

  test('the locked stages are APPROVED and every later stage of the shared state machine', () => {
    expect([...ROSTER_LOCKED_STATUSES].sort()).toEqual(
      ['APPROVED', 'ACCREDITED', 'COMPETING', 'ARENA_CLEARED', 'COMPLETED'].sort()
    );
  });
});

describe('Feature: DELETE /teams/:id/members/:memberId (controller)', () => {
  const handler = TeamsController.prototype.removeMember;

  test('is routed as DELETE :id/members/:memberId', () => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/members/:memberId');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.DELETE);
  });

  test('uses the same guards and roles as PATCH members (JWT, RolesGuard, CsrfGuard, captain only)', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, handler) as any[];
    const patchGuards = Reflect.getMetadata(GUARDS_METADATA, TeamsController.prototype.updateMember) as any[];
    expect(guards).toContain(RolesGuard);
    expect(guards).toContain(CsrfGuard);
    expect(guards).toHaveLength(patchGuards.length);
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.TEAM_CAPTAIN]);
  });

  test('validates both path ids as UUIDs', () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, TeamsController, 'removeMember') as Record<string, any>;
    const params = Object.values(args).filter((a: any) => a.data === 'id' || a.data === 'memberId');
    expect(params).toHaveLength(2);
    for (const p of params) {
      expect(p.pipes.some((pipe: any) => pipe instanceof ParseUUIDPipe)).toBe(true);
    }
  });

  test('passes the caller, ids and request context to the service', async () => {
    const svc: any = { removeMember: jest.fn().mockResolvedValue({ success: true }) };
    const ctl = new TeamsController(svc);
    const req = { user: { id: 'cap-1', email: 'asha@example.test', role: 'TEAM_CAPTAIN' }, ip: '1.2.3.4', headers: { 'user-agent': 'ua' } };
    await ctl.removeMember(req, 'team-1', 'm-1');
    expect(svc.removeMember).toHaveBeenCalledWith(
      { id: 'cap-1', email: 'asha@example.test', role: 'TEAM_CAPTAIN' },
      'team-1',
      'm-1',
      { ip: '1.2.3.4', userAgent: 'ua' }
    );
  });
});

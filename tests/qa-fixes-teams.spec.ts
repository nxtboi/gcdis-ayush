import 'reflect-metadata';
import { BadRequestException, ForbiddenException, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  UserRole,
  TeamMemberRole,
  TeamRegistrationSchema,
  FIDA_MAX_TEAM_SIZE,
  FIDA_MAX_COACHES
} from '@gcdis/shared';
import { TeamsService, assertRosterLimits, maxRosterSize } from '../apps/api/src/teams/teams.service';
import { TeamsController } from '../apps/api/src/teams/teams.controller';
import { CreateTeamDto } from '../apps/api/src/teams/dto/create-team.dto';
import { RegistrationsService } from '../apps/api/src/registrations/registrations.service';
import { RegistrationsController } from '../apps/api/src/registrations/registrations.controller';
import { CsrfGuard } from '../apps/api/src/common/guards/csrf.guard';
import { RolesGuard } from '../apps/api/src/auth/roles.guard';
import { ROLES_KEY } from '../apps/api/src/auth/roles.decorator';

const CAPTAIN = { id: 'cap-1', fullName: 'Asha Rao', email: 'asha@example.test', phone: '9876543210' };
const CATEGORY = { id: 'cat-d20', maxTeamSize: 10, isActive: true };

function member(i: number, role: TeamMemberRole = TeamMemberRole.PILOT) {
  return { fullName: `Member ${i}`, email: `m${i}@example.test`, memberRole: role };
}

function teamsPrisma(existingMembers: any[] = [], captainId = CAPTAIN.id) {
  const prisma: any = {
    // No approved registration: the roster is not locked (security audit 2026-10, finding 1)
    registration: { findFirst: jest.fn().mockResolvedValue(null) },
    team: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue({ id: 'team-1', captainId, category: CATEGORY, members: existingMembers }),
      create: jest.fn(async ({ data }) => ({ id: 'team-1', ...data, members: data.members.create })),
      count: jest.fn().mockResolvedValue(0)
    },
    teamMember: {
      create: jest.fn(async ({ data }) => ({ id: 'new-member', ...data })),
      update: jest.fn(async ({ where, data }) => ({ id: where.id, ...data }))
    },
    category: { findUnique: jest.fn().mockResolvedValue(CATEGORY) },
    user: { findUnique: jest.fn().mockResolvedValue(CAPTAIN) },
    mediaAsset: { findFirst: jest.fn().mockResolvedValue(null) },
    $executeRawUnsafe: jest.fn().mockRejectedValue(new Error('no sequences in tests')),
    $queryRawUnsafe: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(1)
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  return prisma;
}

function roster(n: number, coaches = 0) {
  const rows: any[] = [{ id: 'm0', email: CAPTAIN.email, memberRole: TeamMemberRole.CAPTAIN }];
  for (let i = 1; i < n; i++) {
    rows.push({ id: `m${i}`, email: `m${i}@example.test`, memberRole: i <= coaches ? TeamMemberRole.COACH : TeamMemberRole.PILOT });
  }
  return rows;
}

describe('QA fixes: team registration (H1, H2, L2, L3, M8)', () => {
  describe('H1: a team can be created with the captain alone', () => {
    test('captain is auto-added as the CAPTAIN member', async () => {
      const prisma = teamsPrisma();
      const svc = new TeamsService(prisma);
      const team: any = await svc.createTeam(CAPTAIN.id, {
        categoryId: CATEGORY.id,
        teamName: 'qa squad',
        institutionName: 'Test Institute',
        city: 'Pune'
      });
      expect(team.name).toBe('QA SQUAD');
      expect(team.members).toHaveLength(1);
      expect(team.members[0]).toMatchObject({
        userId: CAPTAIN.id,
        fullName: CAPTAIN.fullName,
        email: CAPTAIN.email,
        mobile: CAPTAIN.phone,
        memberRole: TeamMemberRole.CAPTAIN
      });
    });

    test('CreateTeamDto accepts a payload without members', async () => {
      const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
      const dto = await pipe.transform(
        { categoryId: CATEGORY.id, teamName: 'QA', institutionName: 'Inst', city: 'Pune' },
        { type: 'body', metatype: CreateTeamDto }
      );
      expect(dto.members).toBeUndefined();
    });
  });

  describe('H2: FIDA roster limits are enforced server-side', () => {
    test('limits come from the category, never above 7', () => {
      expect(FIDA_MAX_TEAM_SIZE).toBe(7);
      expect(FIDA_MAX_COACHES).toBe(3);
      expect(maxRosterSize({ maxTeamSize: 10 })).toBe(7);
      expect(maxRosterSize({ maxTeamSize: 6 })).toBe(6);
      expect(maxRosterSize({ maxTeamSize: 20 })).toBe(7);
      expect(maxRosterSize(null)).toBe(7);
      expect(() => assertRosterLimits(roster(7, 3), 7)).not.toThrow();
      expect(() => assertRosterLimits(roster(8), 7)).toThrow(BadRequestException);
      expect(() => assertRosterLimits(roster(5, 4), 7)).toThrow(/at most 3 coaches/);
    });

    test('createTeam rejects 7 listed members plus the captain', async () => {
      const prisma = teamsPrisma();
      const svc = new TeamsService(prisma);
      const members = Array.from({ length: 7 }, (_, i) => member(i + 1));
      await expect(
        svc.createTeam(CAPTAIN.id, { categoryId: CATEGORY.id, teamName: 'X', institutionName: 'I', city: 'C', members })
      ).rejects.toThrow(/at most 7 members/);
      expect(prisma.team.create).not.toHaveBeenCalled();
    });

    test('createTeam rejects a fourth coach and a second captain', async () => {
      const svc = new TeamsService(teamsPrisma());
      const base = { categoryId: CATEGORY.id, teamName: 'X', institutionName: 'I', city: 'C' };
      const coaches = [1, 2, 3, 4].map((i) => member(i, TeamMemberRole.COACH));
      await expect(svc.createTeam(CAPTAIN.id, { ...base, members: coaches })).rejects.toThrow(/coaches/);
      await expect(
        svc.createTeam(CAPTAIN.id, { ...base, members: [member(1, TeamMemberRole.CAPTAIN)] })
      ).rejects.toThrow(/captain/i);
    });

    test('addMember allows the 7th member and rejects the 8th', async () => {
      const svc9 = new TeamsService(teamsPrisma(roster(6)));
      await expect(svc9.addMember(CAPTAIN.id, 'team-1', member(50))).resolves.toMatchObject({ teamId: 'team-1' });

      const prisma10 = teamsPrisma(roster(7));
      const svc10 = new TeamsService(prisma10);
      await expect(svc10.addMember(CAPTAIN.id, 'team-1', member(51))).rejects.toThrow(/at most 7 members/);
      expect(prisma10.teamMember.create).not.toHaveBeenCalled();
    });

    test('addMember rejects a 4th coach, duplicates and a second captain', async () => {
      const svc = new TeamsService(teamsPrisma(roster(5, 3)));
      await expect(svc.addMember(CAPTAIN.id, 'team-1', member(60, TeamMemberRole.COACH))).rejects.toThrow(/coaches/);
      await expect(svc.addMember(CAPTAIN.id, 'team-1', { ...member(61), email: 'M1@example.test' })).rejects.toThrow(/already on the roster/);
      await expect(svc.addMember(CAPTAIN.id, 'team-1', member(62, TeamMemberRole.CAPTAIN))).rejects.toThrow(/one captain/);
    });

    test('member endpoints check team ownership', async () => {
      const svc = new TeamsService(teamsPrisma(roster(2), 'someone-else'));
      await expect(svc.addMember(CAPTAIN.id, 'team-1', member(70))).rejects.toThrow(ForbiddenException);
      await expect(svc.updateMember(CAPTAIN.id, 'team-1', 'm1', { fullName: 'Changed' })).rejects.toThrow(ForbiddenException);
    });

    test('updateMember enforces the coach limit and protects the captain row', async () => {
      const svc = new TeamsService(teamsPrisma(roster(6, 3)));
      await expect(svc.updateMember(CAPTAIN.id, 'team-1', 'm5', { memberRole: TeamMemberRole.COACH })).rejects.toThrow(/coaches/);
      await expect(svc.updateMember(CAPTAIN.id, 'team-1', 'm0', { memberRole: TeamMemberRole.PILOT })).rejects.toThrow(/captain/i);
      await expect(svc.updateMember(CAPTAIN.id, 'team-1', 'm5', { fullName: 'Renamed' })).resolves.toMatchObject({ fullName: 'Renamed' });
    });

    test('member ID proofs must still be the captain\'s own private upload', async () => {
      const prisma = teamsPrisma(roster(2));
      const svc = new TeamsService(prisma);
      await expect(
        svc.addMember(CAPTAIN.id, 'team-1', { ...member(80), idProofUrl: '/api/uploads/files/other.pdf' })
      ).rejects.toThrow(/uploaded by this account/);
      expect(prisma.mediaAsset.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { fileUrl: '/api/uploads/files/other.pdf', uploadedBy: CAPTAIN.id } })
      );
    });

    test('shared zod schema applies the same limits', () => {
      const base = { categoryId: '1976a1cc-adfc-4d6f-903c-76dcdc64eeb0', teamName: 'QA Squad', institutionName: 'Inst', city: 'Pune' };
      expect(TeamRegistrationSchema.safeParse(base).success).toBe(true);
      const ten = Array.from({ length: 10 }, (_, i) => member(i));
      expect(TeamRegistrationSchema.safeParse({ ...base, members: ten }).success).toBe(false);
      const coaches = [1, 2, 3, 4].map((i) => member(i, TeamMemberRole.COACH));
      expect(TeamRegistrationSchema.safeParse({ ...base, members: coaches }).success).toBe(false);
    });
  });

  describe('L3: registration category must equal the team category', () => {
    test('mismatched categoryId is rejected with 400', async () => {
      const prisma: any = {
        team: { findUnique: jest.fn().mockResolvedValue({ id: 'team-1', captainId: CAPTAIN.id, categoryId: 'cat-d20' }) },
        category: { findUnique: jest.fn().mockResolvedValue({ id: 'cat-d40', name: 'D40' }) },
        registration: { findFirst: jest.fn(), create: jest.fn() }
      };
      const svc = new RegistrationsService(prisma, { logAction: jest.fn() } as any);
      await expect(
        svc.createRegistration('team-1', 'cat-d40', CAPTAIN.id, UserRole.TEAM_CAPTAIN)
      ).rejects.toThrow(BadRequestException);
      expect(prisma.registration.create).not.toHaveBeenCalled();
    });
  });

  describe('L2 / M8: captain-only routes use @Roles(TEAM_CAPTAIN) and CsrfGuard', () => {
    const cases: [any, string, boolean][] = [
      [TeamsController, 'createTeam', true],
      [TeamsController, 'getMyTeam', false],
      [TeamsController, 'addMember', true],
      [TeamsController, 'updateMember', true],
      [RegistrationsController, 'createRegistration', true],
      [RegistrationsController, 'addDocument', true]
    ];

    test.each(cases)('%p.%s', (ctrl, method, stateChanging) => {
      const handler = ctrl.prototype[method];
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.TEAM_CAPTAIN]);
      const guards = Reflect.getMetadata(GUARDS_METADATA, handler) || [];
      expect(guards).toContain(RolesGuard);
      if (stateChanging) expect(guards).toContain(CsrfGuard);
    });

    test('other state-changing registration routes carry CsrfGuard', () => {
      for (const method of ['transitionStatus', 'verifyDocument']) {
        const guards = Reflect.getMetadata(GUARDS_METADATA, (RegistrationsController.prototype as any)[method]) || [];
        expect(guards).toContain(CsrfGuard);
      }
    });
  });
});

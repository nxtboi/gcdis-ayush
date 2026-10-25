import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TeamMemberRole, FIDA_MAX_TEAM_SIZE, FIDA_MAX_COACHES, POST_APPROVAL_STATUSES } from '@gcdis/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * Registration stages in which the roster is final (APPROVED and every later stage, from the shared
 * state machine): members can no longer be added, edited or removed.
 */
export const ROSTER_LOCKED_STATUSES: readonly string[] = POST_APPROVAL_STATUSES;

/** 409 message for any roster change once the roster is final (the portal shows the same text). */
export const ROSTER_LOCKED_MESSAGE =
  'The roster is final once the registration has been approved. Please contact the GCDIS Secretariat if a change is required.';

/** Message for the second team of a captain (one team per captain account, enforced by a unique index). */
export const CAPTAIN_TEAM_EXISTS_MESSAGE = 'This captain account already has a registered team.';

/** Public-safe member projection: never emails, phones, ID proofs or linked user IDs. */
const PUBLIC_MEMBER_SELECT = {
  id: true,
  fullName: true,
  memberRole: true,
  status: true
} as const;

const STAFF_ROLES = new Set(['SUPER_ADMIN', 'EVENT_ADMIN']);

/** Only private files served by the uploads module may be referenced as ID proofs. */
const ID_PROOF_URL_PATTERN = /^\/api\/uploads\/files\/[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/** Fallback role for members submitted without one (matches the TeamMember.memberRole column default). */
const DEFAULT_MEMBER_ROLE = 'TEAM_MEMBER';

interface RosterEntry {
  memberRole: string;
}

/** Effective roster limit: the category's maxTeamSize, never above the championship limit of 7. */
export function maxRosterSize(category: { maxTeamSize?: number | null } | null | undefined): number {
  const configured = Number(category?.maxTeamSize);
  if (!Number.isInteger(configured) || configured <= 0) return FIDA_MAX_TEAM_SIZE;
  return Math.min(configured, FIDA_MAX_TEAM_SIZE);
}

/** Throws 400 when the roster exceeds the team size or coach limits (7 people, at most 3 coaches). */
export function assertRosterLimits(roster: RosterEntry[], maxSize: number): void {
  if (roster.length > maxSize) {
    throw new BadRequestException(
      `A team may have at most ${maxSize} members, including the captain; this change would bring the roster to ${roster.length}.`
    );
  }
  const coaches = roster.filter((m) => String(m.memberRole).toUpperCase() === TeamMemberRole.COACH).length;
  if (coaches > FIDA_MAX_COACHES) {
    throw new BadRequestException(
      `A team may have at most ${FIDA_MAX_COACHES} coaches; this change would bring the number of coaches to ${coaches}.`
    );
  }
}

function normaliseEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Member names are trimmed before storage; a name made only of whitespace passes the DTO's IsNotEmpty
 * check but would be stored as an empty string, so it is rejected here.
 */
export function requireMemberName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) {
    throw new BadRequestException("Please enter the member's full name.");
  }
  return name;
}

/** Optional phone numbers are stored trimmed; an empty value clears the stored number. */
function normalisePhone(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** True for a Prisma unique-constraint violation (P2002) whose target names one of the given columns. */
function isUniqueViolationOn(err: any, ...columns: string[]): boolean {
  if (!err || err.code !== 'P2002') return false;
  const target = (err.meta as any)?.target;
  const text = Array.isArray(target) ? target.join(',') : String(target ?? '');
  // Without target metadata the only unique columns written here are captainId and code (sequence-generated)
  return text === '' || columns.some((c) => text.includes(c));
}

export interface TeamViewer {
  id: string;
  role: string;
  aud?: string;
}

/** Removes the captain's user ID (and any other user identifiers) from a team returned to the public. */
function toPublicTeam<T extends Record<string, any>>(team: T): Omit<T, 'captainId'> {
  if (!team || typeof team !== 'object') return team;
  const { captainId, _count, ...rest } = team as any;
  if (_count && typeof _count.members === 'number') rest.memberCount = _count.members;
  if (rest.captain && typeof rest.captain === 'object') {
    const { id, email, phone, ...captain } = rest.captain;
    rest.captain = captain;
  }
  return rest;
}

@Injectable()
export class TeamsService {
  constructor(private prisma: PrismaService) {}

  async findAllTeams(page: { take: number; skip: number } = { take: 100, skip: 0 }) {
    return this.prisma.team.findMany({
      include: {
        members: true,
        category: true
      },
      orderBy: { createdAt: 'desc' },
      take: page.take,
      skip: page.skip
    });
  }

  async findPublicTeams(page: { take: number; skip: number } = { take: 100, skip: 0 }) {
    const teams = await this.prisma.team.findMany({
      where: { isApprovedPublic: true },
      // Listings expose roster size only; member names remain on the approved team detail page
      include: {
        category: true,
        _count: { select: { members: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: page.take,
      skip: page.skip
    });
    return (teams || []).map((t: any) => toPublicTeam(t));
  }

  async findTeamsByCategory(categoryId: string, page: { take: number; skip: number } = { take: 100, skip: 0 }) {
    const teams = await this.prisma.team.findMany({
      where: { categoryId, isApprovedPublic: true },
      include: {
        _count: { select: { members: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: page.take,
      skip: page.skip
    });
    return (teams || []).map((t: any) => toPublicTeam(t));
  }

  /**
   * Team detail.
   * - Anonymous / other users: only publicly approved teams, with no user IDs, emails or phones.
   * - Owning captain and staff (SUPER_ADMIN / EVENT_ADMIN admin session): full record, any approval state.
   */
  async findById(id: string, viewer?: TeamViewer | null) {
    const isStaff = !!viewer && STAFF_ROLES.has(viewer.role) && viewer.aud === 'gcdis-admin';

    const team: any = await this.prisma.team.findUnique({
      where: { id },
      include: {
        members: {
          select: {
            id: true,
            fullName: true,
            memberRole: true,
            status: true
          }
        },
        category: true,
        captain: {
          select: {
            id: true,
            fullName: true,
            organization: true
          }
        }
      }
    });
    if (!team) {
      throw new NotFoundException(`Team with ID '${id}' not found`);
    }

    const ownerId = team.captainId ?? team.captain?.id;
    const isOwner = !!viewer && !!ownerId && viewer.id === ownerId;

    if (isStaff || isOwner) {
      return this.prisma.team.findUnique({
        where: { id },
        include: {
          members: true,
          category: true,
          captain: {
            select: { id: true, fullName: true, organization: true, email: true, phone: true }
          }
        }
      });
    }

    if (team.isApprovedPublic !== true) {
      // Same response as a missing team: do not reveal that unapproved teams exist
      throw new NotFoundException(`Team with ID '${id}' not found`);
    }

    return toPublicTeam(team);
  }

  async findCaptainTeam(captainUserId: string) {
    return this.prisma.team.findFirst({
      where: { captainId: captainUserId },
      include: {
        // Stable roster order (oldest first, so the captain leads): without an ORDER BY, PostgreSQL may
        // return updated rows in a different position and the portal's roster would reorder after every edit.
        members: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        category: true,
        registrations: {
          orderBy: { submittedAt: 'desc' },
          include: {
            payments: { orderBy: { createdAt: 'desc' } },
            documents: { orderBy: { uploadedAt: 'desc' } },
            inspections: true,
            certificates: true
          }
        }
      }
    });
  }

  /**
   * ID proofs must be the relative URL of a private upload made by the same captain.
   */
  private async validateIdProofUrl(captainUserId: string, idProofUrl: unknown): Promise<string | null> {
    if (idProofUrl === undefined || idProofUrl === null || idProofUrl === '') return null;
    if (typeof idProofUrl !== 'string' || !ID_PROOF_URL_PATTERN.test(idProofUrl) || idProofUrl.includes('..')) {
      throw new BadRequestException(
        'idProofUrl must be the relative /api/uploads/files/<key> URL returned by the upload endpoint'
      );
    }
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { fileUrl: idProofUrl, uploadedBy: captainUserId },
      select: { id: true, isPublic: true }
    });
    if (!asset) {
      throw new BadRequestException('idProofUrl does not reference a file uploaded by this account');
    }
    if (asset.isPublic) {
      throw new BadRequestException('ID proofs must be uploaded as private documents');
    }
    return idProofUrl;
  }

  async createTeam(captainUserId: string, input: any) {
    if (!input || typeof input !== 'object') {
      throw new BadRequestException('The team details are required.');
    }

    // Check if captain already created a team
    const existing = await this.prisma.team.findFirst({
      where: { captainId: captainUserId }
    });
    if (existing) {
      throw new BadRequestException(CAPTAIN_TEAM_EXISTS_MESSAGE);
    }

    if (typeof input.categoryId !== 'string' || input.categoryId.length === 0) {
      throw new BadRequestException('Please select a competition category.');
    }
    // Never silently attach the team to a different category
    const category = await this.prisma.category.findUnique({
      where: { id: input.categoryId }
    });
    if (!category) {
      throw new BadRequestException('The selected competition category does not exist.');
    }
    if ((category as any).isActive === false) {
      throw new BadRequestException('The selected competition category is not open for registration.');
    }

    const members: any[] = Array.isArray(input.members) ? input.members : [];
    const memberRows: any[] = [];
    for (const m of members) {
      memberRows.push({
        fullName: requireMemberName(m.fullName),
        email: m.email || '',
        mobile: normalisePhone(m.phone || m.mobile),
        memberRole: String(m.memberRole || m.role || DEFAULT_MEMBER_ROLE).toUpperCase(),
        idProofUrl: await this.validateIdProofUrl(captainUserId, m.idProofUrl),
        status: 'PENDING'
      });
    }

    // The captain is always on the roster as the single CAPTAIN member; FIDA requires the rest only before competition.
    const captain = await this.prisma.user.findUnique({
      where: { id: captainUserId },
      select: { fullName: true, email: true, phone: true }
    });
    if (!captain) {
      throw new BadRequestException('The captain account could not be found.');
    }
    const captainEmail = normaliseEmail(captain.email);
    const captainRow = memberRows.find((row) => normaliseEmail(row.email) === captainEmail);
    for (const row of memberRows) {
      if (row !== captainRow && row.memberRole === TeamMemberRole.CAPTAIN) {
        throw new BadRequestException('Only the team captain may hold the captain role.');
      }
    }
    if (captainRow) {
      captainRow.memberRole = TeamMemberRole.CAPTAIN;
      captainRow.userId = captainUserId;
    } else {
      memberRows.unshift({
        userId: captainUserId,
        fullName: captain.fullName,
        email: captain.email,
        mobile: captain.phone || '',
        memberRole: TeamMemberRole.CAPTAIN,
        idProofUrl: null,
        status: 'PENDING'
      });
    }
    this.assertUniqueEmails(memberRows);
    assertRosterLimits(memberRows, maxRosterSize(category));

    let teamSeqNumber = 1;
    try {
      await this.prisma.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS team_code_seq START WITH 1 INCREMENT BY 1;`);
      const seqRes: any = await this.prisma.$queryRawUnsafe(`SELECT nextval('team_code_seq') as val;`);
      if (seqRes && seqRes[0] && seqRes[0].val) {
        teamSeqNumber = Number(seqRes[0].val);
      }
    } catch {
      const count = await this.prisma.team.count();
      teamSeqNumber = count + 1;
    }

    const teamCode = `GCDIS-2026-T${String(teamSeqNumber).padStart(3, '0')}`;

    try {
      return await this.prisma.team.create({
        data: {
          categoryId: category.id,
          captainId: captainUserId,
          name: String(input.teamName || input.name || 'ANONYMOUS TEAM').toUpperCase(),
          code: teamCode,
          institutionName: input.institutionName || 'Unknown Institution',
          city: input.city || 'Delhi',
          country: input.country || 'India',
          isApprovedPublic: false,
          members: {
            create: memberRows
          }
        },
        include: {
          members: true,
          category: true
        }
      });
    } catch (err: any) {
      // A concurrent second createTeam for the same captain lost the race against the unique
      // teams.captainId index: answer 409 instead of a second team or a 500.
      if (isUniqueViolationOn(err, 'captainId', 'captain_id')) {
        throw new ConflictException(CAPTAIN_TEAM_EXISTS_MESSAGE);
      }
      throw err;
    }
  }

  /**
   * Refuses roster changes (409) once any registration of the team has been approved. Must be called
   * inside the transaction that holds the team row lock.
   */
  private async assertRosterUnlocked(tx: Prisma.TransactionClient, teamId: string): Promise<void> {
    const lockedRegistration = await tx.registration.findFirst({
      where: { teamId, status: { in: ROSTER_LOCKED_STATUSES as any } },
      select: { id: true, status: true }
    });
    if (lockedRegistration) {
      throw new ConflictException(ROSTER_LOCKED_MESSAGE);
    }
  }

  private assertUniqueEmails(rows: { email?: string | null }[]): void {
    const seen = new Set<string>();
    for (const row of rows) {
      const email = normaliseEmail(row.email);
      if (!email) continue;
      if (seen.has(email)) {
        throw new ConflictException(`A team member with the email address '${email}' is already on the roster.`);
      }
      seen.add(email);
    }
  }

  /**
   * Loads a team inside a transaction with its row locked (so concurrent roster changes cannot exceed
   * the limits) and checks that the caller is its captain.
   */
  private async lockOwnedTeam(tx: Prisma.TransactionClient, teamId: string, captainUserId: string) {
    try {
      await tx.$executeRaw`SELECT id FROM "teams" WHERE id = ${teamId} FOR UPDATE`;
    } catch {
      // Clients without row locking (unit-test doubles) fall through to the plain read
    }
    const team = await tx.team.findUnique({
      where: { id: teamId },
      include: {
        category: true,
        members: { select: { id: true, email: true, memberRole: true, userId: true } }
      }
    });
    if (!team) {
      throw new NotFoundException('The team could not be found.');
    }
    if (team.captainId !== captainUserId) {
      throw new ForbiddenException('You may manage the members of your own team only.');
    }
    return team;
  }

  /** POST /teams/:id/members: the captain adds a member, within the FIDA roster limits. */
  async addMember(captainUserId: string, teamId: string, input: any) {
    if (!input || typeof input !== 'object') {
      throw new BadRequestException('The member details are required.');
    }
    const fullName = requireMemberName(input.fullName);
    const memberRole = String(input.memberRole || DEFAULT_MEMBER_ROLE).toUpperCase();
    if (memberRole === TeamMemberRole.CAPTAIN) {
      throw new BadRequestException('A team has exactly one captain; please choose another role.');
    }
    const idProofUrl = await this.validateIdProofUrl(captainUserId, input.idProofUrl);

    return this.prisma.$transaction(async (tx) => {
      const team = await this.lockOwnedTeam(tx, teamId, captainUserId);
      await this.assertRosterUnlocked(tx, team.id);
      const row = {
        fullName,
        email: String(input.email || '').trim(),
        mobile: normalisePhone(input.phone || input.mobile),
        memberRole,
        idProofUrl,
        status: 'PENDING'
      };
      this.assertUniqueEmails([...team.members, row]);
      assertRosterLimits([...team.members, row], maxRosterSize(team.category));
      return tx.teamMember.create({ data: { ...row, teamId: team.id } });
    });
  }

  /** PATCH /teams/:id/members/:memberId: the captain edits a member of their own team. */
  async updateMember(captainUserId: string, teamId: string, memberId: string, input: any) {
    if (!input || typeof input !== 'object') {
      throw new BadRequestException('The member details are required.');
    }
    const idProofUrl =
      input.idProofUrl === undefined ? undefined : await this.validateIdProofUrl(captainUserId, input.idProofUrl);

    return this.prisma.$transaction(async (tx) => {
      const team = await this.lockOwnedTeam(tx, teamId, captainUserId);
      const member = team.members.find((m) => m.id === memberId);
      if (!member) {
        throw new NotFoundException('This member is not on your team roster.');
      }
      await this.assertRosterUnlocked(tx, team.id);
      const isCaptainMember = String(member.memberRole).toUpperCase() === TeamMemberRole.CAPTAIN;

      const data: Record<string, any> = {};
      if (input.fullName !== undefined) data.fullName = requireMemberName(input.fullName);
      if (input.phone !== undefined) data.mobile = normalisePhone(input.phone);
      if (idProofUrl !== undefined) data.idProofUrl = idProofUrl;
      if (input.email !== undefined) {
        if (isCaptainMember && normaliseEmail(input.email) !== normaliseEmail(member.email)) {
          throw new BadRequestException("The captain's email address is the account email and cannot be changed here.");
        }
        data.email = String(input.email).trim();
      }
      if (input.memberRole !== undefined) {
        const role = String(input.memberRole).toUpperCase();
        if (isCaptainMember && role !== TeamMemberRole.CAPTAIN) {
          throw new BadRequestException('The captain role cannot be reassigned.');
        }
        if (!isCaptainMember && role === TeamMemberRole.CAPTAIN) {
          throw new BadRequestException('A team has exactly one captain; please choose another role.');
        }
        data.memberRole = role;
      }

      const roster = team.members.map((m) => (m.id === memberId ? { ...m, ...data } : m));
      this.assertUniqueEmails(roster);
      assertRosterLimits(roster, maxRosterSize(team.category));

      return tx.teamMember.update({ where: { id: memberId }, data });
    });
  }

  /**
   * DELETE /teams/:id/members/:memberId: the captain removes a member of their own team.
   *
   * - The captain's own member row cannot be removed (the account holder always leads the roster).
   * - Once any registration of the team has been approved (APPROVED and every later stage), the roster
   *   is final: accreditation passes and certificates are issued against it, so removal is refused (409).
   * - No other table references a team member by foreign key (certificates store the recipient's name
   *   as text and passes are generated on demand), so deleting the row cannot leave dangling records.
   * The removal and its audit entry are written in the same transaction, under the team row lock.
   */
  async removeMember(
    actor: { id: string; email?: string; role?: string },
    teamId: string,
    memberId: string,
    context: { ip?: string; userAgent?: string } = {}
  ) {
    return this.prisma.$transaction(async (tx) => {
      const team = await this.lockOwnedTeam(tx, teamId, actor.id);
      const member = team.members.find((m) => m.id === memberId);
      if (!member) {
        throw new NotFoundException('This member is not on your team roster.');
      }
      if (String(member.memberRole).toUpperCase() === TeamMemberRole.CAPTAIN || member.userId === actor.id) {
        throw new BadRequestException('The team captain cannot be removed from the roster.');
      }

      await this.assertRosterUnlocked(tx, team.id);

      const removed = await tx.teamMember.delete({
        where: { id: member.id },
        select: { id: true, fullName: true, memberRole: true }
      });

      const auditEntry = {
        actorId: actor.id,
        actorEmail: actor.email,
        actorRole: actor.role || 'TEAM_CAPTAIN',
        action: 'REMOVE_TEAM_MEMBER',
        entityType: 'TeamMember',
        entityId: removed.id,
        // Name and role only: contact details of the removed member are not copied into the audit trail
        beforeState: {
          teamId: team.id,
          teamName: (team as any).name,
          memberName: removed.fullName,
          memberRole: removed.memberRole
        },
        ipAddress: context.ip,
        userAgent: context.userAgent
      };
      const auditClient: any = typeof (tx as any)?.auditLog?.create === 'function' ? tx : this.prisma;
      await new AuditService(auditClient).logAction(auditEntry);

      return { success: true, memberId: removed.id, memberCount: team.members.length - 1 };
    });
  }

  async approveForPublic(id: string) {
    const team = await this.prisma.team.findUnique({ where: { id }, select: { id: true } });
    if (!team) {
      throw new NotFoundException(`Team with ID '${id}' not found`);
    }
    return this.prisma.team.update({
      where: { id },
      data: { isApprovedPublic: true }
    });
  }
}

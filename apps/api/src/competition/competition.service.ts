import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  MatchStatus,
  MatchEventLogInput,
  MatchEventType,
  canTransitionMatch,
  POST_APPROVAL_STATUSES
} from '@gcdis/shared';

/** Hard caps for public list endpoints so a single request can never load unbounded rows. */
export const MAX_FIXTURES_PER_QUERY = 500;
export const MAX_RANKING_TEAMS = 500;
export const MAX_RANKING_FIXTURES = 5000;
export const MAX_FIXTURE_EVENTS = 1000;

@Injectable()
export class CompetitionService {
  constructor(private prisma: PrismaService) {}

  async findAllArenas() {
    return this.prisma.arena.findMany({
      orderBy: { code: 'asc' },
      take: 200
    });
  }

  async findAllFixtures() {
    const fixtures = await this.prisma.fixture.findMany({
      include: {
        arena: true,
        category: true,
        team1: { select: { id: true, name: true, code: true, institutionName: true } },
        team2: { select: { id: true, name: true, code: true, institutionName: true } }
      },
      orderBy: { matchNumber: 'asc' },
      take: MAX_FIXTURES_PER_QUERY
    });

    return fixtures.map((f) => this.formatFixture(f));
  }

  async findFixturesByCategory(categoryId: string) {
    const fixtures = await this.prisma.fixture.findMany({
      where: { categoryId },
      include: {
        arena: true,
        category: true,
        team1: { select: { id: true, name: true, code: true, institutionName: true } },
        team2: { select: { id: true, name: true, code: true, institutionName: true } }
      },
      orderBy: { matchNumber: 'asc' },
      take: MAX_FIXTURES_PER_QUERY
    });

    return fixtures.map((f) => this.formatFixture(f));
  }

  async findFixtureById(id: string) {
    const fixture = await this.prisma.fixture.findUnique({
      where: { id },
      include: {
        arena: true,
        category: true,
        team1: { select: { id: true, name: true, code: true, institutionName: true } },
        team2: { select: { id: true, name: true, code: true, institutionName: true } },
        events: { orderBy: { timestamp: 'asc' }, take: MAX_FIXTURE_EVENTS }
      }
    });

    if (!fixture) {
      throw new NotFoundException(`Fixture with ID '${id}' not found`);
    }

    return this.formatFixture(fixture);
  }

  async transitionMatchStatus(id: string, targetStatus: MatchStatus) {
    const fixture = await this.prisma.fixture.findUnique({ where: { id } });
    if (!fixture) {
      throw new NotFoundException(`Fixture with ID '${id}' not found`);
    }

    if (!canTransitionMatch(fixture.status as any, targetStatus as any)) {
      throw new BadRequestException(
        `The match status cannot change from ${fixture.status} to ${targetStatus}.`
      );
    }

    const updated = await this.prisma.fixture.update({
      where: { id },
      data: {
        status: targetStatus,
        ...(targetStatus === MatchStatus.LIVE && !fixture.scheduledStart ? { scheduledStart: new Date() } : {})
      },
      include: {
        arena: true,
        category: true,
        team1: { select: { id: true, name: true, code: true, institutionName: true } },
        team2: { select: { id: true, name: true, code: true, institutionName: true } },
        events: { orderBy: { timestamp: 'asc' }, take: MAX_FIXTURE_EVENTS }
      }
    });

    return this.formatFixture(updated);
  }

  async logMatchEvent(input: MatchEventLogInput, loggedBy: string) {
    return this.prisma.$transaction(async (tx) => {
      // Serialize concurrent score events for the same fixture: take a row lock FIRST, then read.
      // Without this, two judges scoring simultaneously both read the old score and one goal is lost
      // (read-modify-write race). Under READ COMMITTED the read below sees the latest committed score.
      await tx.$executeRaw`SELECT 1 FROM "fixtures" WHERE "id" = ${input.fixtureId} FOR UPDATE`;

      const fixture = await tx.fixture.findUnique({
        where: { id: input.fixtureId },
        include: { team1: true, team2: true }
      });

      if (!fixture) {
        throw new NotFoundException(`Fixture with ID '${input.fixtureId}' not found`);
      }

      if (fixture.status !== MatchStatus.LIVE && fixture.status !== MatchStatus.PAUSED) {
        throw new BadRequestException('Score events can be recorded only while the match is live or paused (LIVE or PAUSED).');
      }

      if (input.teamId !== fixture.team1Id && input.teamId !== fixture.team2Id) {
        throw new BadRequestException(
          `Team '${input.teamId}' is not a participant in fixture '${input.fixtureId}'.`
        );
      }

      const scoreDelta = input.scoreDelta ?? 1;

      // 1. Create match event record
      await tx.matchEvent.create({
        data: {
          fixtureId: input.fixtureId,
          teamId: input.teamId,
          eventType: input.eventType,
          scoreDelta,
          notes: input.notes ? `[${loggedBy}] ${input.notes}` : `Logged by ${loggedBy}`
        }
      });

      // 2. Adjust scores if GOAL event
      let team1Score = fixture.team1Score;
      let team2Score = fixture.team2Score;

      if (input.eventType === MatchEventType.GOAL) {
        if (input.teamId === fixture.team1Id) {
          team1Score += scoreDelta;
        } else if (input.teamId === fixture.team2Id) {
          team2Score += scoreDelta;
        }
      }

      let winnerId: string | null = null;
      if (team1Score > team2Score) {
        winnerId = fixture.team1Id;
      } else if (team2Score > team1Score) {
        winnerId = fixture.team2Id;
      }

      const updated = await tx.fixture.update({
        where: { id: input.fixtureId },
        data: {
          team1Score,
          team2Score,
          winnerId
        },
        include: {
          arena: true,
          category: true,
          team1: { select: { id: true, name: true, code: true, institutionName: true } },
          team2: { select: { id: true, name: true, code: true, institutionName: true } },
          events: { orderBy: { timestamp: 'asc' }, take: MAX_FIXTURE_EVENTS }
        }
      });

      return this.formatFixture(updated);
    });
  }

  async getRankingsByCategory(categoryId: string) {
    const teams = await this.prisma.team.findMany({
      // Public endpoint: only teams approved for public display with an approved (or later) entry, the same
      // rule GET /teams/:id applies, so draft, rejected or withdrawn teams are never listed.
      where: {
        isApprovedPublic: true,
        registrations: {
          some: { categoryId, status: { in: POST_APPROVAL_STATUSES as any } }
        }
      },
      select: { id: true, name: true, institutionName: true },
      take: MAX_RANKING_TEAMS
    });

    const fixtures = await this.prisma.fixture.findMany({
      where: {
        categoryId,
        status: { in: [MatchStatus.COMPLETED, MatchStatus.VERIFIED] }
      },
      select: { team1Id: true, team2Id: true, team1Score: true, team2Score: true },
      take: MAX_RANKING_FIXTURES
    });

    const statsMap: Record<string, any> = {};

    for (const team of teams) {
      statsMap[team.id] = {
        id: `rnk-${team.id}`,
        categoryId,
        teamId: team.id,
        teamName: team.name,
        institutionName: team.institutionName,
        played: 0,
        won: 0,
        lost: 0,
        drawn: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        goalDiff: 0,
        points: 0,
        rank: 0
      };
    }

    for (const f of fixtures) {
      const t1 = statsMap[f.team1Id];
      const t2 = statsMap[f.team2Id];
      if (t1 && t2) {
        t1.played++;
        t2.played++;
        t1.goalsFor += f.team1Score;
        t1.goalsAgainst += f.team2Score;
        t2.goalsFor += f.team2Score;
        t2.goalsAgainst += f.team1Score;

        if (f.team1Score > f.team2Score) {
          t1.won++;
          t1.points += 3;
          t2.lost++;
        } else if (f.team2Score > f.team1Score) {
          t2.won++;
          t2.points += 3;
          t1.lost++;
        } else {
          t1.drawn++;
          t2.drawn++;
          t1.points += 1;
          t2.points += 1;
        }
      }
    }

    const rankings = Object.values(statsMap);
    for (const r of rankings) {
      r.goalDiff = r.goalsFor - r.goalsAgainst;
    }

    rankings.sort((a, b) => b.points - a.points || b.goalDiff - a.goalDiff || b.goalsFor - a.goalsFor);
    rankings.forEach((r, idx) => {
      r.rank = idx + 1;
    });

    return rankings;
  }

  private formatFixture(f: any) {
    return {
      id: f.id,
      categoryId: f.categoryId,
      arenaId: f.arenaId,
      arenaName: f.arena?.name,
      matchNumber: f.matchNumber,
      stage: f.stage,
      team1Id: f.team1Id,
      team2Id: f.team2Id,
      team1Name: f.team1?.name || 'TBD',
      team2Name: f.team2?.name || 'TBD',
      team1Code: f.team1?.code,
      team2Code: f.team2?.code,
      team1Score: f.team1Score,
      team2Score: f.team2Score,
      currentSet: f.currentSet,
      winnerId: f.winnerId,
      status: f.status,
      scheduledStart: f.scheduledStart ? f.scheduledStart.toISOString() : null,
      categoryName: f.category?.name,
      events: f.events || []
    };
  }
}

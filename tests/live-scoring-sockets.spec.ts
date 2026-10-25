import { WsException } from '@nestjs/websockets';
import { ScoringGateway } from '../apps/api/src/scoring/scoring.gateway';
import { MatchEventType, MatchStatus, UserRole } from '@gcdis/shared';

describe('Live Scoring & WebSocket Security (Execution Engine)', () => {
  let scoringGateway: ScoringGateway;
  let mockCompetitionService: any;
  let mockJwt: any;
  let fixturesDb: Map<string, any>;

  beforeEach(() => {
    fixturesDb = new Map();

    fixturesDb.set('fix-1', {
      id: 'fix-1',
      matchNumber: 1,
      status: MatchStatus.LIVE,
      team1Id: 't-1',
      team2Id: 't-2',
      team1Score: 0,
      team2Score: 0,
      winnerId: null
    });

    mockCompetitionService = {
      findFixtureById: jest.fn(async (fixtureId: string) => fixturesDb.get(fixtureId) || null),
      logMatchEvent: jest.fn(async ({ fixtureId, teamId, eventType, scoreDelta }) => {
        const fixture = fixturesDb.get(fixtureId);
        if (!fixture) throw new Error('Fixture not found');
        if (fixture.team1Id === teamId) fixture.team1Score += scoreDelta;
        if (fixture.team2Id === teamId) fixture.team2Score += scoreDelta;
        return fixture;
      }),
      recordScoreEvent: jest.fn(async ({ fixtureId, teamId, eventType, scoreDelta }) => {
        const fixture = fixturesDb.get(fixtureId);
        if (!fixture) throw new Error('Fixture not found');
        if (fixture.team1Id === teamId) fixture.team1Score += scoreDelta;
        if (fixture.team2Id === teamId) fixture.team2Score += scoreDelta;
        const event = { id: `evt-${Date.now()}`, fixtureId, teamId, eventType, scoreDelta, createdAt: new Date() };
        return { fixture, event };
      })
    };

    mockJwt = {
      verify: jest.fn((token) => {
        if (token === 'valid_referee_token') {
          return { sub: 'judge-1', sid: 'sess-judge', role: UserRole.JUDGE, email: 'judge@gcdis.org' };
        }
        if (token === 'captain_token') {
          return { sub: 'captain-1', sid: 'sess-cap', role: UserRole.TEAM_CAPTAIN, email: 'captain@test.com' };
        }
        throw new Error('Invalid JWT');
      })
    };

    scoringGateway = new ScoringGateway(mockCompetitionService as any, mockJwt as any);
    scoringGateway.server = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      emit: jest.fn()
    } as any;
  });

  test('1. Unauthenticated or invalid socket client is rejected with WsException', async () => {
    const unauthenticatedSocket: any = {
      id: 'sock-anon',
      handshake: { headers: {} }
    };

    await expect(
      scoringGateway.handleScoreEvent(
        {
          fixtureId: 'fix-1',
          teamId: 't-1',
          eventType: MatchEventType.GOAL,
          scoreDelta: 1
        },
        unauthenticatedSocket
      )
    ).rejects.toThrow(WsException);
  });

  test('2. Non-referee role (e.g. TEAM_CAPTAIN) is forbidden from emitting score events', async () => {
    const captainSocket: any = {
      id: 'sock-captain',
      handshake: {
        headers: {
          cookie: 'gcdis_admin_access_token=captain_token'
        }
      }
    };

    await expect(
      scoringGateway.handleScoreEvent(
        {
          fixtureId: 'fix-1',
          teamId: 't-1',
          eventType: MatchEventType.GOAL,
          scoreDelta: 1
        },
        captainSocket
      )
    ).rejects.toThrow(WsException);
  });

  test('3. Authorized judge successfully submits GOAL and emits to isolated match room', async () => {
    const refereeSocket: any = {
      id: 'sock-referee',
      handshake: {
        headers: {
          cookie: 'gcdis_admin_access_token=valid_referee_token'
        }
      }
    };

    const res = await scoringGateway.handleScoreEvent(
      {
        fixtureId: 'fix-1',
        teamId: 't-1',
        eventType: MatchEventType.GOAL,
        scoreDelta: 1
      },
      refereeSocket
    );

    expect(res.fixture.team1Score).toBe(1);
    expect(scoringGateway.server.to).toHaveBeenCalledWith('match_fix-1');
    expect(scoringGateway.server.to).toHaveBeenCalledWith('public_summary');
  });

  test('4. Public spectator client joins match room for read-only telemetry', async () => {
    const spectatorSocket: any = {
      id: 'spectator-1',
      join: jest.fn()
    };

    const joinRes = await scoringGateway.handleJoinRoom({ fixtureId: 'fix-1' }, spectatorSocket);
    expect(joinRes?.status).toBe('joined');
    expect(spectatorSocket.join).toHaveBeenCalledWith('match_fix-1');
  });
});

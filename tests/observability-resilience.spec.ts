import { RequestIdMiddleware } from '../apps/api/src/common/middleware/request-id.middleware';
import { AppController } from '../apps/api/src/app.controller';
import { CompetitionController } from '../apps/api/src/competition/competition.controller';

describe('Observability, Health & Telemetry Polling (Execution Engine)', () => {
  test('1. RequestIdMiddleware injects or propagates x-request-id on req and res', () => {
    const middleware = new RequestIdMiddleware();
    const req: any = {
      headers: {},
      method: 'GET',
      originalUrl: '/api/health',
      socket: { remoteAddress: '127.0.0.1' }
    };
    const resHeaders: Record<string, string> = {};
    const res: any = {
      setHeader: jest.fn((k, v) => {
        resHeaders[k.toLowerCase()] = v;
      }),
      on: jest.fn(),
      statusCode: 200
    };
    const next = jest.fn();

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.headers['x-request-id']).toBeDefined();
    expect(req.headers['x-request-id']).toMatch(/^req_/);
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', req.headers['x-request-id']);
  });

  test('2a. Public /health returns only {status: "ok"} when the database answers (QA L9)', async () => {
    const mockPrisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }])
    };

    const controller = new AppController(mockPrisma);
    const health: any = await controller.getHealthStatus();

    expect(health).toEqual({ status: 'ok' });
    expect(JSON.stringify(health)).not.toContain(process.version);
  });

  test('2. AppController getDetailedHealth (admin-only /health/details) returns health metrics', async () => {
    const mockPrisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }])
    };

    const controller = new AppController(mockPrisma);
    const health = await controller.getDetailedHealth();

    expect(health.status).toBe('healthy');
    expect(health.services.database.status).toBe('healthy');
    expect(health.services.api.status).toBe('healthy');
    expect(health.services.api.memoryHeapMb).toBeGreaterThan(0);
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  test('3. AppController returns degraded health when database is unreachable', async () => {
    const mockPrisma: any = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('Connection refused to postgres:5432'))
    };

    const controller = new AppController(mockPrisma);
    const health = await controller.getDetailedHealth();

    expect(health.status).toBe('degraded');
    expect(health.services.database.status).toBe('unhealthy');
    expect(JSON.stringify(health)).not.toContain('Connection refused');

    const res: any = { status: jest.fn(), setHeader: jest.fn() };
    const publicHealth = await controller.getHealthStatus(res);
    expect(publicHealth).toEqual({ status: 'degraded' });
    expect(res.status).toHaveBeenCalledWith(503);
    expect(JSON.stringify(publicHealth)).not.toContain('Connection refused');
  });

  test('4. CompetitionController getFixtureLivePolling sets Cache-Control and pollingIntervalMs', async () => {
    const mockCompetitionService: any = {
      findFixtureById: jest.fn().mockResolvedValue({
        id: 'fix-1',
        matchNumber: 1,
        team1Score: 2,
        team2Score: 1,
        status: 'LIVE'
      })
    };

    const compController = new CompetitionController(mockCompetitionService);
    const resHeaders: Record<string, string> = {};
    const mockRes: any = {
      setHeader: jest.fn((k, v) => {
        resHeaders[k.toLowerCase()] = v;
      })
    };

    const pollingData = await compController.getFixtureLivePolling('fix-1', mockRes);

    expect(pollingData.fixture.id).toBe('fix-1');
    expect(pollingData.pollingIntervalMs).toBe(3000);
    expect(mockRes.setHeader).toHaveBeenCalledWith('Cache-Control', 'public, max-age=2, stale-while-revalidate=1');
  });
});

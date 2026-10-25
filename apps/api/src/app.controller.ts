import { Controller, Get, HttpStatus, Logger, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Response } from 'express';
import { UserRole } from '@gcdis/shared';
import { PrismaService } from './prisma/prisma.service';
import { Public } from './common/decorators/public.decorator';
import { RolesGuard } from './auth/roles.guard';
import { Roles } from './auth/roles.decorator';
import { AccountIpRateLimiterGuard, SkipDefaultRateLimit } from './common/guards/rate-limiter.guard';

/** Upper bound for each dependency probe of the public health check. */
export const HEALTH_PROBE_TIMEOUT_MS = 2000;

/** Rejects after `ms` milliseconds unless `promise` settles first; the timer never outlives the race. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);
  /** Concurrent public health probes share one in-flight dependency check (keeps the endpoint cheap). */
  private inFlightReadiness: Promise<boolean> | null = null;

  constructor(private prisma: PrismaService) {}

  /** Root of the API: a bare liveness answer. No version, uptime or endpoint map (information leak). */
  @Public()
  @Get()
  getRoot() {
    return { status: 'ok' };
  }

  private async probeDatabase(): Promise<{ dbStatus: 'healthy' | 'unhealthy'; dbLatencyMs: number }> {
    try {
      const start = Date.now();
      await withTimeout(Promise.resolve().then(() => this.prisma.$queryRaw`SELECT 1`), HEALTH_PROBE_TIMEOUT_MS);
      return { dbStatus: 'healthy', dbLatencyMs: Date.now() - start };
    } catch (err: any) {
      // Never echo driver errors (hostnames, credentials, SQL) to clients
      this.logger.error(`Health check database probe failed: ${err?.message}`);
      return { dbStatus: 'unhealthy', dbLatencyMs: 0 };
    }
  }

  /** True when the database answers and Redis is either not configured or answers PING. */
  private async checkReadiness(): Promise<boolean> {
    const [{ dbStatus }, redis] = await Promise.all([
      this.probeDatabase(),
      AccountIpRateLimiterGuard.redisHealth(HEALTH_PROBE_TIMEOUT_MS)
    ]);
    if (redis === 'down') this.logger.warn('Health check: Redis is configured but did not answer PING.');
    return dbStatus === 'healthy' && redis !== 'down';
  }

  /**
   * Public readiness probe (container healthchecks, load balancers): 200 {status:'ok'} when the database (and
   * Redis, when configured) answer, otherwise 503 {status:'degraded'}. No component names, errors or hostnames.
   */
  // Probes from the load balancer / orchestrator must never be throttled (no default rate limit)
  @Public()
  @SkipDefaultRateLimit()
  @Get('health')
  async getHealthStatus(@Res({ passthrough: true }) res?: Response) {
    if (!this.inFlightReadiness) {
      this.inFlightReadiness = this.checkReadiness().finally(() => {
        this.inFlightReadiness = null;
      });
    }
    const healthy = await this.inFlightReadiness;
    res?.setHeader?.('Cache-Control', 'no-store');
    if (!healthy) {
      res?.status?.(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'degraded' };
    }
    return { status: 'ok' };
  }

  /** Detailed runtime health (node version, memory, DB latency): SUPER_ADMIN sessions only. */
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Get('health/details')
  async getDetailedHealth() {
    const { dbStatus, dbLatencyMs } = await this.probeDatabase();
    const memory = process.memoryUsage();

    return {
      status: dbStatus === 'healthy' ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      services: {
        database: {
          status: dbStatus,
          latencyMs: dbLatencyMs,
          engine: 'PostgreSQL 16 (PgBouncer ready)'
        },
        api: {
          status: 'healthy',
          nodeVersion: process.version,
          memoryHeapMb: Number((memory.heapUsed / (1024 * 1024)).toFixed(2)),
          memoryRssMb: Number((memory.rss / (1024 * 1024)).toFixed(2))
        }
      }
    };
  }
}

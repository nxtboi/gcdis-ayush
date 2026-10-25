import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  SetMetadata,
  Logger
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

let RedisClass: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  RedisClass = require('ioredis');
} catch {
  // Fallback to in-memory store
}

export const RATE_LIMIT_KEY = 'RATE_LIMIT_RULE';

export interface RateLimitRule {
  points: number; // Max requests allowed
  duration: number; // Window in seconds
  isStrictAuth?: boolean;
  /**
   * Second limit keyed on the client IP alone, e.g. forgot-password: "3 per hour per email AND per IP".
   * The primary limit stays keyed on account + IP. Strict auth routes always get a per-IP bucket
   * (default STRICT_AUTH_DEFAULT_IP_MULTIPLIER x points) even when this is not set.
   */
  ipPoints?: number;
  /** Window (seconds) of the per-IP limit; defaults to `duration`. */
  ipDuration?: number;
  /**
   * Opt-in: key the account part of the bucket on this (normalised) body field when the request is
   * not authenticated. Only for routes whose body legitimately names the account (login,
   * forgot-password, register). Every other route ignores the body, so an attacker-chosen extra
   * `email` field can never mint a fresh bucket.
   */
  accountFromBody?: 'email';
  /** Optional formal message for this route; '{wait}' is replaced with the remaining wait time. */
  message?: string;
}

export const RateLimit = (rule: RateLimitRule) => SetMetadata(RATE_LIMIT_KEY, rule);

interface BucketEntry {
  count: number;
  resetAt: number;
}

const PRUNE_INTERVAL_SECONDS = 60;
/** Hard cap on in-memory buckets; expired entries are pruned first, then oldest entries evicted. */
const MAX_MEMORY_BUCKETS = 100_000;
/** Strict-auth routes always also consume a per-IP bucket; its default size is this multiple of `points`. */
export const STRICT_AUTH_DEFAULT_IP_MULTIPLIER = 3;

/** Human-friendly wait time for rate-limit messages ("45 seconds", "about 10 minutes"). */
function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return `about ${minutes} minutes`;
}

@Injectable()
export class AccountIpRateLimiterGuard implements CanActivate {
  // In-memory bucket store as resilient fallback when Redis is offline
  private static memoryStore: Map<string, BucketEntry> = new Map();
  private static redisClient: any = null;
  private static isRedisConnected = false;
  private static lastPruneAt = 0;
  private static redisWarningLogged = false;
  private static readonly logger = new Logger('AccountIpRateLimiterGuard');

  constructor(private reflector: Reflector) {
    AccountIpRateLimiterGuard.ensureClient();
  }

  /** Lazily creates the shared Redis client (once per process) when REDIS_URL is configured. */
  static ensureClient(): void {
    if (!AccountIpRateLimiterGuard.redisClient && RedisClass && process.env.REDIS_URL) {
      try {
        const RedisConstructor = RedisClass?.default || RedisClass;
        const redisUrl = process.env.REDIS_URL;
        const client = new RedisConstructor(redisUrl, {
          maxRetriesPerRequest: 1,
          connectTimeout: 1000,
          retryStrategy: (times: number) => {
            if (times > 3) return null; // Stop retrying after 3 attempts
            return Math.min(times * 500, 2000);
          },
          lazyConnect: true
        });

        client.connect().then(() => {
          AccountIpRateLimiterGuard.isRedisConnected = true;
        }).catch(() => {
          AccountIpRateLimiterGuard.isRedisConnected = false;
          AccountIpRateLimiterGuard.warnRedisUnavailable();
        });

        client.on('error', () => {
          AccountIpRateLimiterGuard.isRedisConnected = false;
          AccountIpRateLimiterGuard.warnRedisUnavailable();
        });

        client.on('connect', () => {
          AccountIpRateLimiterGuard.isRedisConnected = true;
        });

        AccountIpRateLimiterGuard.redisClient = client;
      } catch (err) {
        AccountIpRateLimiterGuard.isRedisConnected = false;
        AccountIpRateLimiterGuard.warnRedisUnavailable();
      }
    } else if (!RedisClass && process.env.REDIS_URL) {
      AccountIpRateLimiterGuard.warnRedisUnavailable();
    }
  }

  /** The connected Redis client, or null (memory fallback). */
  private static redis(): any | null {
    AccountIpRateLimiterGuard.ensureClient();
    return AccountIpRateLimiterGuard.isRedisConnected && AccountIpRateLimiterGuard.redisClient
      ? AccountIpRateLimiterGuard.redisClient
      : null;
  }

  /** Logs (once per process) that rate limiting degraded to per-instance memory buckets. Never throws. */
  private static warnRedisUnavailable(): void {
    if (AccountIpRateLimiterGuard.redisWarningLogged) return;
    if (process.env.NODE_ENV !== 'production') return;
    AccountIpRateLimiterGuard.redisWarningLogged = true;
    AccountIpRateLimiterGuard.logger.warn(
      'Redis is configured but unavailable: rate limiting has fallen back to per-instance in-memory buckets.'
    );
  }

  /** Removes expired buckets (at most once per PRUNE_INTERVAL_SECONDS) and enforces a hard size cap. */
  static pruneMemoryStore(nowSeconds: number, force = false): void {
    const store = AccountIpRateLimiterGuard.memoryStore;
    if (!force && nowSeconds - AccountIpRateLimiterGuard.lastPruneAt < PRUNE_INTERVAL_SECONDS && store.size < MAX_MEMORY_BUCKETS) {
      return;
    }
    AccountIpRateLimiterGuard.lastPruneAt = nowSeconds;
    for (const [key, bucket] of store) {
      if (nowSeconds >= bucket.resetAt) store.delete(key);
    }
    // Still over the cap: evict oldest-inserted entries (Map preserves insertion order)
    if (store.size >= MAX_MEMORY_BUCKETS) {
      const excess = store.size - MAX_MEMORY_BUCKETS + 1;
      let removed = 0;
      for (const key of store.keys()) {
        if (removed >= excess) break;
        store.delete(key);
        removed++;
      }
    }
  }

  /**
   * Readiness probe for the shared Redis store (used by GET /api/health):
   * - 'not_configured': REDIS_URL is unset (in-memory buckets are the intended mode, e.g. local development),
   *   or the ioredis client library is not installed, so the app never talks to Redis;
   * - 'up': PING answered within `timeoutMs`;
   * - 'down': REDIS_URL is set but the server did not answer in time (or the client could not be created).
   * Never throws and never reports error details.
   */
  static async redisHealth(timeoutMs = 2000): Promise<'not_configured' | 'up' | 'down'> {
    if (!process.env.REDIS_URL) return 'not_configured';
    if (!RedisClass) return 'not_configured';
    AccountIpRateLimiterGuard.ensureClient();
    const client = AccountIpRateLimiterGuard.redisClient;
    if (!client) return 'down';
    // The retry strategy gives up after a few attempts; let a health probe start a fresh connection attempt
    if (client.status === 'end') {
      client.connect().catch(() => undefined);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const reply = await Promise.race([
        Promise.resolve().then(() => client.ping()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        })
      ]);
      return reply === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Test/diagnostic helper. */
  static memoryBucketCount(): number {
    return AccountIpRateLimiterGuard.memoryStore.size;
  }

  /** Test/diagnostic helper: number of in-memory keys with the given prefix. */
  static memoryKeyCount(prefix: string): number {
    let n = 0;
    for (const key of AccountIpRateLimiterGuard.memoryStore.keys()) if (key.startsWith(prefix)) n++;
    return n;
  }

  /** Test helper: drops every in-memory bucket. */
  static resetMemoryStore(): void {
    AccountIpRateLimiterGuard.memoryStore.clear();
  }

  // --- Shared counter store (Redis when connected, per-instance memory otherwise) -------------
  // Other security counters (2FA attempt lockout, per-account password-login lock) use these so
  // they survive API restarts and are shared across replicas whenever Redis is available.

  /**
   * Increments a counter. `ttlSeconds` is applied when the counter is created, or on every hit when
   * `slidingTtl` is set. Returns the new count and its remaining lifetime in seconds.
   */
  static async incrementCounter(key: string, ttlSeconds: number, slidingTtl = false): Promise<{ count: number; ttl: number }> {
    const client = AccountIpRateLimiterGuard.redis();
    if (client) {
      try {
        const count = await client.incr(key);
        if (count === 1 || slidingTtl) await client.expire(key, ttlSeconds);
        const ttl = await client.ttl(key);
        return { count, ttl: ttl > 0 ? ttl : ttlSeconds };
      } catch {
        // Redis glitch: fall through to memory
      }
    }
    const now = Math.floor(Date.now() / 1000);
    AccountIpRateLimiterGuard.pruneMemoryStore(now);
    const store = AccountIpRateLimiterGuard.memoryStore;
    let bucket = store.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + ttlSeconds };
      store.set(key, bucket);
    }
    bucket.count += 1;
    if (slidingTtl) bucket.resetAt = now + ttlSeconds;
    return { count: bucket.count, ttl: bucket.resetAt - now };
  }

  /** Stores a value with a fixed lifetime (e.g. a lock flag). */
  static async setCounter(key: string, value: number, ttlSeconds: number): Promise<void> {
    const client = AccountIpRateLimiterGuard.redis();
    if (client) {
      try {
        await client.set(key, String(value), 'EX', ttlSeconds);
        return;
      } catch {
        // Redis glitch: fall through to memory
      }
    }
    const now = Math.floor(Date.now() / 1000);
    AccountIpRateLimiterGuard.pruneMemoryStore(now);
    AccountIpRateLimiterGuard.memoryStore.set(key, { count: value, resetAt: now + ttlSeconds });
  }

  /** Current value and remaining lifetime (seconds) of a counter, or null when absent or expired. */
  static async readCounter(key: string): Promise<{ count: number; ttl: number } | null> {
    const client = AccountIpRateLimiterGuard.redis();
    if (client) {
      try {
        const raw = await client.get(key);
        if (raw === null || raw === undefined) return null;
        const ttl = await client.ttl(key);
        return { count: Number(raw) || 0, ttl: ttl > 0 ? ttl : 1 };
      } catch {
        // Redis glitch: fall through to memory
      }
    }
    const now = Math.floor(Date.now() / 1000);
    AccountIpRateLimiterGuard.pruneMemoryStore(now);
    const bucket = AccountIpRateLimiterGuard.memoryStore.get(key);
    if (!bucket || now >= bucket.resetAt) return null;
    return { count: bucket.count, ttl: bucket.resetAt - now };
  }

  /** Removes counters (from Redis and from the memory fallback). */
  static async deleteCounters(...keys: string[]): Promise<void> {
    for (const key of keys) AccountIpRateLimiterGuard.memoryStore.delete(key);
    const client = AccountIpRateLimiterGuard.redis();
    if (client && keys.length > 0) {
      try {
        await client.del(...keys);
      } catch {
        // Non-fatal
      }
    }
  }

  /**
   * Account part of the bucket key: the authenticated user, else the request body field the route
   * explicitly opted into (accountFromBody), else 'anonymous' (the bucket is then per IP + route).
   */
  static accountKey(req: any, rule: RateLimitRule): string {
    if (req?.user?.id) return `user:${req.user.id}`;
    if (rule.accountFromBody === 'email') {
      const rawEmail = req?.body?.email;
      if (typeof rawEmail === 'string' && rawEmail.trim()) {
        return `email:${rawEmail.trim().toLowerCase().slice(0, 254)}`;
      }
    }
    return 'anonymous';
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<RateLimitRule>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass()
    ]) || {
      // Default: Generous limit for shared campus NAT IPs (600 req/min)
      points: 600,
      duration: 60,
      isStrictAuth: false
    };

    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    // Real client IP comes from req.ip only: Express 'trust proxy' already resolves X-Forwarded-For
    // for trusted hops. Reading the header directly would let clients spoof their bucket.
    const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
    const accountId = AccountIpRateLimiterGuard.accountKey(req, rule);
    const route = req.route?.path || String(req.originalUrl || req.url || '').split('?')[0];

    const bucketKey = `ratelimit:${rule.isStrictAuth ? 'auth:' : 'api:'}${accountId}:${clientIp}:${route}`;
    await this.consume(bucketKey, rule.points, rule.duration, !!rule.isStrictAuth, res, rule.message);

    // Pure per-IP bucket: always on strict auth routes (default 3x points), opt-in elsewhere
    const ipPoints =
      rule.ipPoints && rule.ipPoints > 0
        ? rule.ipPoints
        : rule.isStrictAuth
        ? rule.points * STRICT_AUTH_DEFAULT_IP_MULTIPLIER
        : 0;
    if (ipPoints > 0) {
      const ipDuration = rule.ipDuration && rule.ipDuration > 0 ? rule.ipDuration : rule.duration;
      await this.consume(`ratelimit:ip:${clientIp}:${route}`, ipPoints, ipDuration, !!rule.isStrictAuth, res, rule.message);
    }
    return true;
  }

  /** Counts one hit against a bucket; throws 429 once the bucket exceeds its points. */
  private async consume(
    bucketKey: string,
    points: number,
    duration: number,
    isStrictAuth: boolean,
    res: any,
    customMessage?: string
  ): Promise<void> {
    return AccountIpRateLimiterGuard.consumeBucket(bucketKey, points, duration, isStrictAuth, res, customMessage);
  }

  /**
   * Counts one hit against a bucket (shared store) and throws the standard 429 (with Retry-After) once
   * the bucket exceeds its points. Shared by this guard and DefaultApiRateLimitGuard.
   */
  static async consumeBucket(
    bucketKey: string,
    points: number,
    duration: number,
    isStrictAuth: boolean,
    res: any,
    customMessage?: string
  ): Promise<void> {
    const { count, ttl } = await AccountIpRateLimiterGuard.incrementCounter(bucketKey, duration);
    if (count <= points) return;

    const retryAfter = ttl > 0 ? ttl : duration;
    res?.setHeader?.('Retry-After', String(retryAfter));

    const message = customMessage
      ? customMessage.replace('{wait}', formatWait(retryAfter))
      : isStrictAuth
      ? `Too many authentication attempts on this account. Please wait ${formatWait(retryAfter)} before retrying.`
      : `Rate limit threshold exceeded. Please retry after ${formatWait(retryAfter)}.`;

    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message,
        retryAfterSeconds: retryAfter
      },
      HttpStatus.TOO_MANY_REQUESTS
    );
  }
}

// --- App-wide default limit ----------------------------------------------------------------------

/** Default app-wide limit (requests per minute per client IP) for routes without their own @RateLimit. */
export const DEFAULT_API_RATE_LIMIT_PER_MIN = 300;
/** Window of the app-wide default limit, in seconds. */
export const DEFAULT_API_RATE_LIMIT_WINDOW_SECONDS = 60;
export const SKIP_DEFAULT_RATE_LIMIT_KEY = 'SKIP_DEFAULT_RATE_LIMIT';

/**
 * Exempts a route (or controller) from the app-wide default limit. Only for endpoints that must never be
 * throttled (health probes, the Razorpay webhook whose retries must always be accepted). A route with its
 * own @RateLimit is already excluded from the default and keeps exactly its own rule.
 */
export const SkipDefaultRateLimit = () => SetMetadata(SKIP_DEFAULT_RATE_LIMIT_KEY, true);

/**
 * API_DEFAULT_RATE_LIMIT_PER_MIN (positive integer), else DEFAULT_API_RATE_LIMIT_PER_MIN. Read per request,
 * so tests and operators can change it without rebuilding the guard.
 */
export function defaultApiRateLimitPerMinute(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.API_DEFAULT_RATE_LIMIT_PER_MIN ?? '').trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_API_RATE_LIMIT_PER_MIN;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_API_RATE_LIMIT_PER_MIN;
}

/**
 * Global (APP_GUARD) default rate limit: every HTTP route without its own @RateLimit (and without
 * @SkipDefaultRateLimit) shares one bucket per client IP of API_DEFAULT_RATE_LIMIT_PER_MIN requests per
 * minute. Routes that declare @RateLimit are skipped here, so their own AccountIpRateLimiterGuard rule
 * applies alone: no double counting and no loosening. Keyed on req.ip only (Express 'trust proxy' resolves
 * X-Forwarded-For for trusted hops); 429 carries Retry-After and the standard error body.
 * WebSocket / RPC contexts are not affected (the scoring gateway has its own connection limits).
 */
@Injectable()
export class DefaultApiRateLimitGuard implements CanActivate {
  constructor(private reflector: Reflector) {
    AccountIpRateLimiterGuard.ensureClient();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_DEFAULT_RATE_LIMIT_KEY, targets)) return true;
    if (this.reflector.getAllAndOverride<RateLimitRule>(RATE_LIMIT_KEY, targets)) return true;

    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const clientIp = req?.ip || req?.socket?.remoteAddress || 'unknown';
    await AccountIpRateLimiterGuard.consumeBucket(
      `ratelimit:default:${clientIp}`,
      defaultApiRateLimitPerMinute(),
      DEFAULT_API_RATE_LIMIT_WINDOW_SECONDS,
      false,
      res
    );
    return true;
  }
}

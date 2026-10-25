import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  MessageBody,
  ConnectedSocket,
  WsException
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getAdminJwtSecret } from '../auth/jwt-secrets';
import { adminAccessTokenFromCookieHeader } from '../auth/session-cookies.util';
import { CompetitionService } from '../competition/competition.service';
import { PrismaService } from '../prisma/prisma.service';
import { MatchEventLogInput, MatchEventType, UserRole } from '@gcdis/shared';
import { z } from 'zod';
import { resolveTrustProxy } from '../common/utils/trust-proxy.util';

// proxy-addr ships with Express (no bundled types): resolves the client address behind trusted proxies
// eslint-disable-next-line @typescript-eslint/no-var-requires
const proxyaddr: any = require('proxy-addr');

/** Largest accepted socket.io message / HTTP long-polling body (bytes). */
export const WS_MAX_HTTP_BUFFER_SIZE = 16 * 1024;
/** Default cap on concurrent connections per client IP (WS_MAX_CONNECTIONS_PER_IP). */
export const WS_DEFAULT_MAX_CONNECTIONS_PER_IP = 20;
/** Default cap on rooms one socket may be subscribed to (WS_MAX_ROOMS_PER_SOCKET). */
export const WS_DEFAULT_MAX_ROOMS_PER_SOCKET = 10;
/** Room join / leave requests allowed per socket within WS_SUBSCRIPTION_WINDOW_MS. */
export const WS_MAX_SUBSCRIPTION_OPS = 20;
export const WS_SUBSCRIPTION_WINDOW_MS = 10_000;
/** Connection activity is summarised in the log at most once per this interval (never once per connection). */
export const WS_LOG_SUMMARY_INTERVAL_MS = 60_000;
/** Fixture ids are UUIDs (or short slugs in fixtures); anything else never names a room. */
const FIXTURE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = String(process.env[name] ?? '').trim();
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** Same semantics as Express's compileTrust, fed from TRUST_PROXY (resolveTrustProxy). */
function compileTrust(val: boolean | number | string): (addr: string, i: number) => boolean {
  if (val === true) return () => true;
  if (typeof val === 'number') return (_a: string, i: number) => i < val;
  if (typeof val === 'string') return proxyaddr.compile(val.split(',').map((v) => v.trim()));
  return proxyaddr.compile([]);
}

export const ScoreEventSchema = z.object({
  fixtureId: z.string().min(1, 'fixtureId is required'),
  teamId: z.string().min(1, 'teamId is required'),
  eventType: z.nativeEnum(MatchEventType),
  scoreDelta: z.number().int().min(0).max(100).default(1),
  notes: z.string().max(500).optional()
});

@WebSocketGateway({
  cors: {
    origin: (origin: string, callback: (err: Error | null, success: boolean) => void) => {
      const allowedOrigins = [
        process.env.PUBLIC_SITE_URL || 'http://localhost:3000',
        process.env.ADMIN_SITE_URL || 'http://localhost:3001',
        process.env.PUBLIC_ORIGIN,
        process.env.ADMIN_ORIGIN
      ].filter(Boolean) as string[];

      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`WebSocket origin '${origin}' not allowed`), false);
      }
    },
    credentials: true
  },
  // A score event is well under 1 KB: refuse larger frames / polling bodies (the connection is closed)
  maxHttpBufferSize: WS_MAX_HTTP_BUFFER_SIZE
})
export class ScoringGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger('ScoringGateway');
  /** Open connections per client IP (incremented on admission, decremented on disconnect). */
  private readonly connectionsPerIp = new Map<string, number>();
  /** Rooms each socket subscribed to through this gateway, by socket id. */
  private readonly socketRooms = new Map<string, Set<string>>();
  /** Recent join / leave request times per socket id. */
  private readonly subscriptionTimestamps = new Map<string, number[]>();
  private trustFn: ((addr: string, i: number) => boolean) | null = null;
  private logStats = { connected: 0, disconnected: 0, rejected: 0, since: Date.now() };

  private eventTimestamps = new Map<string, number[]>();
  private static readonly RATE_LIMIT_WINDOW_MS = 5000;
  /** Upper bound on tracked rate-limit keys; stale keys are pruned before this is reached. */
  private static readonly MAX_RATE_LIMIT_KEYS = 10000;
  private lastPruneAt = 0;

  constructor(
    private competitionService: CompetitionService,
    private jwtService: JwtService,
    // Optional so unit tests can construct the gateway without a database; when present,
    // every score event re-validates the admin session (logout/revocation is immediate).
    @Optional() private prisma?: PrismaService
  ) {}

  /**
   * Connection admission runs as socket.io middleware, before the connection is established: a client IP
   * already holding WS_MAX_CONNECTIONS_PER_IP connections is refused at once with a `connect_error`
   * ("Too many connections", data.code TOO_MANY_CONNECTIONS), and no handler runs for it.
   */
  afterInit(server: Server) {
    server?.use?.((socket, next) => {
      if (this.admitConnection(socket)) {
        // socket.io drops a socket whose transport closed while middleware ran without a 'disconnect'
        // event; releasing on the transport's close as well keeps the per-IP count exact (release is idempotent).
        (socket as any).conn?.once?.('close', () => this.releaseConnection(socket));
        return next();
      }
      const err: Error & { data?: unknown } = new Error('Too many connections from this address');
      err.data = { code: 'TOO_MANY_CONNECTIONS' };
      next(err);
    });
  }

  static maxConnectionsPerIp(): number {
    return positiveIntFromEnv('WS_MAX_CONNECTIONS_PER_IP', WS_DEFAULT_MAX_CONNECTIONS_PER_IP);
  }

  static maxRoomsPerSocket(): number {
    return positiveIntFromEnv('WS_MAX_ROOMS_PER_SOCKET', WS_DEFAULT_MAX_ROOMS_PER_SOCKET);
  }

  /**
   * Client IP of a socket, resolved like Express req.ip: X-Forwarded-For is honoured only through hops
   * trusted by TRUST_PROXY, so a client cannot pick its own bucket and clients behind Nginx are not all
   * counted as the proxy's address.
   */
  clientIpOf(client: Socket): string {
    try {
      const req: any = (client as any)?.request;
      if (req?.headers && (req.socket || req.connection)) {
        if (!this.trustFn) this.trustFn = compileTrust(resolveTrustProxy());
        const ip = proxyaddr(req, this.trustFn);
        if (ip) return String(ip);
      }
    } catch {
      // fall through to the raw handshake address
    }
    return String(client?.handshake?.address || 'unknown');
  }

  /** Counts a new connection against its IP; false (nothing counted) when the IP is at its cap. */
  admitConnection(client: Socket): boolean {
    const ip = this.clientIpOf(client);
    const open = this.connectionsPerIp.get(ip) || 0;
    if (open >= ScoringGateway.maxConnectionsPerIp()) {
      this.logStats.rejected++;
      this.maybeLogSummary();
      return false;
    }
    this.connectionsPerIp.set(ip, open + 1);
    if (client) {
      (client as any).data = (client as any).data || {};
      (client as any).data.countedIp = ip;
    }
    return true;
  }

  /** Releases the connection slot of a socket (once; sockets that were never admitted hold none). */
  releaseConnection(client: Socket): void {
    const data = (client as any)?.data;
    const ip: string | undefined = data?.countedIp;
    if (!ip) return;
    data.countedIp = undefined;
    const open = (this.connectionsPerIp.get(ip) || 0) - 1;
    if (open > 0) this.connectionsPerIp.set(ip, open);
    else this.connectionsPerIp.delete(ip);
  }

  /** Open connections currently counted for an IP (diagnostics / tests). */
  connectionCount(ip: string): number {
    return this.connectionsPerIp.get(ip) || 0;
  }

  /** Number of IPs with open connections (diagnostics / tests). */
  trackedIpCount(): number {
    return this.connectionsPerIp.size;
  }

  handleConnection(client: Socket) {
    // Public clients can connect for read-only scoreboard subscriptions. Normally already admitted by the
    // middleware; a socket that reaches here uncounted (e.g. a server without the middleware) is counted now.
    const data = (client as any)?.data;
    if (!data?.countedIp && !this.admitConnection(client)) {
      client.emit?.('error', { message: 'Too many connections from this address', code: 'TOO_MANY_CONNECTIONS' });
      client.disconnect?.(true);
      return;
    }
    this.logStats.connected++;
    this.maybeLogSummary();
  }

  handleDisconnect(client: Socket) {
    this.releaseConnection(client);
    this.eventTimestamps.delete(client.id);
    this.socketRooms.delete(client.id);
    this.subscriptionTimestamps.delete(client.id);
    this.logStats.disconnected++;
    this.maybeLogSummary();
  }

  /**
   * Connection activity is summarised (debug level, warn when connections were refused) at most once per
   * WS_LOG_SUMMARY_INTERVAL_MS, so a connection flood cannot fill the logs.
   */
  private maybeLogSummary(now = Date.now()): void {
    if (now - this.logStats.since < WS_LOG_SUMMARY_INTERVAL_MS) return;
    const { connected, disconnected, rejected } = this.logStats;
    const message =
      `WebSocket activity in the last ${Math.round((now - this.logStats.since) / 1000)}s: ${connected} connected, ` +
      `${disconnected} disconnected, ${rejected} refused (per-IP cap); ${this.connectionsPerIp.size} client IPs connected`;
    if (rejected > 0) this.logger.warn(message);
    else this.logger.debug(message);
    this.logStats = { connected: 0, disconnected: 0, rejected: 0, since: now };
  }

  /** Per-socket rate limit of join / leave requests. */
  private checkSubscriptionRate(client: Socket): void {
    const now = Date.now();
    const recent = (this.subscriptionTimestamps.get(client.id) || []).filter((t) => now - t < WS_SUBSCRIPTION_WINDOW_MS);
    if (recent.length >= WS_MAX_SUBSCRIPTION_OPS) {
      this.subscriptionTimestamps.set(client.id, recent);
      throw new WsException('Rate limit exceeded: Too many subscription requests. Please wait before retrying.');
    }
    recent.push(now);
    this.subscriptionTimestamps.set(client.id, recent);
  }

  /** Joins a room, enforcing the per-socket room cap (re-joining a room already held is free). */
  private joinRoom(client: Socket, room: string): void {
    const rooms = this.socketRooms.get(client.id) || new Set<string>();
    if (!rooms.has(room) && rooms.size >= ScoringGateway.maxRoomsPerSocket()) {
      throw new WsException(
        `Subscription limit reached: at most ${ScoringGateway.maxRoomsPerSocket()} rooms per connection. Leave a room first.`
      );
    }
    client.join(room);
    rooms.add(room);
    this.socketRooms.set(client.id, rooms);
  }

  /**
   * Public Read-Only Match Room Subscription
   */
  @SubscribeMessage('join_match_room')
  handleJoinRoom(@MessageBody() data: { fixtureId: string }, @ConnectedSocket() client: Socket) {
    if (data && data.fixtureId) {
      this.checkSubscriptionRate(client);
      if (typeof data.fixtureId !== 'string' || !FIXTURE_ID_PATTERN.test(data.fixtureId)) {
        throw new WsException('Validation failed: invalid fixtureId');
      }
      this.joinRoom(client, `match_${data.fixtureId}`);
      return { status: 'joined', room: `match_${data.fixtureId}` };
    }
  }

  @SubscribeMessage('leave_match_room')
  handleLeaveRoom(@MessageBody() data: { fixtureId: string }, @ConnectedSocket() client: Socket) {
    if (data && data.fixtureId) {
      this.checkSubscriptionRate(client);
      if (typeof data.fixtureId !== 'string' || !FIXTURE_ID_PATTERN.test(data.fixtureId)) {
        throw new WsException('Validation failed: invalid fixtureId');
      }
      const room = `match_${data.fixtureId}`;
      client.leave(room);
      this.socketRooms.get(client.id)?.delete(room);
      return { status: 'left' };
    }
  }

  /**
   * Public Minimal Summary Channel Subscription
   */
  @SubscribeMessage('join_summary_channel')
  handleJoinSummaryChannel(@ConnectedSocket() client: Socket) {
    this.checkSubscriptionRate(client);
    this.joinRoom(client, 'public_summary');
    return { status: 'joined', room: 'public_summary' };
  }

  /**
   * Guarded Score Event:
   * 1. Authenticates from httpOnly admin cookie in handshake
   * 2. Zod-validates score_event input payload
   * 3. Verifies fixture exists and team is a participant
   * 4. Enforces socket rate-limiting
   * 5. Emits detailed update ONLY to match room + minimal public summary channel
   */
  @SubscribeMessage('score_event')
  async handleScoreEvent(
    @MessageBody() input: MatchEventLogInput,
    @ConnectedSocket() client: Socket
  ) {
    // 1. Authenticate from httpOnly cookie or handshake
    const user = this.authenticateSocket(client);
    await this.assertSessionActive(user);

    // Only authorized roles can mutate scores
    const authorizedRoles = [UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN, UserRole.JUDGE];
    if (!authorizedRoles.includes(user.role)) {
      throw new WsException('Forbidden: Only official referees and tournament admins can record match scores');
    }

    // 2. Enforce socket rate-limiting (max 10 score events per 5 seconds per caller)
    this.checkRateLimit(user.id || client.id, 10, ScoringGateway.RATE_LIMIT_WINDOW_MS);

    // 3. Zod validation of input payload
    const validationResult = ScoreEventSchema.safeParse(input);
    if (!validationResult.success) {
      const errorMsg = validationResult.error.errors.map((e) => e.message).join(', ');
      throw new WsException(`Validation failed: ${errorMsg}`);
    }
    const validatedData = validationResult.data;

    // 4. Verify fixture exists and team is an active participant
    const fixture = await this.competitionService.findFixtureById(validatedData.fixtureId);
    if (!fixture) {
      throw new WsException(`Fixture with ID '${validatedData.fixtureId}' not found`);
    }

    const team1Id = (fixture as any).team1Id || (fixture as any).team1?.id;
    const team2Id = (fixture as any).team2Id || (fixture as any).team2?.id;

    if (validatedData.teamId !== team1Id && validatedData.teamId !== team2Id) {
      throw new WsException(
        `Invalid team: Specified team '${validatedData.teamId}' is not a participant in this fixture`
      );
    }

    // 5. Mutate match state in transactional service
    const updatedFixture = await this.competitionService.logMatchEvent(
      validatedData as any,
      user.fullName || `Referee (${user.role})`
    );

    // 6. Broadcast detailed fixture ONLY to the dedicated match room
    this.server.to(`match_${validatedData.fixtureId}`).emit('match_updated', updatedFixture);

    // 7. Emit ONLY a minimal public summary to the public summary channel
    const minimalSummary = {
      fixtureId: updatedFixture.id,
      matchNumber: updatedFixture.matchNumber,
      status: updatedFixture.status,
      team1Score: updatedFixture.team1Score,
      team2Score: updatedFixture.team2Score,
      winnerId: updatedFixture.winnerId,
      lastEvent: {
        teamId: validatedData.teamId,
        eventType: validatedData.eventType,
        scoreDelta: validatedData.scoreDelta
      }
    };

    // Emitted once, to subscribers of the summary channel only (no global broadcast to every socket).
    this.server.to('public_summary').emit('summary_score_update', minimalSummary);

    return { status: 'ok', fixture: updatedFixture };
  }

  /**
   * Authenticates socket connection:
   * Prioritizes httpOnly admin cookie in handshake headers, with auth header fallback.
   */
  authenticateSocket(client: Socket): { id: string; email: string; role: UserRole; fullName: string; sid: string } {
    let token: string | undefined;

    // 1. Try parsing httpOnly admin cookie from handshake
    token = adminAccessTokenFromCookieHeader(client.handshake.headers?.cookie);

    // 2. Fallback to auth payload or Authorization header for CLI / testing
    if (!token) {
      token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '');
    }

    if (!token) {
      throw new WsException('Unauthorized: WebSocket authentication token required to record scores');
    }

    try {
      // Score submission is staff-only: verify with the admin key (same derivation as JwtStrategy)
      // and accept only session-bound admin access tokens, never 2FA challenge or public tokens.
      const secret = getAdminJwtSecret();
      const payload = this.jwtService.verify(token, { secret, audience: 'gcdis-admin', algorithms: ['HS256'] });
      if (!payload?.sub || !payload.sid || payload.type !== undefined) {
        throw new Error('Not an access token');
      }
      return {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
        fullName: payload.fullName,
        sid: payload.sid
      };
    } catch {
      throw new WsException('Unauthorized: Invalid or expired WebSocket authentication token');
    }
  }

  /**
   * Mirrors JwtStrategy: the token's session must still exist, belong to the subject, be active,
   * unrevoked and unexpired, and the user must still be active. Role is taken from the database
   * so a demoted user cannot keep scoring with an old token.
   */
  async assertSessionActive(user: { id: string; role: UserRole; fullName: string; sid: string }): Promise<void> {
    if (!this.prisma) return;
    const session = await this.prisma.session.findUnique({
      where: { id: user.sid },
      include: { user: { select: { id: true, role: true, fullName: true, isActive: true, mustChangePassword: true } } }
    });
    if (
      !session ||
      session.userId !== user.id ||
      session.revokedAt ||
      !session.isActive ||
      session.expiresAt < new Date() ||
      !session.user ||
      !session.user.isActive ||
      session.user.mustChangePassword
    ) {
      throw new WsException('Unauthorized: Session has been revoked or expired');
    }
    user.role = session.user.role as unknown as UserRole;
    user.fullName = session.user.fullName;
  }

  private pruneRateLimitKeys(now: number, windowMs: number): void {
    for (const [key, timestamps] of this.eventTimestamps) {
      if (!timestamps.length || now - timestamps[timestamps.length - 1] >= windowMs) {
        this.eventTimestamps.delete(key);
      }
    }
    this.lastPruneAt = now;
  }

  private checkRateLimit(key: string, maxEvents: number, windowMs: number): void {
    const now = Date.now();
    // Keys are user ids (not socket ids), so handleDisconnect does not clean them: prune stale ones.
    if (now - this.lastPruneAt >= windowMs || this.eventTimestamps.size >= ScoringGateway.MAX_RATE_LIMIT_KEYS) {
      this.pruneRateLimitKeys(now, windowMs);
    }
    const timestamps = (this.eventTimestamps.get(key) || []).filter((t) => now - t < windowMs);

    if (timestamps.length >= maxEvents) {
      throw new WsException('Rate limit exceeded: Too many score events sent. Please wait before retrying.');
    }

    timestamps.push(now);
    this.eventTimestamps.set(key, timestamps);
  }
}

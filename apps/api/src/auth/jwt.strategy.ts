import { Injectable, UnauthorizedException, ForbiddenException, Optional } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../prisma/prisma.service';
import { getAdminJwtSecret, getPublicJwtSecret } from './jwt-secrets';
import { accessTokenFromCookies } from './session-cookies.util';
import { isAdminIpAllowed, requestIp } from '../common/utils/ip-allowlist.util';
import { AuditService } from '../audit/audit.service';
import {
  adminIdleTimeoutMinutes,
  isPassiveRequest,
  isSessionIdle,
  LAST_SEEN_WRITE_INTERVAL_MS,
  REVOKED_IDLE_TIMEOUT,
  sessionIdleTimeoutException
} from './staff-session-policy';

/** Roles that hold staff (admin-audience) sessions. */
const STAFF_ROLES = new Set(['SUPER_ADMIN', 'EVENT_ADMIN', 'JUDGE', 'INSPECTOR']);

/**
 * Exact API paths a user with a temporary password may still call.
 * Matched against the request pathname (query string stripped), with or without the global `/api` prefix.
 */
const PASSWORD_CHANGE_ALLOWED_PATHS = new Set([
  '/auth/change-password',
  '/auth/logout',
  '/auth/logout-all',
  '/auth/me'
]);

export function isPasswordChangeAllowedPath(rawUrl: string): boolean {
  let pathname = String(rawUrl || '').split('?')[0].split('#')[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  pathname = pathname.replace(/\/+$/, '');
  if (pathname.startsWith('/api/')) {
    pathname = pathname.slice('/api'.length);
  }
  return PASSWORD_CHANGE_ALLOWED_PATHS.has(pathname);
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  fullName: string;
  aud?: string;
  sid?: string;
  mustChangePassword?: boolean;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private prisma: PrismaService,
    @Optional() private auditService?: AuditService
  ) {
    // Both throw at startup when misconfigured (JWT_ADMIN_SECRET is mandatory in production)
    const publicSecret = getPublicJwtSecret();
    const adminSecret = getAdminJwtSecret();

    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        // The calling app (Origin) decides whether the staff or the public session cookie applies
        (req: any) => accessTokenFromCookies(req)
      ]),
      ignoreExpiration: false,
      // Pinned: only HS256 tokens are ever issued, so no other algorithm is accepted
      algorithms: ['HS256'],
      passReqToCallback: true,
      secretOrKeyProvider: (_request: any, rawJwtToken: any, done: (err: any, secret?: string) => void) => {
        try {
          const decoded: any = jwt.decode(rawJwtToken);
          if (decoded && decoded.aud === 'gcdis-admin') {
            return done(null, adminSecret);
          }
          return done(null, publicSecret);
        } catch (err) {
          return done(null, publicSecret);
        }
      }
    });
  }

  async validate(req: any, payload: JwtPayload) {
    if (!payload.sub) {
      throw new UnauthorizedException('Invalid token payload: missing subject identifier');
    }

    // Only session-bound access tokens are accepted. Anything else (e.g. 2FA challenge
    // tokens, which carry a `type` claim) must never authenticate API requests.
    if (
      (payload as any).type !== undefined ||
      !payload.sid ||
      (payload.aud !== 'gcdis-admin' && payload.aud !== 'gcdis-public')
    ) {
      throw new UnauthorizedException('Invalid access token');
    }

    // 1. Session-ID check: ensures logout or session revocation takes effect immediately
    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
      include: { user: true }
    });

    if (
      !session ||
      session.userId !== payload.sub ||
      session.revokedAt ||
      !session.isActive ||
      session.expiresAt < new Date()
    ) {
      // A staff session ended by the idle timeout keeps answering with its specific code
      if (session && session.userId === payload.sub && (session as any).revokedReason === REVOKED_IDLE_TIMEOUT) {
        throw sessionIdleTimeoutException();
      }
      throw new UnauthorizedException('Session has been revoked or expired');
    }

    // 1b. Staff idle timeout (ADMIN_IDLE_TIMEOUT_MIN): no API activity for too long ends the session
    if (payload.aud === 'gcdis-admin') {
      await this.enforceStaffIdleTimeout(session as any, req);
    }

    const userFromDb: any = session.user;

    if (!userFromDb || !userFromDb.isActive) {
      throw new UnauthorizedException('User account does not exist or has been deactivated');
    }

    // 2. Server-side mustChangePassword enforcement
    const mustChangePassword = userFromDb.mustChangePassword;
    if (mustChangePassword) {
      const url = req?.originalUrl || req?.url || '';
      // Exact pathname match: `/api/teams?x=/auth/me` must NOT pass
      const isAllowedUrl = isPasswordChangeAllowedPath(url);

      if (!isAllowedUrl) {
        throw new ForbiddenException({
          error: 'PASSWORD_CHANGE_REQUIRED',
          message: 'You must change your temporary password before accessing platform resources.'
        });
      }
    }

    // 3. Staff (admin-audience) session hardening
    if (payload.aud === 'gcdis-admin') {
      // A staff session whose account is no longer a staff role is not valid any more
      if (!STAFF_ROLES.has(String(userFromDb.role))) {
        throw new UnauthorizedException('Session has been revoked or expired');
      }

      // Optional network restriction for the staff console (ADMIN_IP_ALLOWLIST)
      if (!isAdminIpAllowed(requestIp(req))) {
        throw new ForbiddenException({
          code: 'ADMIN_IP_NOT_ALLOWED',
          message: 'Access to the staff console is not permitted from this network.'
        });
      }

      // Every staff account must have two-factor authentication enabled. Sessions are only issued after
      // 2FA, but if 2FA is later reset the remaining sessions may only sign out.
      if (!userFromDb.isTwoFactorEnabled && !isPasswordChangeAllowedPath(req?.originalUrl || req?.url || '')) {
        throw new ForbiddenException({
          code: 'TWO_FACTOR_REQUIRED',
          message: 'Two-factor authentication must be enabled for this account. Sign in again to enrol.'
        });
      }
    }

    return {
      id: userFromDb.id,
      email: userFromDb.email,
      role: userFromDb.role,
      fullName: userFromDb.fullName,
      aud: payload.aud,
      sid: payload.sid,
      mustChangePassword,
      // Read by EmailVerifiedGuard (team captains must confirm their email before registering / paying)
      emailVerified: Boolean(userFromDb.emailVerifiedAt),
      // Fresh per request: read by StepUpGuard
      stepUpAt: (session as any).stepUpAt ?? null
    };
  }

  /**
   * Staff sessions: revokes the whole session family once it has been idle for longer than the idle timeout
   * (401 SESSION_IDLE_TIMEOUT), otherwise records the activity in lastSeenAt (at most once a minute, and not
   * for background requests the console marks as passive).
   */
  private async enforceStaffIdleTimeout(session: any, req: any): Promise<void> {
    const now = Date.now();
    if (isSessionIdle(session, now)) {
      const familyId = session.familyId || session.id;
      let revokedCount = 0;
      try {
        const revoked = await this.prisma.session.updateMany({
          where: { userId: session.userId, OR: [{ id: session.id }, { familyId }], revokedAt: null },
          data: { revokedAt: new Date(now), isActive: false, revokedReason: REVOKED_IDLE_TIMEOUT } as any
        });
        revokedCount = Number((revoked as any)?.count ?? 0);
      } catch {
        // The 401 below still ends this request
      }
      if (revokedCount > 0 && this.auditService) {
        try {
          await this.auditService.logAction({
            actorId: session.userId,
            actorEmail: session.user?.email,
            actorRole: session.user?.role,
            action: 'AUTH_SESSION_IDLE_TIMEOUT',
            entityType: 'User',
            entityId: session.userId,
            afterState: { sessionId: session.id, idleTimeoutMinutes: adminIdleTimeoutMinutes(), sessionsRevoked: revokedCount },
            ipAddress: requestIp(req),
            userAgent: req?.headers?.['user-agent']
          });
        } catch {
          // Non-fatal
        }
      }
      throw sessionIdleTimeoutException();
    }

    if (isPassiveRequest(req)) return;
    const lastSeen = session.lastSeenAt ? new Date(session.lastSeenAt).getTime() : 0;
    if (now - lastSeen < LAST_SEEN_WRITE_INTERVAL_MS) return;
    try {
      // Conditional: concurrent requests of the same minute write once
      await this.prisma.session.updateMany({
        where: {
          id: session.id,
          OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: new Date(now - LAST_SEEN_WRITE_INTERVAL_MS) } }]
        } as any,
        data: { lastSeenAt: new Date(now) } as any
      });
    } catch {
      // Activity tracking never fails a request
    }
  }
}

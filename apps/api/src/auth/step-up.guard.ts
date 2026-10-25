import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException
} from '@nestjs/common';

/** A successful step-up re-authentication is valid for this long on the session that performed it. */
export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;

/** Default absolute lifetime of a staff (admin-audience) refresh session, in hours. */
export const DEFAULT_ADMIN_SESSION_MAX_HOURS = 12;

/**
 * Absolute lifetime of a staff session family (ADMIN_SESSION_MAX_HOURS, default 12 hours, clamped to
 * 1..168). Refresh-token rotation never extends it; public sessions keep their 7-day sliding lifetime.
 */
export function adminSessionMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ADMIN_SESSION_MAX_HOURS);
  const hours = Number.isFinite(raw) && raw > 0 ? Math.min(Math.max(raw, 1), 168) : DEFAULT_ADMIN_SESSION_MAX_HOURS;
  return Math.round(hours * 60 * 60 * 1000);
}

/** End of the step-up window for a session's stepUpAt, or null when there is none. */
export function stepUpUntil(stepUpAt: Date | string | null | undefined): Date | null {
  if (!stepUpAt) return null;
  const at = new Date(stepUpAt).getTime();
  if (!Number.isFinite(at)) return null;
  return new Date(at + STEP_UP_WINDOW_MS);
}

/** True when the authenticated session completed a step-up within the last 10 minutes. */
export function hasRecentStepUp(user: { stepUpAt?: Date | string | null } | null | undefined, now: number = Date.now()): boolean {
  const until = stepUpUntil(user?.stepUpAt);
  if (!until) return false;
  const at = until.getTime() - STEP_UP_WINDOW_MS;
  // A timestamp in the future (clock skew beyond a minute) is never trusted
  return at <= now + 60_000 && now <= until.getTime();
}

/** 403 answered by step-up protected endpoints: { statusCode: 403, code: 'STEP_UP_REQUIRED', message }. */
export function stepUpRequiredException(): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    code: 'STEP_UP_REQUIRED',
    message: 'Confirm this action with your authenticator code.'
  });
}

/**
 * Requires a recent step-up re-authentication (POST /auth/step-up) on the current session.
 * JwtStrategy exposes the session's stepUpAt as req.user.stepUpAt (read fresh on every request).
 * Apply after the authentication / role / CSRF guards.
 */
@Injectable()
export class StepUpGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (!req?.user) {
      throw new UnauthorizedException('Authentication required');
    }
    if (!hasRecentStepUp(req.user)) {
      throw stepUpRequiredException();
    }
    return true;
  }
}

/** True for a staff (admin-audience) session. */
export function isStaffSession(user: { aud?: string | null } | null | undefined): boolean {
  return user?.aud === 'gcdis-admin';
}

/**
 * Step-up for sensitive reads that both staff and participants may perform (e.g. signed URLs for uploaded
 * ID proofs and documents): staff sessions need a recent step-up, team captains reading their own files
 * are not affected. Apply after the authentication / role guards.
 */
@Injectable()
export class StaffStepUpGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (!req?.user) {
      throw new UnauthorizedException('Authentication required');
    }
    if (isStaffSession(req.user) && !hasRecentStepUp(req.user)) {
      throw stepUpRequiredException();
    }
    return true;
  }
}

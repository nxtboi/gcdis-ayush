import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@gcdis/shared';

export const AUDIENCE_ROLES_KEY = 'audienceRoles';

export interface AudienceRoles {
  /** Roles accepted on a public (portal) session, audience 'gcdis-public'. */
  public?: UserRole[];
  /** Roles accepted on an administrative session, audience 'gcdis-admin'. */
  admin?: UserRole[];
}

/**
 * Declares, per token audience, which roles may call a route. Used for routes shared by
 * captains (their own resources, on a portal session) and staff (on an admin session),
 * which the single-list @Roles decorator cannot express because RolesGuard enforces one
 * audience per route. Apply together with AudienceRolesGuard.
 */
export const AllowAudienceRoles = (roles: AudienceRoles) => SetMetadata(AUDIENCE_ROLES_KEY, roles);

@Injectable()
export class AudienceRolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<AudienceRoles>(AUDIENCE_ROLES_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (!allowed) return true;

    const { user } = context.switchToHttp().getRequest();
    if (!user) return false;

    const roles =
      user.aud === 'gcdis-admin' ? allowed.admin : user.aud === 'gcdis-public' ? allowed.public : undefined;
    if (!roles || !roles.includes(user.role)) {
      throw new ForbiddenException('Your account role is not permitted to perform this action.');
    }
    return true;
  }
}

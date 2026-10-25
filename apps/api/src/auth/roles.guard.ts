import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@gcdis/shared';
import { ROLES_KEY } from './roles.decorator';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';

const ADMIN_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.EVENT_ADMIN,
  UserRole.JUDGE,
  UserRole.INSPECTOR
];

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (isPublic === true) {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }
    const { user } = context.switchToHttp().getRequest();
    if (!user) return false;

    // Audience Separation: Admin routes strictly reject public tokens
    const requiresAdmin = requiredRoles.some((role) => ADMIN_ROLES.includes(role));
    if (requiresAdmin && user.aud !== 'gcdis-admin') {
      throw new ForbiddenException(
        'Admin routes reject public tokens. Authenticate with an administrative session.'
      );
    }

    // Public captain routes reject admin tokens
    const requiresOnlyPublic = requiredRoles.every((role) => !ADMIN_ROLES.includes(role));
    if (requiresOnlyPublic && user.aud !== 'gcdis-public') {
      throw new ForbiddenException(
        'Public routes reject administrative tokens. Authenticate with a public session.'
      );
    }

    return requiredRoles.includes(user.role);
  }
}

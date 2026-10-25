import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ExtractJwt } from 'passport-jwt';
import { accessTokenFromCookies, refreshTokenFromCookies } from './session-cookies.util';

/**
 * For session-probe endpoints such as GET /auth/me. A visitor with no session at all (no access
 * token and no refresh cookie for the calling app) passes with `req.user = null`, so the client
 * receives 200 { user: null } instead of a 401 on every anonymous page load. Any presented token
 * is still fully validated, and an expired access token with a live refresh cookie still yields
 * 401 so the client refreshes its session.
 */
@Injectable()
export class OptionalSessionGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const bearer = ExtractJwt.fromAuthHeaderAsBearerToken()(req);
    if (!bearer && !accessTokenFromCookies(req) && !refreshTokenFromCookies(req)) {
      req.user = null;
      return true;
    }
    return super.canActivate(context);
  }
}

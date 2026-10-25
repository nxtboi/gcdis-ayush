import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Runs the JWT strategy when credentials are present but never rejects the request:
 * anonymous (or invalid-token) callers proceed with `req.user` unset. Use on @Public() routes
 * whose response depends on who is asking (e.g. owners/staff see more than the public).
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      await super.canActivate(context);
    } catch {
      // Treat as anonymous
    }
    return true;
  }

  handleRequest(_err: any, user: any) {
    return user || null;
  }
}

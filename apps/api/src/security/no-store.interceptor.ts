import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';

/**
 * Authenticated API responses (personal data: users, teams, registrations, documents, audit rows) must never be
 * stored by the browser cache, a shared proxy or a CDN. Every HTTP request that reached the handler with an
 * authenticated user gets `Cache-Control: no-store` (plus `Pragma: no-cache` for HTTP/1.0 caches) before the
 * handler runs, so error responses are covered too. Handlers that deliberately serve public, cacheable content
 * (CMS, live scores) set their own Cache-Control afterwards and keep it. /api/auth is already no-store (main.ts).
 */
@Injectable()
export class NoStoreForAuthenticatedInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const http = context.switchToHttp();
      const req: any = http.getRequest();
      const res: any = http.getResponse();
      if (req?.user && res && typeof res.setHeader === 'function' && !res.headersSent) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
      }
    }
    return next.handle();
  }
}

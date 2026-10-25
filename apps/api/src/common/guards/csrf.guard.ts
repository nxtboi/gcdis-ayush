import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException
} from '@nestjs/common';

const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:3001'];

/** Normalises a configured URL / Origin header to its exact origin (scheme://host[:port]); null if invalid. */
export function toOrigin(value: string | undefined | null): string | null {
  if (!value || typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Builds the exact-origin allow-list. Localhost dev origins are only trusted outside production.
 */
export function buildAllowedOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const isProd = env.NODE_ENV === 'production';
  const configured = [env.PUBLIC_SITE_URL, env.ADMIN_SITE_URL, env.PUBLIC_ORIGIN, env.ADMIN_ORIGIN];
  const candidates = isProd ? configured : [...configured, ...DEV_ORIGINS];
  const origins = new Set<string>();
  for (const candidate of candidates) {
    const origin = toOrigin(candidate);
    if (origin) origins.add(origin);
  }
  return origins;
}

const WEBHOOK_PATH_PREFIXES = ['/api/payments/webhook', '/payments/webhook'];

function requestPathname(req: any): string {
  const raw = String(req?.originalUrl || req?.url || '');
  return raw.split('?')[0].split('#')[0];
}

@Injectable()
export class CsrfGuard implements CanActivate {
  private allowedOrigins: Set<string>;

  constructor() {
    this.allowedOrigins = buildAllowedOrigins();
  }

  private isAllowed(value: string): boolean {
    // Exact origin comparison only: 'https://site.com.evil.com' or 'https://site.com@evil.com' never match
    const origin = toOrigin(value);
    return origin !== null && origin === value.trim().replace(/\/$/, '') && this.allowedOrigins.has(origin);
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const method = String(req.method || '').toUpperCase();

    // Safe idempotent methods are exempt from CSRF validation
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return true;
    }

    // Webhooks using cryptographic HMAC signatures (e.g., Razorpay) are handled by dedicated signature guards.
    // Match the pathname only, so '?next=/payments/webhook' cannot skip CSRF checks.
    const pathname = requestPathname(req);
    if (WEBHOOK_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'))) {
      return true;
    }

    const headers = req.headers || {};
    const origin = headers['origin'];
    const referer = headers['referer'];

    // 1. Origin / Referer Allow-List Check (exact origin match)
    if (origin) {
      if (!this.isAllowed(String(origin))) {
        throw new ForbiddenException(`CSRF verification failed: Origin '${origin}' is not authorized.`);
      }
    } else if (referer) {
      const refOrigin = toOrigin(String(referer));
      if (!refOrigin) {
        throw new ForbiddenException('CSRF verification failed: Malformed Referer header.');
      }
      if (!this.allowedOrigins.has(refOrigin)) {
        throw new ForbiddenException(`CSRF verification failed: Referer '${refOrigin}' is not authorized.`);
      }
    }

    // 2. Custom Anti-CSRF Header Check
    // Browsers cannot send custom headers / JSON bodies cross-origin without a CORS preflight
    const hasCustomHeader =
      Boolean(headers['x-requested-with']) ||
      Boolean(headers['x-csrf-protection']) ||
      Boolean(headers['x-gcdis-csrf']) ||
      Boolean(headers['x-csrf-token']);

    const isJsonPayload = String(headers['content-type'] || '').toLowerCase().includes('application/json');

    if (!hasCustomHeader && !isJsonPayload && !origin) {
      throw new ForbiddenException(
        'CSRF verification failed: State-changing request must include a custom header (e.g. X-Requested-With, X-CSRF-Protection) or application/json payload.'
      );
    }

    return true;
  }
}

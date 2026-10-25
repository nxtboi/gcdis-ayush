import { toOrigin } from '../common/guards/csrf.guard';

/**
 * Legacy / development cookie names. Development (plain http on localhost) keeps using these; production
 * uses the prefixed names from sessionCookieNames() and only clears these (stale cookies from older deploys).
 */
export const PUBLIC_ACCESS_COOKIE = 'gcdis_access_token';
export const PUBLIC_REFRESH_COOKIE = 'gcdis_refresh_token';
export const ADMIN_ACCESS_COOKIE = 'gcdis_admin_access_token';
export const ADMIN_REFRESH_COOKIE = 'gcdis_admin_refresh_token';

/** Path of the refresh cookies in production: only the /api/auth endpoints (refresh, logout, me) see them. */
export const REFRESH_COOKIE_PATH = '/api/auth';

export interface SessionCookieNames {
  publicAccess: string;
  publicRefresh: string;
  adminAccess: string;
  adminRefresh: string;
}

export interface SessionCookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict' | 'lax';
  path: string;
}

const DEV_COOKIE_NAMES: SessionCookieNames = Object.freeze({
  publicAccess: PUBLIC_ACCESS_COOKIE,
  publicRefresh: PUBLIC_REFRESH_COOKIE,
  adminAccess: ADMIN_ACCESS_COOKIE,
  adminRefresh: ADMIN_REFRESH_COOKIE
});

/**
 * Production names. `__Host-` (access tokens): the browser only accepts the cookie when it is Secure,
 * Path=/ and has no Domain, so a sibling subdomain cannot plant or shadow it. `__Secure-` (refresh
 * tokens): Secure is mandatory, and the cookie is scoped to Path=/api/auth (`__Host-` would force Path=/).
 */
const PROD_COOKIE_NAMES: SessionCookieNames = Object.freeze({
  publicAccess: '__Host-gcdis_access_token',
  publicRefresh: '__Secure-gcdis_refresh_token',
  adminAccess: '__Host-gcdis_admin_access_token',
  adminRefresh: '__Secure-gcdis_admin_refresh_token'
});

function isProductionEnv(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'production';
}

/** Session cookie names for this environment (single source of truth for every read and write). */
export function sessionCookieNames(env: NodeJS.ProcessEnv = process.env): SessionCookieNames {
  return isProductionEnv(env) ? PROD_COOKIE_NAMES : DEV_COOKIE_NAMES;
}

/**
 * Names and options for setting the session cookies. Production: Secure, SameSite=Strict, no Domain,
 * access cookies at Path=/ and refresh cookies at Path=/api/auth. Development: plain-http friendly
 * (not Secure, SameSite=Lax, Path=/) with the legacy names.
 */
export function sessionCookieConfig(env: NodeJS.ProcessEnv = process.env): {
  names: SessionCookieNames;
  access: SessionCookieOptions;
  refresh: SessionCookieOptions;
} {
  const prod = isProductionEnv(env);
  const base = { httpOnly: true, secure: prod, sameSite: (prod ? 'strict' : 'lax') as 'strict' | 'lax' };
  return {
    names: sessionCookieNames(env),
    access: { ...base, path: '/' },
    refresh: { ...base, path: prod ? REFRESH_COOKIE_PATH : '/' }
  };
}

/**
 * Options for clearing one session cookie: the browser only deletes a cookie whose name, path (and
 * domain) match, and only accepts a prefixed cookie with Secure. Development keeps `{ path: '/' }`.
 */
export function clearCookieOptions(name: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  if (!isProductionEnv(env)) return { path: '/' };
  const config = sessionCookieConfig(env);
  if (name === config.names.publicRefresh || name === config.names.adminRefresh) return { ...config.refresh };
  // __Host- access cookies, and legacy cookies (all were written at Path=/)
  return { ...config.access };
}

export type SessionApp = 'admin' | 'public' | 'unknown';

/** Exact origins of the staff console (configured, plus localhost:3001 outside production). */
export function adminOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const candidates = [env.ADMIN_SITE_URL, env.ADMIN_ORIGIN];
  if (env.NODE_ENV !== 'production') candidates.push('http://localhost:3001');
  const origins = new Set<string>();
  for (const candidate of candidates) {
    const origin = toOrigin(candidate);
    if (origin) origins.add(origin);
  }
  return origins;
}

/** Exact origins of the public website and team portal. */
export function publicOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const candidates = [env.PUBLIC_SITE_URL, env.PUBLIC_ORIGIN];
  if (env.NODE_ENV !== 'production') candidates.push('http://localhost:3000');
  const origins = new Set<string>();
  for (const candidate of candidates) {
    const origin = toOrigin(candidate);
    if (origin) origins.add(origin);
  }
  return origins;
}

/**
 * Which application sent the request, from its Origin (or Referer) header. Both session cookies
 * live on the API host, so the browser sends both; the calling app decides which one applies.
 */
export function sessionAppFor(req: any, env: NodeJS.ProcessEnv = process.env): SessionApp {
  const headers = req?.headers || {};
  const origin = toOrigin(headers.origin) || toOrigin(headers.referer);
  if (!origin) return 'unknown';
  if (adminOrigins(env).has(origin)) return 'admin';
  if (publicOrigins(env).has(origin)) return 'public';
  return 'unknown';
}

/** Access token for this request: the staff cookie for the console, the public cookie for the website. */
export function accessTokenFromCookies(req: any, env: NodeJS.ProcessEnv = process.env): string | null {
  const cookies = req?.cookies || {};
  const names = sessionCookieNames(env);
  const app = sessionAppFor(req, env);
  if (app === 'admin') return cookies[names.adminAccess] || null;
  if (app === 'public') return cookies[names.publicAccess] || null;
  // No browser origin (server-side rendering, scripts): previous behaviour
  return cookies[names.adminAccess] || cookies[names.publicAccess] || null;
}

export function refreshTokenFromCookies(req: any, env: NodeJS.ProcessEnv = process.env): string | null {
  const cookies = req?.cookies || {};
  const names = sessionCookieNames(env);
  const app = sessionAppFor(req, env);
  if (app === 'admin') return cookies[names.adminRefresh] || null;
  if (app === 'public') return cookies[names.publicRefresh] || null;
  return cookies[names.adminRefresh] || cookies[names.publicRefresh] || null;
}

/** Staff access token from a raw Cookie header (WebSocket handshakes, which bypass cookie-parser). */
export function adminAccessTokenFromCookieHeader(
  cookieHeader: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (!cookieHeader) return undefined;
  const wanted = sessionCookieNames(env).adminAccess;
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    if (part.slice(0, index).trim() !== wanted) continue;
    const value = part.slice(index + 1).trim();
    if (!value) return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

/**
 * Cookie names to clear on sign-out: only the calling app's session when the app is known. In production
 * both the prefixed names and the legacy names are cleared, so cookies from a pre-prefix deploy never linger.
 */
export function cookiesToClear(req: any, env: NodeJS.ProcessEnv = process.env): string[] {
  const app = sessionAppFor(req, env);
  const pick = (n: SessionCookieNames) =>
    app === 'admin'
      ? [n.adminAccess, n.adminRefresh]
      : app === 'public'
        ? [n.publicAccess, n.publicRefresh]
        : [n.publicAccess, n.publicRefresh, n.adminAccess, n.adminRefresh];
  return Array.from(new Set([...pick(sessionCookieNames(env)), ...pick(DEV_COOKIE_NAMES)]));
}

/** Every session cookie name (current and legacy), for clearing all sessions on this browser. */
export function allSessionCookieNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Array.from(new Set([...Object.values(sessionCookieNames(env)), ...Object.values(DEV_COOKIE_NAMES)]));
}

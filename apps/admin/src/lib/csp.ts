/**
 * Content-Security-Policy for the staff console, built per request by `src/middleware.ts`.
 *
 * No third-party scripts: scripts run only through a per-request nonce plus 'strict-dynamic' (Next.js adds the
 * nonce to its own scripts). There is no 'unsafe-inline' for scripts; 'unsafe-eval' is added in development only
 * (Next.js HMR / React Refresh). Nginx must not add a second CSP for the admin host.
 */

const isProd = process.env.NODE_ENV === 'production';

/** API origins derived from NEXT_PUBLIC_API_URL (the local API in development). */
function apiOrigins(): { http: string[]; ws: string[] } {
  const raw = process.env.NEXT_PUBLIC_API_URL || (isProd ? '' : 'http://localhost:4000/api');
  try {
    const httpOrigin = new URL(raw).origin;
    return { http: [httpOrigin], ws: [httpOrigin.replace(/^http/, 'ws')] };
  } catch {
    // Missing/malformed: the API client reports misconfiguration at runtime.
    return { http: [], ws: [] };
  }
}

const API = apiOrigins();

/** CSP violation report endpoint on the API (`<NEXT_PUBLIC_API_URL>/csp-report`); null when the API URL is unset. */
function cspReportUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_API_URL || (isProd ? '' : 'http://localhost:4000/api');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}/csp-report`;
  } catch {
    return null;
  }
}

export const CSP_REPORT_URL = cspReportUrl();
/** Reporting API group name used by the `report-to` directive and the Reporting-Endpoints header. */
export const CSP_REPORT_GROUP = 'csp-endpoint';

/** Value of the Reporting-Endpoints response header, or null when there is no report endpoint. */
export function reportingEndpointsHeader(): string | null {
  return CSP_REPORT_URL ? `${CSP_REPORT_GROUP}="${CSP_REPORT_URL}"` : null;
}

/** `report-uri` (CSP 2 browsers, Firefox) plus `report-to` (Reporting API, Chromium). */
function reportDirectives(): string[] {
  return CSP_REPORT_URL ? [`report-uri ${CSP_REPORT_URL}`, `report-to ${CSP_REPORT_GROUP}`] : [];
}

/**
 * Trusted Types policy names the console legitimately creates: 'nextjs' (Next.js client runtime) and
 * 'nextjs#bundler' (webpack runtime, output.trustedTypes).
 */
export const TRUSTED_TYPES_POLICIES = ['nextjs', 'nextjs#bundler'];

/** Random per-request nonce (a v4 UUID, 122 random bits, base64-encoded). */
export function createNonce(): string {
  return btoa(crypto.randomUUID());
}

export function buildContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isProd ? '' : " 'unsafe-eval'"}`,
    ['connect-src', "'self'", ...API.http, ...API.ws].join(' '),
    "frame-src 'none'",
    // API origin is required to preview uploaded hero backgrounds served by the API
    ['img-src', "'self'", 'data:', 'blob:', ...API.http].join(' '),
    // API origin: previews of the championship hero video (EVENT_VIDEO uploads served by the API)
    ['media-src', "'self'", 'blob:', ...API.http].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isProd ? ['upgrade-insecure-requests'] : []),
    ...reportDirectives()
  ].join('; ');
}

/** Trusted Types directives: DOM XSS sinks accept only values from the Next.js policies. */
export function trustedTypesDirectives(): string[] {
  return ["require-trusted-types-for 'script'", `trusted-types ${TRUSTED_TYPES_POLICIES.join(' ')} 'allow-duplicates'`];
}

/**
 * Report-only Trusted Types policy (Content-Security-Policy-Report-Only): DOM XSS sinks fed with plain strings are
 * reported, never blocked. Used in development, where HMR / React Refresh need eval and string sinks.
 */
export function buildTrustedTypesReportOnlyPolicy(): string {
  return [...trustedTypesDirectives(), ...reportDirectives()].join('; ');
}

export type TrustedTypesMode = 'enforce' | 'report-only';

/**
 * Trusted Types mode: enforced in production builds (verified: the console's production bundle raises no Trusted
 * Types violation on any tab), report-only in development. ADMIN_TRUSTED_TYPES=report-only is an emergency switch
 * back to report-only in production without a code change.
 */
export function trustedTypesMode(env: Record<string, string | undefined> = process.env): TrustedTypesMode {
  const override = (env.ADMIN_TRUSTED_TYPES || '').trim().toLowerCase();
  if (override === 'report-only' || override === 'enforce') return override;
  return env.NODE_ENV === 'production' ? 'enforce' : 'report-only';
}

/** Enforced CSP with the Trusted Types directives added (production). */
export function withEnforcedTrustedTypes(csp: string): string {
  return [csp, ...trustedTypesDirectives()].join('; ');
}

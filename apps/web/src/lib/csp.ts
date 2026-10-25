/**
 * Content-Security-Policy for the public site, built per request by `src/middleware.ts`.
 *
 * Scripts are allowed only through a per-request nonce plus 'strict-dynamic': Next.js adds the nonce to its own
 * scripts, and scripts those trusted scripts insert at run time (the Razorpay Checkout loader and the Google
 * Identity Services client) inherit the trust. The host entries after 'strict-dynamic' are ignored by CSP 3
 * browsers and only serve older browsers. There is no 'unsafe-inline' for scripts; 'unsafe-eval' is added in
 * development only (Next.js HMR / React Refresh).
 *
 * Nginx must not add a second CSP for the www host: policies intersect, and a static policy would block the
 * nonce-based scripts.
 */

const isProd = process.env.NODE_ENV === 'production';

/** API origins (HTTP and WebSocket) derived from NEXT_PUBLIC_API_URL / NEXT_PUBLIC_WS_URL. */
function apiOrigins(): { http: string[]; ws: string[] } {
  const candidates = [
    process.env.NEXT_PUBLIC_API_URL || (isProd ? '' : 'http://localhost:4000/api'),
    process.env.NEXT_PUBLIC_WS_URL || ''
  ];
  const http = new Set<string>();
  const ws = new Set<string>();
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const httpOrigin = new URL(raw).origin.replace(/^ws/, 'http');
      http.add(httpOrigin);
      ws.add(httpOrigin.replace(/^http/, 'ws'));
    } catch {
      // Ignore malformed values; the API client reports misconfiguration at runtime.
    }
  }
  return { http: [...http], ws: [...ws] };
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

// Google Identity Services ("Sign in with Google" on /portal): exact GSI paths only, per Google's CSP guidance.
export const GSI = {
  script: 'https://accounts.google.com/gsi/client',
  frame: 'https://accounts.google.com/gsi/',
  connect: 'https://accounts.google.com/gsi/',
  style: 'https://accounts.google.com/gsi/style'
};

export const RAZORPAY_CHECKOUT = 'https://checkout.razorpay.com';
/**
 * Razorpay Checkout hosts by role (no wildcard): checkout.js is served from checkout.razorpay.com, the payment
 * form runs in a frame on api.razorpay.com, the loader may draw logos/images from checkout.razorpay.com and
 * cdn.razorpay.com, and telemetry goes to lumberjack.razorpay.com.
 */
export const RAZORPAY = {
  checkout: RAZORPAY_CHECKOUT,
  api: 'https://api.razorpay.com',
  cdn: 'https://cdn.razorpay.com',
  lumberjack: 'https://lumberjack.razorpay.com'
};

/** Random per-request nonce (a v4 UUID, 122 random bits, base64-encoded). */
export function createNonce(): string {
  return btoa(crypto.randomUUID());
}

export function buildContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    // Nonce + 'strict-dynamic'; no 'unsafe-inline'. 'unsafe-eval' is only needed by Next.js HMR in development.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isProd ? '' : " 'unsafe-eval'"} ${RAZORPAY_CHECKOUT} ${GSI.script}`,
    ['connect-src', "'self'", ...API.http, ...API.ws, 'https://api.razorpay.com', 'https://lumberjack.razorpay.com', GSI.connect].join(' '),
    `frame-src https://api.razorpay.com https://checkout.razorpay.com ${GSI.frame}`,
    ['img-src', "'self'", 'data:', 'blob:', ...API.http, RAZORPAY.checkout, RAZORPAY.cdn].join(' '),
    // Championship hero video: site uploads served by the API origin
    ['media-src', "'self'", ...API.http].join(' '),
    // framer-motion and the GSI button write inline styles
    `style-src 'self' 'unsafe-inline' ${GSI.style}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isProd ? ['upgrade-insecure-requests'] : []),
    ...reportDirectives()
  ].join('; ');
}

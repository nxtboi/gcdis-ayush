import { NextResponse, type NextRequest } from 'next/server';
import {
  buildContentSecurityPolicy,
  buildTrustedTypesReportOnlyPolicy,
  createNonce,
  reportingEndpointsHeader,
  trustedTypesMode,
  withEnforcedTrustedTypes
} from '@/lib/csp';

/**
 * Per-request nonce Content-Security-Policy (see lib/csp.ts).
 * The nonce is passed to the app through the `x-nonce` request header; Next.js also reads it from the request's
 * Content-Security-Policy header and applies it to the scripts it renders.
 *
 * Trusted Types: enforced (part of the CSP) in production, report-only in development (HMR / React Refresh).
 */
export function middleware(request: NextRequest) {
  const nonce = createNonce();
  const enforceTrustedTypes = trustedTypesMode() === 'enforce';
  const baseCsp = buildContentSecurityPolicy(nonce);
  const csp = enforceTrustedTypes ? withEnforcedTrustedTypes(baseCsp) : baseCsp;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  if (!enforceTrustedTypes) {
    // Trusted Types in report-only mode: violations are reported to the API, nothing is blocked
    response.headers.set('Content-Security-Policy-Report-Only', buildTrustedTypesReportOnlyPolicy());
  }
  // Reporting API endpoint for the CSP `report-to` group (CSP violation reports go to the API)
  const reportingEndpoints = reportingEndpointsHeader();
  if (reportingEndpoints) response.headers.set('Reporting-Endpoints', reportingEndpoints);
  // Pages may only be embedded/loaded as resources by same-site documents
  response.headers.set('Cross-Origin-Resource-Policy', 'same-site');
  // Console pages are rendered per user and session: never stored by the browser, a proxy or a CDN
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  // Never indexed (also in next.config.js and robots.txt)
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return response;
}

export const config = {
  matcher: [
    {
      // Skip build assets, the image optimiser and router prefetches (prefetched RSC payloads carry no scripts).
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' }
      ]
    }
  ]
};

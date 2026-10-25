import { NextResponse, type NextRequest } from 'next/server';
import { buildContentSecurityPolicy, createNonce, reportingEndpointsHeader } from '@/lib/csp';

/** Pages whose URL carries a one-time token: never leak it through the Referer header. */
const TOKEN_PAGES = ['/portal/verify-email', '/portal/reset-password'];

/**
 * Per-request nonce Content-Security-Policy (see lib/csp.ts).
 * The nonce is passed to the app through the `x-nonce` request header; Next.js also reads it from the request's
 * Content-Security-Policy header and applies it to the scripts it renders.
 */
export function middleware(request: NextRequest) {
  const nonce = createNonce();
  const csp = buildContentSecurityPolicy(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  // Reporting API endpoint for the CSP `report-to` group (CSP violation reports go to the API)
  const reportingEndpoints = reportingEndpointsHeader();
  if (reportingEndpoints) response.headers.set('Reporting-Endpoints', reportingEndpoints);
  // Pages may only be embedded/loaded as resources by same-site documents
  response.headers.set('Cross-Origin-Resource-Policy', 'same-site');
  if (TOKEN_PAGES.some((p) => request.nextUrl.pathname === p || request.nextUrl.pathname.startsWith(`${p}/`))) {
    response.headers.set('Referrer-Policy', 'no-referrer');
  }
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

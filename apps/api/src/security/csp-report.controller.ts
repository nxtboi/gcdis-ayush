import { Body, Controller, HttpCode, HttpStatus, Logger, Post, Req, UseGuards } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { AccountIpRateLimiterGuard, RateLimit } from '../common/guards/rate-limiter.guard';

/** Content types browsers use for CSP violation reports (report-uri and the Reporting API respectively). */
export const CSP_REPORT_CONTENT_TYPES = ['application/csp-report', 'application/reports+json'] as const;
/** Maximum accepted report body. */
export const CSP_REPORT_BODY_LIMIT = '16kb';
/** Per-IP rate limit of the report endpoint. */
export const CSP_REPORT_RATE_LIMIT = Object.freeze({ points: 60, duration: 60 });
/** At most this many reports of one (batched) request are logged. */
const MAX_REPORTS_PER_REQUEST = 10;

export interface CspViolationSummary {
  directive: string;
  blocked: string;
  document: string;
  disposition?: 'enforce' | 'report';
}

const KEYWORD_SOURCES = new Set(['inline', 'eval', 'self', 'data', 'blob', 'wasm-eval', 'trusted-types-policy', 'trusted-types-sink']);

/** Directive name only (e.g. "script-src-elem"); anything else becomes "unknown". */
function sanitizeDirective(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const name = value.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return /^[a-z][a-z-]{0,48}$/.test(name) ? name : 'unknown';
}

/** Origin only for URLs (no path, query or credentials); known CSP keywords are kept; anything else is dropped. */
function sanitizeBlocked(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'unknown';
  const raw = value.trim();
  const keyword = raw.toLowerCase().replace(/:$/, '');
  if (KEYWORD_SOURCES.has(keyword)) return keyword;
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ws:' || url.protocol === 'wss:') {
      return url.origin;
    }
    return /^[a-z][a-z0-9+.-]{0,20}:$/.test(url.protocol) ? url.protocol.slice(0, -1) : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Path only (no origin, query or fragment), capped at 200 characters. */
function sanitizeDocument(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'unknown';
  try {
    const path = new URL(value.trim()).pathname;
    return path.replace(/[^\x21-\x7e]/g, '').slice(0, 200) || '/';
  } catch {
    return 'unknown';
  }
}

function summarize(report: Record<string, unknown>): CspViolationSummary {
  const disposition = report['disposition'];
  return {
    directive: sanitizeDirective(report['effective-directive'] ?? report['effectiveDirective'] ?? report['violated-directive'] ?? report['violatedDirective']),
    blocked: sanitizeBlocked(report['blocked-uri'] ?? report['blockedURL']),
    document: sanitizeDocument(report['document-uri'] ?? report['documentURL']),
    ...(disposition === 'enforce' || disposition === 'report' ? { disposition } : {})
  };
}

/**
 * Sanitised summaries of a report body: `{"csp-report": {...}}` (report-uri, application/csp-report) or an array
 * of `{type: "csp-violation", body: {...}}` (Reporting API, application/reports+json). Other shapes yield [].
 */
export function summarizeCspReports(body: unknown): CspViolationSummary[] {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body)) {
    return body
      .filter((r) => r && typeof r === 'object' && (r as any).type === 'csp-violation' && (r as any).body && typeof (r as any).body === 'object')
      .slice(0, MAX_REPORTS_PER_REQUEST)
      .map((r) => summarize((r as any).body));
  }
  const legacy = (body as any)['csp-report'];
  return legacy && typeof legacy === 'object' ? [summarize(legacy)] : [];
}

/**
 * CSP violation reports from the public site and the staff console. Public (browsers send reports without
 * credentials or custom headers, so there is no CSRF guard), body capped at 16 KB by the route-specific parser
 * in main.ts, rate limited per IP, and only a sanitised summary is logged.
 */
@Controller('csp-report')
export class CspReportController {
  private readonly logger = new Logger('CspReport');

  @Public()
  @UseGuards(AccountIpRateLimiterGuard)
  @RateLimit({ ...CSP_REPORT_RATE_LIMIT })
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  receive(@Body() body: unknown, @Req() req?: any): void {
    for (const summary of summarizeCspReports(body)) {
      this.logger.warn(`[CSP_VIOLATION] ${JSON.stringify({ ...summary, requestId: req?.id })}`);
    }
  }
}

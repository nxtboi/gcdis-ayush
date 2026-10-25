import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';

/** True when the decoded request path or query string contains a NUL character. */
export function urlContainsNullByte(rawUrl: string): boolean {
  if (!rawUrl) return false;
  if (rawUrl.includes('\u0000')) return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawUrl);
  } catch {
    // Malformed percent-encoding elsewhere in the URL: fall back to scanning the raw escape
    return /%00/i.test(rawUrl);
  }
  // Catch double-encoded NULs as well (%2500 -> %00 -> \0)
  return decoded.includes('\u0000') || /%00/i.test(decoded);
}

export function bodyContainsNullByteInQuery(query: unknown, depth = 0): boolean {
  if (depth > 20 || query === null || query === undefined || Buffer.isBuffer(query)) return false;
  if (typeof query === 'string') return query.includes('\u0000');
  if (Array.isArray(query)) return query.some((v) => bodyContainsNullByteInQuery(v, depth + 1));
  if (typeof query === 'object') {
    return Object.entries(query as Record<string, unknown>).some(
      ([k, v]) => k.includes('\u0000') || bodyContainsNullByteInQuery(v, depth + 1)
    );
  }
  return false;
}

/**
 * Global safety net (QA M1): rejects any request whose decoded path or query contains a NUL byte
 * with 400 before it reaches routing, Prisma or the filesystem.
 */
function sendNullByteRejection(req: Request, res: Response) {
  const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  res.status(400).json({
    statusCode: 400,
    error: 'Bad Request',
    message: 'Invalid request parameters',
    timestamp: new Date().toISOString(),
    requestId
  });
}

/**
 * Rejects parsed JSON / urlencoded bodies containing a NUL character in any key or string value
 * (PostgreSQL text columns cannot store U+0000). Raw Buffer bodies (payment webhook) are skipped.
 */
export function rejectNullBytesInBody(req: Request, res: Response, next: NextFunction) {
  if (bodyContainsNullByteInQuery((req as any).body)) {
    sendNullByteRejection(req, res);
    return;
  }
  next();
}

export function rejectNullBytes(req: Request, res: Response, next: NextFunction) {
  const rawUrl = String(req.originalUrl || req.url || '');
  if (urlContainsNullByte(rawUrl) || bodyContainsNullByteInQuery((req as any).query)) {
    sendNullByteRejection(req, res);
    return;
  }
  next();
}

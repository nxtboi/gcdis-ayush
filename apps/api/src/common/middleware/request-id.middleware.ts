import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { newRequestId, redactUrl, validClientRequestId } from './log-sanitizer';

/**
 * Paths polled by container healthchecks / load balancers every few seconds: successful probes are not
 * written to the request log (failures still are), so the log is not flooded with REQUEST_OK lines.
 */
export const QUIET_SUCCESS_PATHS: ReadonlySet<string> = new Set(['/api/health', '/api']);

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction) {
    const startAt = process.hrtime();
    // A client-supplied ID is propagated only when well-formed (at most 64 chars of [A-Za-z0-9_-]):
    // anything else (log injection, oversized values) is replaced by a server-generated ID.
    const requestId =
      validClientRequestId(req.headers['x-request-id']) ||
      validClientRequestId(req.headers['x-correlation-id']) ||
      newRequestId();

    // Attach request ID to request and response headers
    req.headers['x-request-id'] = requestId;
    (req as any).id = requestId;
    res.setHeader('x-request-id', requestId);

    res.on('finish', () => {
      const diff = process.hrtime(startAt);
      const durationMs = Number((diff[0] * 1e3 + diff[1] * 1e-6).toFixed(2));
      // req.ip honours the configured 'trust proxy' setting (TRUST_PROXY); raw X-Forwarded-For is spoofable
      const clientIp = req.ip || req.socket.remoteAddress || '127.0.0.1';
      const statusCode = res.statusCode;

      const logPayload = {
        timestamp: new Date().toISOString(),
        requestId,
        method: req.method,
        // Signed-URL tokens, expiries and one-time codes in the query string are redacted
        url: redactUrl(req.originalUrl),
        statusCode,
        durationMs,
        clientIp,
        userAgent: req.headers['user-agent'] || 'Unknown'
      };

      if (statusCode >= 500) {
        this.logger.error(`[CRITICAL_ERROR] ${JSON.stringify(logPayload)}`);
      } else if (statusCode >= 400) {
        this.logger.warn(`[CLIENT_WARN] ${JSON.stringify(logPayload)}`);
      } else if (!QUIET_SUCCESS_PATHS.has(String(req.originalUrl || '').split('?')[0])) {
        this.logger.log(`[REQUEST_OK] ${JSON.stringify(logPayload)}`);
      }
    });

    next();
  }
}

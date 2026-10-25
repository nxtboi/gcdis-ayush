import * as express from 'express';
import { CSP_REPORT_BODY_LIMIT, CSP_REPORT_CONTENT_TYPES } from '../../security/csp-report.controller';

/** Default limit for JSON and URL-encoded bodies. CMS text, site info and every form payload fit easily. */
export const JSON_BODY_LIMIT = '1mb';
export const URLENCODED_BODY_LIMIT = '1mb';
/**
 * Larger JSON limit for the legacy base64 upload route (POST /api/uploads) only: it carries the file inside
 * JSON (base64 adds a third), and the per-purpose file size checks in UploadsService still apply. The
 * multipart route (/api/uploads/stream) is parsed by multer with its own 25 MB limit.
 */
export const LEGACY_BASE64_UPLOAD_JSON_LIMIT = '10mb';
export const LEGACY_BASE64_UPLOAD_PATH = '/api/uploads';
export const CSP_REPORT_PATH = '/api/csp-report';

/**
 * Route-specific body parsers. main.ts registers them after the raw Razorpay webhook parser and BEFORE the global
 * JSON / URL-encoded parsers: body-parser skips a request whose body was already read, so the global parsers never
 * see these bodies again.
 */
export function registerRouteBodyParsers(app: { use: (...args: any[]) => unknown }): void {
  // CSP violation reports: browsers send application/csp-report (report-uri) or application/reports+json
  // (Reporting API). Parsed as JSON on this route only, capped at 16 KB.
  app.use(
    CSP_REPORT_PATH,
    express.json({ type: [...CSP_REPORT_CONTENT_TYPES, 'application/json'], limit: CSP_REPORT_BODY_LIMIT })
  );

  // Legacy JSON base64 upload: POST /api/uploads exactly (not /stream, /files, /signed-url).
  const legacyUploadJson = express.json({ limit: LEGACY_BASE64_UPLOAD_JSON_LIMIT });
  app.use(LEGACY_BASE64_UPLOAD_PATH, (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.method === 'POST' && (req.path === '/' || req.path === '')) return legacyUploadJson(req, res, next);
    next();
  });
}

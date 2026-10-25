import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import * as express from 'express';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { rejectNullBytes, rejectNullBytesInBody } from './common/middleware/null-byte.middleware';
import { JSON_BODY_LIMIT, URLENCODED_BODY_LIMIT, registerRouteBodyParsers } from './common/middleware/body-parsers';
import { resolveTrustProxy } from './common/utils/trust-proxy.util';
import { mailConfigErrors } from './mail/mail.service';
import { emailLinkConfigErrors } from './auth/account-recovery.service';
import { verificationCodeConfigErrors } from './auth/verification-code.util';
import { productionDataProtectionConfigErrors, productionSecretConfigErrors } from './auth/jwt-secrets';
import { securityAlertConfigErrors } from './security/security-alert.service';
import { clamAvConfig } from './security/clamav.service';

/** Express error middleware for body-parser failures (QA L1): 413 for oversized bodies, 400 for malformed JSON. */
function bodyParserErrorHandler(err: any, req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!err) return next();
  const type = err.type;
  const status = err.status ?? err.statusCode;
  let mapped: { status: number; error: string; message: string } | null = null;
  if (type === 'entity.too.large' || status === 413) {
    mapped = { status: 413, error: 'Payload Too Large', message: 'The request body exceeds the maximum allowed size.' };
  } else if (type === 'entity.parse.failed') {
    mapped = { status: 400, error: 'Bad Request', message: 'Malformed JSON request body.' };
  } else if (typeof status === 'number' && status >= 400 && status < 500) {
    mapped = { status, error: 'Bad Request', message: 'The request body could not be processed.' };
  }
  if (!mapped) return next(err);
  res.status(mapped.status).json({
    statusCode: mapped.status,
    error: mapped.error,
    message: mapped.message,
    timestamp: new Date().toISOString(),
    requestId: (req.headers['x-request-id'] as string) || undefined
  });
}

function validateStartupSecurity() {
  const isProd = process.env.NODE_ENV === 'production';
  const errors: string[] = [];

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    errors.push('JWT_SECRET is required.');
  } else if (jwtSecret.length < 32) {
    errors.push('JWT_SECRET must be at least 32 characters long.');
  } else if (isProd && /placeholder|REPLACE|secret|default|changeme|super_secret/i.test(jwtSecret)) {
    errors.push('JWT_SECRET contains insecure placeholder words in production environment.');
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    errors.push('DATABASE_URL is required.');
  } else if (isProd && /REPLACE_WITH|password123/i.test(dbUrl)) {
    errors.push('DATABASE_URL contains placeholder password in production environment.');
  }

  // Key secrets (production only): JWT_ADMIN_SECRET, TWO_FACTOR_ENCRYPTION_KEY and COOKIE_SECRET are
  // mandatory, and no key secret (also JWT_SECRET, VERIFICATION_CODE_KEY) may hold placeholder text
  errors.push(...productionSecretConfigErrors(process.env));
  // PASS_SIGNING_SECRET (mandatory, distinct from JWT_SECRET) and https:// ADMIN_SITE_URL in production
  errors.push(...productionDataProtectionConfigErrors(process.env));

  if (isProd) {
    const rzpKeyId = process.env.RAZORPAY_KEY_ID;
    if (!rzpKeyId) {
      errors.push('RAZORPAY_KEY_ID is required in production.');
    } else if (/placeholder|REPLACE|test/i.test(rzpKeyId)) {
      errors.push('RAZORPAY_KEY_ID contains placeholder value in production.');
    }

    const rzpSecret = process.env.RAZORPAY_KEY_SECRET;
    if (!rzpSecret) {
      errors.push('RAZORPAY_KEY_SECRET is required in production.');
    } else if (/placeholder|REPLACE|secret/i.test(rzpSecret)) {
      errors.push('RAZORPAY_KEY_SECRET contains placeholder in production.');
    }

    const rzpWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!rzpWebhookSecret) {
      errors.push('RAZORPAY_WEBHOOK_SECRET is required in production.');
    } else if (/placeholder|REPLACE/i.test(rzpWebhookSecret)) {
      errors.push('RAZORPAY_WEBHOOK_SECRET contains placeholder in production.');
    }
  }

  // Outgoing email (verification / password reset) and security alerting
  errors.push(...mailConfigErrors(process.env));
  errors.push(...emailLinkConfigErrors(process.env));
  errors.push(...verificationCodeConfigErrors(process.env));
  errors.push(...securityAlertConfigErrors(process.env));

  if (isProd && !clamAvConfig(process.env).host) {
    console.warn('[GCDIS API Core] WARNING: CLAMAV_HOST is not set; uploaded files are not malware-scanned.');
  }

  if (errors.length > 0) {
    console.error('================================================================');
    console.error(' [FATAL SECURITY MISCONFIGURATION] Application startup aborted:');
    errors.forEach((err) => console.error(` - ${err}`));
    console.error('================================================================');
    process.exit(1);
  }
}

async function bootstrap() {
  // Strict Security Checks: App refuses to start if vital secrets are missing, weak, or placeholder
  validateStartupSecurity();

  const app = await NestFactory.create(AppModule, { rawBody: true });

  const isProd = process.env.NODE_ENV === 'production';

  // 1. Trust Proxy: configurable via TRUST_PROXY (default 1 hop in production behind Nginx, off in development)
  const expressInstance = app.getHttpAdapter().getInstance() as express.Application;
  expressInstance.set('trust proxy', resolveTrustProxy());

  // 1b. Reject NUL bytes in the decoded path or query before routing (QA M1)
  app.use(rejectNullBytes);

  // 1c. Authentication responses (tokens, user profile, errors) must never be stored by browsers or proxies
  app.use('/api/auth', (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  // 2. Helmet Security Headers
  app.use(
    helmet({
      contentSecurityPolicy: isProd ? undefined : false,
      crossOriginEmbedderPolicy: false
    })
  );

  // 3. Cookie Parser with Secret (no hardcoded fallback; production requires COOKIE_SECRET)
  const cookieSecret = isProd ? process.env.COOKIE_SECRET : process.env.COOKIE_SECRET || process.env.JWT_SECRET;
  if (!cookieSecret) {
    throw new Error('COOKIE_SECRET must be configured (JWT_SECRET is only accepted as a fallback outside production).');
  }
  app.use(cookieParser(cookieSecret));

  // 4. Request Body Size Limits
  // Razorpay webhook: keep the exact raw bytes for HMAC verification. Registered BEFORE the
  // JSON parser so the body is not consumed/re-serialised; exposed as req.rawBody.
  app.use(
    '/api/payments/webhook',
    express.raw({
      type: '*/*',
      limit: '1mb',
      verify: (req: any, _res, buf: Buffer) => {
        req.rawBody = Buffer.from(buf);
      }
    })
  );
  // CSP reports (16 KB, report content types) and the legacy base64 upload (POST /api/uploads only)
  registerRouteBodyParsers(app);
  // Everything else: 1 MB (CMS text, site info and forms are far smaller; multipart uploads use multer)
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ limit: URLENCODED_BODY_LIMIT, extended: true }));
  app.use(bodyParserErrorHandler);
  app.use(rejectNullBytesInBody);

  // 5. Global Exception Filter (Masks internal stack traces in production)
  app.useGlobalFilters(new GlobalExceptionFilter());

  // 6. Graceful Shutdown Hooks
  app.enableShutdownHooks();

  // 7. Strict CORS Configuration: Whitelist exact Public and Admin origins only
  const allowedOrigins = [
    process.env.PUBLIC_SITE_URL || 'http://localhost:3000',
    process.env.ADMIN_SITE_URL || 'http://localhost:3001',
    process.env.PUBLIC_ORIGIN,
    process.env.ADMIN_ORIGIN
  ].filter(Boolean) as string[];

  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, server-side SSR, curl during local tests)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        // Disallowed origin: omit CORS headers so the browser blocks the response (no 500 / stack trace).
        callback(null, false);
      }
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true
  });

  // 8. Request validation with payload sanitization
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true
    })
  );

  app.setGlobalPrefix('api');

  let port = Number(process.env.PORT) || 4000;

  try {
    await app.listen(port);
    console.log(`[GCDIS API Core] Server running on port ${port} with strict security hardening.`);
  } catch (err: any) {
    // Port fallback is a local-dev convenience only: in production the container healthcheck
    // and reverse proxy target a fixed port, so a busy port must be a fatal error.
    if (err.code === 'EADDRINUSE' && !isProd) {
      console.warn(`[GCDIS API Core] Port ${port} is occupied. Retrying on fallback port ${port + 1}...`);
      port = port + 1;
      await app.listen(port);
      console.log(`[GCDIS API Core] Server running on port ${port} with strict security hardening.`);
    } else {
      console.error('[GCDIS API Core] Fatal startup error:', err);
      process.exit(1);
    }
  }
}

bootstrap();

import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as express from 'express';
import { Body, Controller, INestApplication, Logger, Post, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppController, HEALTH_PROBE_TIMEOUT_MS } from '../apps/api/src/app.controller';
import { IS_PUBLIC_KEY } from '../apps/api/src/common/decorators/public.decorator';
import { AccountIpRateLimiterGuard } from '../apps/api/src/common/guards/rate-limiter.guard';
import { ROLES_KEY } from '../apps/api/src/auth/roles.decorator';
import { UserRole } from '@gcdis/shared';
import {
  CSP_REPORT_BODY_LIMIT,
  CSP_REPORT_RATE_LIMIT,
  CspReportController,
  summarizeCspReports
} from '../apps/api/src/security/csp-report.controller';
import {
  JSON_BODY_LIMIT,
  LEGACY_BASE64_UPLOAD_JSON_LIMIT,
  URLENCODED_BODY_LIMIT,
  registerRouteBodyParsers
} from '../apps/api/src/common/middleware/body-parsers';
import { QUIET_SUCCESS_PATHS, RequestIdMiddleware } from '../apps/api/src/common/middleware/request-id.middleware';

/**
 * Header and server hardening: minimal GET /api, dependency-aware /api/health, CSP violation reporting,
 * tighter web/console headers (exact Razorpay hosts, CORP, Permissions-Policy, Trusted Types report-only)
 * and the 1 MB JSON body limit.
 */
const rootDir = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(rootDir, ...p), 'utf-8');
const RATE_LIMIT_METADATA = 'RATE_LIMIT_RULE';

function directive(policy: string, name: string): string {
  return policy.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `) || d === name) ?? '';
}

describe('1. GET /api is a bare liveness answer', () => {
  test('returns only {status: "ok"} (no version, uptime or endpoint map) and is public', () => {
    const controller = new AppController({} as any);
    expect(controller.getRoot()).toEqual({ status: 'ok' });
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AppController.prototype.getRoot)).toBe(true);
    const source = read('apps', 'api', 'src', 'app.controller.ts');
    expect(source).not.toContain('GCDIS Core API Engine');
    expect(source).not.toMatch(/endpoints:\s*\{/);
  });
});

describe('2. GET /api/health reflects its dependencies', () => {
  const savedRedisUrl = process.env.REDIS_URL;
  const mockRes = () => ({ status: jest.fn(), setHeader: jest.fn() });

  beforeEach(() => {
    delete process.env.REDIS_URL;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedRedisUrl;
  });

  test('200 {status: "ok"} when the database answers and Redis is not configured (in-memory fallback)', async () => {
    const prisma: any = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const res = mockRes();
    expect(await AccountIpRateLimiterGuard.redisHealth()).toBe('not_configured');
    const body = await new AppController(prisma).getHealthStatus(res as any);
    expect(body).toEqual({ status: 'ok' });
    expect(res.status).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  test('503 {status: "degraded"} without error details when the database throws', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const prisma: any = { $queryRaw: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED db.internal:5432')) };
    const res = mockRes();
    const body = await new AppController(prisma).getHealthStatus(res as any);
    expect(body).toEqual({ status: 'degraded' });
    expect(res.status).toHaveBeenCalledWith(503);
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|db\.internal|5432/);
  });

  test('503 when the database does not answer within the probe timeout (about 2 s)', async () => {
    expect(HEALTH_PROBE_TIMEOUT_MS).toBe(2000);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.useFakeTimers();
    const prisma: any = { $queryRaw: jest.fn().mockReturnValue(new Promise(() => undefined)) };
    const res = mockRes();
    const pending = new AppController(prisma).getHealthStatus(res as any);
    await jest.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS + 10);
    expect(await pending).toEqual({ status: 'degraded' });
    expect(res.status).toHaveBeenCalledWith(503);
  });

  test('503 when Redis is configured but unreachable; 200 when it answers', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const prisma: any = { $queryRaw: jest.fn().mockResolvedValue([1]) };
    const spy = jest.spyOn(AccountIpRateLimiterGuard, 'redisHealth').mockResolvedValue('down');
    const res = mockRes();
    expect(await new AppController(prisma).getHealthStatus(res as any)).toEqual({ status: 'degraded' });
    expect(res.status).toHaveBeenCalledWith(503);

    spy.mockResolvedValue('up');
    const res2 = mockRes();
    expect(await new AppController(prisma).getHealthStatus(res2 as any)).toEqual({ status: 'ok' });
    expect(res2.status).not.toHaveBeenCalled();
  });

  test('concurrent probes share one dependency check (cheap under load)', async () => {
    const prisma: any = { $queryRaw: jest.fn().mockResolvedValue([1]) };
    const controller = new AppController(prisma);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => controller.getHealthStatus(mockRes() as any)));
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  test('stays public, /health/details stays SUPER_ADMIN only, and successful probes are not request-logged', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AppController.prototype.getHealthStatus)).toBe(true);
    expect(Reflect.getMetadata(ROLES_KEY, AppController.prototype.getDetailedHealth)).toEqual([UserRole.SUPER_ADMIN]);
    expect(QUIET_SUCCESS_PATHS.has('/api/health')).toBe(true);

    const middleware = new RequestIdMiddleware();
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    (middleware as any).logger = logger;
    const run = (originalUrl: string, statusCode: number) => {
      let finish: () => void = () => undefined;
      const req: any = { headers: {}, method: 'GET', originalUrl, socket: { remoteAddress: '127.0.0.1' } };
      const res: any = { setHeader: jest.fn(), on: jest.fn((ev: string, cb: any) => ev === 'finish' && (finish = cb)), statusCode };
      middleware.use(req, res, jest.fn());
      finish();
    };
    run('/api/health', 200);
    expect(logger.log).not.toHaveBeenCalled();
    run('/api/health', 503);
    expect(logger.error).toHaveBeenCalledTimes(1);
    run('/api/events', 200);
    expect(logger.log).toHaveBeenCalledTimes(1);
  });
});

/** Test-only routes to observe the body parsers. */
@Controller()
class BodyEchoController {
  @Post('echo')
  echo(@Body() body: unknown) {
    return { size: JSON.stringify(body ?? null).length };
  }

  @Post('uploads')
  legacyUpload(@Body() body: unknown) {
    return { size: JSON.stringify(body ?? null).length };
  }
}

describe('3 and 6. CSP report endpoint and body limits (live Nest app)', () => {
  let app: INestApplication;
  let base: string;
  const warn = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [CspReportController, BodyEchoController] }).compile();
    app = moduleRef.createNestApplication({ logger: false, bodyParser: false });
    // Same order as apps/api/src/main.ts
    registerRouteBodyParsers(app);
    app.use(express.json({ limit: JSON_BODY_LIMIT }));
    app.use(express.urlencoded({ limit: URLENCODED_BODY_LIMIT, extended: true }));
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    (app.get(CspReportController) as any).logger = { warn };
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    AccountIpRateLimiterGuard.resetMemoryStore();
    warn.mockClear();
  });

  const post = (p: string, body: string, contentType: string) =>
    fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': contentType }, body });

  const legacyReport = {
    'csp-report': {
      'document-uri': 'https://www.gcdis.in/portal/reset-password?token=s3cr3t-token#frag',
      'violated-directive': 'script-src-elem',
      'effective-directive': 'script-src-elem',
      'blocked-uri': 'https://evil.example.com/x.js?session=abc123',
      'original-policy': "default-src 'self'"
    }
  };
  const reportingApiBody = [
    {
      type: 'csp-violation',
      url: 'https://admin.gcdis.in/teams?email=a@b.c',
      body: {
        documentURL: 'https://admin.gcdis.in/teams?email=a@b.c',
        effectiveDirective: 'require-trusted-types-for',
        blockedURL: 'trusted-types-sink',
        disposition: 'report'
      }
    },
    { type: 'deprecation', body: { id: 'x' } }
  ];

  test('accepts application/csp-report, returns 204 and logs a summary without query strings', async () => {
    const res = await post('/api/csp-report', JSON.stringify(legacyReport), 'application/csp-report');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('"directive":"script-src-elem"');
    expect(line).toContain('"blocked":"https://evil.example.com"');
    expect(line).toContain('"document":"/portal/reset-password"');
    expect(line).not.toMatch(/s3cr3t|abc123|x\.js|token|session|frag|original-policy|default-src/);
  });

  test('accepts application/reports+json (Reporting API batches), 204, csp-violation entries only', async () => {
    const res = await post('/api/csp-report', JSON.stringify(reportingApiBody), 'application/reports+json');
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('"directive":"require-trusted-types-for"');
    expect(line).toContain('"blocked":"trusted-types-sink"');
    expect(line).toContain('"document":"/teams"');
    expect(line).toContain('"disposition":"report"');
    expect(line).not.toContain('a@b.c');
  });

  test('needs no CSRF header or Origin, and junk bodies are accepted silently', async () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, CspReportController.prototype.receive)).toBe(true);
    const guards: any[] = Reflect.getMetadata('__guards__', CspReportController.prototype.receive) ?? [];
    expect(guards.map((g) => g.name)).toEqual(['AccountIpRateLimiterGuard']);
    const res = await post('/api/csp-report', 'not json at all', 'text/plain');
    expect(res.status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });

  test('bodies over 16 KB are refused with 413', async () => {
    expect(CSP_REPORT_BODY_LIMIT).toBe('16kb');
    const big = { 'csp-report': { 'document-uri': 'https://www.gcdis.in/', padding: 'x'.repeat(17 * 1024) } };
    const res = await post('/api/csp-report', JSON.stringify(big), 'application/csp-report');
    expect(res.status).toBe(413);
    expect(warn).not.toHaveBeenCalled();
  });

  test('rate limited per IP: 60 per minute, then 429', async () => {
    expect(CSP_REPORT_RATE_LIMIT).toEqual({ points: 60, duration: 60 });
    expect(Reflect.getMetadata(RATE_LIMIT_METADATA, CspReportController.prototype.receive)).toMatchObject({ points: 60, duration: 60 });
    const body = JSON.stringify(legacyReport);
    for (let i = 0; i < CSP_REPORT_RATE_LIMIT.points; i++) {
      const ok = await post('/api/csp-report', body, 'application/csp-report');
      expect(ok.status).toBe(204);
    }
    const limited = await post('/api/csp-report', body, 'application/csp-report');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });

  test('JSON bodies are limited to 1 MB; the legacy base64 upload route keeps its own larger limit', async () => {
    expect(JSON_BODY_LIMIT).toBe('1mb');
    expect(URLENCODED_BODY_LIMIT).toBe('1mb');
    expect(LEGACY_BASE64_UPLOAD_JSON_LIMIT).toBe('10mb');

    const small = JSON.stringify({ text: 'x'.repeat(500 * 1024) });
    expect((await post('/api/echo', small, 'application/json')).status).toBe(201);

    const large = JSON.stringify({ text: 'x'.repeat(1100 * 1024) });
    expect((await post('/api/echo', large, 'application/json')).status).toBe(413);
    const form = `text=${'x'.repeat(1100 * 1024)}`;
    expect((await post('/api/echo', form, 'application/x-www-form-urlencoded')).status).toBe(413);

    const upload = await post('/api/uploads', large, 'application/json');
    expect(upload.status).toBe(201);
    expect((await upload.json()).size).toBeGreaterThan(1100 * 1024);
  });

  test('summarizeCspReports ignores unknown shapes and keeps keyword sources', () => {
    expect(summarizeCspReports(null)).toEqual([]);
    expect(summarizeCspReports({ foo: 1 })).toEqual([]);
    expect(summarizeCspReports({ 'csp-report': { 'blocked-uri': 'inline', 'violated-directive': "script-src 'self'" } })).toEqual([
      { directive: 'script-src', blocked: 'inline', document: 'unknown' }
    ]);
    expect(summarizeCspReports({ 'csp-report': { 'blocked-uri': 'https://user:pw@cdn.example.com/a?b=c' } })[0].blocked).toBe(
      'https://cdn.example.com'
    );
  });

  test('main.ts wires the parsers in order with the 1 MB global limits', () => {
    const main = read('apps', 'api', 'src', 'main.ts');
    expect(main).not.toContain("'10mb'");
    const webhook = main.indexOf("'/api/payments/webhook'");
    const route = main.indexOf('registerRouteBodyParsers(app)');
    const json = main.indexOf('express.json({ limit: JSON_BODY_LIMIT })');
    const urlencoded = main.indexOf('express.urlencoded({ limit: URLENCODED_BODY_LIMIT, extended: true })');
    expect(webhook).toBeGreaterThan(-1);
    expect(route).toBeGreaterThan(webhook);
    expect(json).toBeGreaterThan(route);
    expect(urlencoded).toBeGreaterThan(json);
  });
});

type CspModule = {
  buildContentSecurityPolicy: (nonce: string) => string;
  buildTrustedTypesReportOnlyPolicy?: () => string;
  reportingEndpointsHeader: () => string | null;
  CSP_REPORT_URL: string | null;
};

function loadCsp(file: string, env: { NODE_ENV: string; NEXT_PUBLIC_API_URL?: string }): CspModule {
  const mutableEnv = process.env as Record<string, string | undefined>;
  const saved = { NODE_ENV: mutableEnv.NODE_ENV, NEXT_PUBLIC_API_URL: mutableEnv.NEXT_PUBLIC_API_URL };
  mutableEnv.NODE_ENV = env.NODE_ENV;
  if (env.NEXT_PUBLIC_API_URL) mutableEnv.NEXT_PUBLIC_API_URL = env.NEXT_PUBLIC_API_URL;
  else delete mutableEnv.NEXT_PUBLIC_API_URL;
  let mod: CspModule | undefined;
  try {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require(file) as CspModule;
    });
  } finally {
    mutableEnv.NODE_ENV = saved.NODE_ENV;
    if (saved.NEXT_PUBLIC_API_URL === undefined) delete mutableEnv.NEXT_PUBLIC_API_URL;
    else mutableEnv.NEXT_PUBLIC_API_URL = saved.NEXT_PUBLIC_API_URL;
  }
  return mod as CspModule;
}

async function nextConfigHeaders(app: 'web' | 'admin'): Promise<Record<string, string>> {
  // Evaluated in a VM context (plain CommonJS) so ts-jest does not try to compile the .js file
  const code = read('apps', app, 'next.config.js');
  const sandbox: any = { module: { exports: {} }, process, URL };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(code, sandbox, { filename: `${app}/next.config.js` });
  const config = sandbox.module.exports;
  const rules = await config.headers();
  const all = rules.find((r: any) => r.source === '/:path*');
  return Object.fromEntries(all.headers.map((h: any) => [h.key, h.value]));
}

describe('4 and 5. Web and console headers', () => {
  const PROD = { NODE_ENV: 'production', NEXT_PUBLIC_API_URL: 'https://api.gcdis.in/api' };
  const webCsp = path.join(rootDir, 'apps', 'web', 'src', 'lib', 'csp.ts');
  const adminCsp = path.join(rootDir, 'apps', 'admin', 'src', 'lib', 'csp.ts');

  test('web img-src lists exact Razorpay hosts (no wildcard); checkout, GSI and nonce sources are unchanged', () => {
    const policy = loadCsp(webCsp, PROD).buildContentSecurityPolicy('n0nce');
    expect(directive(policy, 'img-src')).toBe(
      "img-src 'self' data: blob: https://api.gcdis.in https://checkout.razorpay.com https://cdn.razorpay.com"
    );
    expect(policy).not.toContain('*.razorpay.com');
    expect(directive(policy, 'script-src')).toBe(
      "script-src 'self' 'nonce-n0nce' 'strict-dynamic' https://checkout.razorpay.com https://accounts.google.com/gsi/client"
    );
    expect(directive(policy, 'frame-src')).toBe(
      'frame-src https://api.razorpay.com https://checkout.razorpay.com https://accounts.google.com/gsi/'
    );
    expect(directive(policy, 'connect-src')).toContain('https://lumberjack.razorpay.com');
    expect(directive(policy, 'connect-src')).toContain('https://accounts.google.com/gsi/');
    expect(policy).toContain("frame-ancestors 'none'");
    const dev = loadCsp(webCsp, { NODE_ENV: 'development' }).buildContentSecurityPolicy('n');
    expect(directive(dev, 'script-src')).toContain("'unsafe-eval'");
  });

  test('web and console CSPs report to <api>/csp-report via report-uri and report-to', () => {
    for (const file of [webCsp, adminCsp]) {
      const mod = loadCsp(file, PROD);
      const policy = mod.buildContentSecurityPolicy('n');
      expect(mod.CSP_REPORT_URL).toBe('https://api.gcdis.in/api/csp-report');
      expect(directive(policy, 'report-uri')).toBe('report-uri https://api.gcdis.in/api/csp-report');
      expect(directive(policy, 'report-to')).toBe('report-to csp-endpoint');
      expect(mod.reportingEndpointsHeader()).toBe('csp-endpoint="https://api.gcdis.in/api/csp-report"');
      // The report endpoint's origin is already allowed for fetch/XHR
      expect(directive(policy, 'connect-src')).toContain('https://api.gcdis.in');
      const dev = loadCsp(file, { NODE_ENV: 'development' });
      expect(dev.CSP_REPORT_URL).toBe('http://localhost:4000/api/csp-report');
    }
  });

  test('console Trusted Types: enforced in production, report-only in development; names the Next.js policies', () => {
    const mod: any = loadCsp(adminCsp, PROD);
    const reportOnly = mod.buildTrustedTypesReportOnlyPolicy!();
    expect(reportOnly).toBe(
      "require-trusted-types-for 'script'; trusted-types nextjs nextjs#bundler 'allow-duplicates'; " +
        'report-uri https://api.gcdis.in/api/csp-report; report-to csp-endpoint'
    );
    // The base policy has no Trusted Types directives; production adds them (admin hardening: enforcement)
    expect(mod.buildContentSecurityPolicy('n')).not.toContain('trusted-types');
    expect(mod.withEnforcedTrustedTypes(mod.buildContentSecurityPolicy('n'))).toContain(
      "require-trusted-types-for 'script'; trusted-types nextjs nextjs#bundler 'allow-duplicates'"
    );
    expect(mod.trustedTypesMode({ NODE_ENV: 'production' })).toBe('enforce');
    expect(mod.trustedTypesMode({ NODE_ENV: 'development' })).toBe('report-only');
    expect(mod.trustedTypesMode({ NODE_ENV: 'production', ADMIN_TRUSTED_TYPES: 'report-only' })).toBe('report-only');
    const middleware = read('apps', 'admin', 'src', 'middleware.ts');
    expect(middleware).toContain("response.headers.set('Content-Security-Policy-Report-Only', buildTrustedTypesReportOnlyPolicy())");
    expect(middleware).toContain('withEnforcedTrustedTypes(baseCsp)');
  });

  test('middleware sets Reporting-Endpoints and Cross-Origin-Resource-Policy: same-site on page responses', () => {
    for (const app of ['web', 'admin']) {
      const code = read('apps', app, 'src', 'middleware.ts');
      expect(code).toContain("response.headers.set('Reporting-Endpoints', reportingEndpoints)");
      expect(code).toContain("response.headers.set('Cross-Origin-Resource-Policy', 'same-site')");
      expect(code).toContain("response.headers.set('Content-Security-Policy', csp)");
    }
    expect(read('apps', 'web', 'src', 'middleware.ts')).not.toContain('Report-Only');
  });

  const DENIED = [
    'camera', 'microphone', 'geolocation', 'usb', 'serial', 'bluetooth', 'hid', 'midi', 'magnetometer', 'gyroscope',
    'accelerometer', 'display-capture', 'idle-detection', 'browsing-topics', 'interest-cohort'
  ];
  const parsePolicy = (value: string) =>
    Object.fromEntries(value.split(/,\s*/).map((entry) => {
      const eq = entry.indexOf('=');
      return [entry.slice(0, eq), entry.slice(eq + 1)];
    }));

  test('web Permissions-Policy denies powerful features and allows payment for self and Razorpay only', async () => {
    const headers = await nextConfigHeaders('web');
    const policy = parsePolicy(headers['Permissions-Policy']);
    for (const feature of DENIED) expect(policy[feature]).toBe('()');
    expect(policy.payment).toBe('(self "https://checkout.razorpay.com" "https://api.razorpay.com")');
    expect(policy.fullscreen).toBe('(self)');
    expect(headers['X-Frame-Options']).toBe('DENY');
  });

  test('console Permissions-Policy is the same but denies payment', async () => {
    const headers = await nextConfigHeaders('admin');
    const policy = parsePolicy(headers['Permissions-Policy']);
    for (const feature of DENIED) expect(policy[feature]).toBe('()');
    expect(policy.payment).toBe('()');
    expect(policy.fullscreen).toBe('(self)');
    expect(headers['X-Frame-Options']).toBe('DENY');
  });
});

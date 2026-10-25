import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import * as express from 'express';
import cookieParser from 'cookie-parser';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { InMemoryPrisma } from './support/in-memory-prisma';

/**
 * Resilience (pillar 7): app-wide default rate limit, PDF endpoint limits and the encrypted pass cache, team /
 * registration / payment mutation limits, and the socket.io gateway's connection, payload and subscription caps.
 *
 * Boots the real AppModule over HTTP (every guard, including the global DefaultApiRateLimitGuard and the per-route
 * AccountIpRateLimiterGuard, on the in-memory rate-limit store) with Prisma replaced by an in-memory store. Tokens
 * are real session-bound JWTs. No database, Redis or external service is contacted.
 */

// ---------------------------------------------------------------------------------------------------------------
// Environment (test-only values, set before the application is compiled)

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'pillar7_test_public_jwt_secret_0123456789abcdef';
delete process.env.JWT_ADMIN_SECRET;
delete process.env.PASS_SIGNING_SECRET;
delete process.env.FILE_ENCRYPTION_KEY;
delete process.env.UPLOAD_SIGNING_SECRET;
process.env.COOKIE_SECRET = 'pillar7_test_cookie_secret_0123456789abcdef';
process.env.ADMIN_IP_ALLOWLIST = '';
process.env.CLAMAV_HOST = '';
process.env.CLAMAV_REQUIRED = '';
process.env.REDIS_URL = '';
process.env.TRUST_PROXY = '';
process.env.RAZORPAY_KEY_ID = 'rzp_pillar7_key';
process.env.RAZORPAY_KEY_SECRET = 'pillar7_razorpay_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'pillar7_webhook_secret';
process.env.PUBLIC_SITE_URL = 'http://localhost:3000';
process.env.ADMIN_SITE_URL = 'http://localhost:3001';
delete process.env.PUBLIC_ORIGIN;
delete process.env.ADMIN_ORIGIN;
delete process.env.API_DEFAULT_RATE_LIMIT_PER_MIN;
delete process.env.WS_MAX_CONNECTIONS_PER_IP;
delete process.env.WS_MAX_ROOMS_PER_SOCKET;

jest.mock('ioredis', () => {
  class FakeRedis {
    on() {
      return this;
    }
    connect() {
      return Promise.reject(new Error('redis disabled in tests'));
    }
    quit() {
      return Promise.resolve();
    }
    disconnect() {}
  }
  return { __esModule: true, default: FakeRedis };
});

/* eslint-disable @typescript-eslint/no-var-requires */
const { AppModule } = require('../apps/api/src/app.module');
const { PrismaService } = require('../apps/api/src/prisma/prisma.service');
const { GlobalExceptionFilter } = require('../apps/api/src/common/filters/global-exception.filter');
const { rejectNullBytes, rejectNullBytesInBody } = require('../apps/api/src/common/middleware/null-byte.middleware');
const { JSON_BODY_LIMIT, URLENCODED_BODY_LIMIT, registerRouteBodyParsers } = require('../apps/api/src/common/middleware/body-parsers');
const {
  AccountIpRateLimiterGuard,
  DEFAULT_API_RATE_LIMIT_PER_MIN,
  RATE_LIMIT_KEY,
  SKIP_DEFAULT_RATE_LIMIT_KEY,
  defaultApiRateLimitPerMinute
} = require('../apps/api/src/common/guards/rate-limiter.guard');
const { getAdminJwtSecret, getPublicJwtSecret } = require('../apps/api/src/auth/jwt-secrets');
const { PdfGeneratorService, passCacheFileName } = require('../apps/api/src/certificates/pdf-generator.service');
const { isEncryptedFile } = require('../apps/api/src/uploads/file-encryption');
const {
  ScoringGateway,
  WS_MAX_HTTP_BUFFER_SIZE,
  WS_DEFAULT_MAX_CONNECTIONS_PER_IP,
  WS_DEFAULT_MAX_ROOMS_PER_SOCKET
} = require('../apps/api/src/scoring/scoring.gateway');
const { AppController } = require('../apps/api/src/app.controller');
const { PaymentsController, PDF_DOWNLOAD_RATE_LIMIT, CREATE_ORDER_RATE_LIMIT } = require('../apps/api/src/payments/payments.controller');
const { CertificatesController } = require('../apps/api/src/certificates/certificates.controller');
const { CspReportController, CSP_REPORT_RATE_LIMIT } = require('../apps/api/src/security/csp-report.controller');
const { TeamsController, TEAM_MUTATION_RATE_LIMIT } = require('../apps/api/src/teams/teams.controller');
const { RegistrationsController } = require('../apps/api/src/registrations/registrations.controller');
/* eslint-enable @typescript-eslint/no-var-requires */

// ---------------------------------------------------------------------------------------------------------------
// Fixture (fresh ids per run so pass cache files never collide with other runs or specs)

const uid = () => crypto.randomUUID();
const ID = {
  capA: uid(),
  capB: uid(),
  SA: uid(),
  EA: uid(),
  INS: uid(),
  JUDGE: uid(),
  event: uid(),
  category: uid(),
  arena: uid(),
  teamA: uid(),
  teamB: uid(),
  memAcap: uid(),
  memA2: uid(),
  memBcap: uid(),
  regA: uid(),
  regB: uid(),
  payA: uid(),
  fixture: uid()
};
const ORDER_A = `order_p7_${crypto.randomBytes(4).toString('hex')}`;

type UserActor = 'capA' | 'capB' | 'SA' | 'EA' | 'INS' | 'JUDGE';
const STAFF: UserActor[] = ['SA', 'EA', 'INS', 'JUDGE'];
const USERS: Record<UserActor, { role: string; email: string; fullName: string }> = {
  capA: { role: 'TEAM_CAPTAIN', email: 'p7.alpha@pillar7.test', fullName: 'Captain Alpha' },
  capB: { role: 'TEAM_CAPTAIN', email: 'p7.bravo@pillar7.test', fullName: 'Captain Bravo' },
  SA: { role: 'SUPER_ADMIN', email: 'p7.sa@pillar7.test', fullName: 'Super Admin' },
  EA: { role: 'EVENT_ADMIN', email: 'p7.ea@pillar7.test', fullName: 'Event Admin' },
  INS: { role: 'INSPECTOR', email: 'p7.ins@pillar7.test', fullName: 'Inspector' },
  JUDGE: { role: 'JUDGE', email: 'p7.judge@pillar7.test', fullName: 'Judge' }
};
const SID: Record<UserActor, string> = { capA: uid(), capB: uid(), SA: uid(), EA: uid(), INS: uid(), JUDGE: uid() };

function seed(): Record<string, any[]> {
  const now = Date.now();
  const inOneHour = new Date(now + 3600000);
  const actors = Object.keys(USERS) as UserActor[];
  return {
    User: actors.map((a) => ({
      id: ID[a],
      email: USERS[a].email,
      passwordHash: '$2b$12$pillar7placeholderhashvaluepillar7placeholderhashxx',
      fullName: USERS[a].fullName,
      role: USERS[a].role,
      organization: 'Pillar 7 Institute',
      isTwoFactorEnabled: STAFF.includes(a),
      isActive: true,
      emailVerifiedAt: new Date(now - 86400000)
    })),
    Session: actors.map((a) => ({
      id: SID[a],
      userId: ID[a],
      familyId: SID[a],
      refreshTokenHash: `hash-${SID[a]}`,
      isActive: true,
      expiresAt: inOneHour,
      stepUpAt: STAFF.includes(a) ? new Date(now - 1000) : null
    })),
    Event: [{ id: ID.event, slug: `p7-${ID.event.slice(0, 8)}`, title: 'Drone Soccer', startDate: new Date('2026-12-01'), endDate: new Date('2026-12-03'), venueName: 'Arena' }],
    Category: [{ id: ID.category, eventId: ID.event, slug: `p7-${ID.category.slice(0, 8)}`, name: 'Class 20', entryFee: 1000, maxTeamSize: 7, isActive: true }],
    Arena: [{ id: ID.arena, eventId: ID.event, name: 'Arena 1', code: `A${ID.arena.slice(0, 4)}` }],
    Team: [
      { id: ID.teamA, categoryId: ID.category, name: 'TEAM ALPHA', code: 'GCDIS-2026-T701', captainId: ID.capA, institutionName: 'Alpha Institute', city: 'Delhi', isApprovedPublic: true },
      { id: ID.teamB, categoryId: ID.category, name: 'TEAM BRAVO', code: 'GCDIS-2026-T702', captainId: ID.capB, institutionName: 'Bravo Institute', city: 'Pune', isApprovedPublic: false }
    ],
    TeamMember: [
      { id: ID.memAcap, teamId: ID.teamA, userId: ID.capA, fullName: 'Captain Alpha', email: USERS.capA.email, memberRole: 'CAPTAIN', createdAt: new Date(now - 5000) },
      { id: ID.memA2, teamId: ID.teamA, fullName: 'Alpha Member', email: 'p7.member@pillar7.test', memberRole: 'PILOT', createdAt: new Date(now - 4000) },
      { id: ID.memBcap, teamId: ID.teamB, userId: ID.capB, fullName: 'Captain Bravo', email: USERS.capB.email, memberRole: 'CAPTAIN', createdAt: new Date(now - 5000) }
    ],
    Registration: [
      { id: ID.regA, registrationCode: 'GCDIS-2026-D20-7001', teamId: ID.teamA, categoryId: ID.category, status: 'DOCUMENT_REVIEW' },
      { id: ID.regB, registrationCode: 'GCDIS-2026-D20-7002', teamId: ID.teamB, categoryId: ID.category, status: 'DOCUMENT_REVIEW' }
    ],
    Payment: [
      { id: ID.payA, registrationId: ID.regA, orderId: ORDER_A, paymentId: 'pay_p7_0001', amount: 1180, baseAmount: 1000, gstRate: 18, gstAmount: 180, status: 'SUCCESS', paidAt: new Date(now - 7200000), gatewaySignature: 'sig' }
    ],
    Fixture: [{ id: ID.fixture, categoryId: ID.category, arenaId: ID.arena, matchNumber: 1, team1Id: ID.teamA, team2Id: ID.teamB, status: 'LIVE' }]
  };
}

function signAccess(actor: UserActor): string {
  const staff = STAFF.includes(actor);
  const aud = staff ? 'gcdis-admin' : 'gcdis-public';
  return jwt.sign(
    { sub: ID[actor], email: USERS[actor].email, role: USERS[actor].role, fullName: USERS[actor].fullName, aud, sid: SID[actor], mustChangePassword: false },
    staff ? getAdminJwtSecret() : getPublicJwtSecret(),
    { algorithm: 'HS256', expiresIn: '10m' }
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Harness

const db = new InMemoryPrisma();
let app: INestApplication;
let base = '';
const realFetch: typeof fetch = global.fetch;
const STORAGE_DIR = path.resolve(process.cwd(), 'storage');

interface Res {
  status: number;
  json: any;
  buf: Buffer;
  headers: Headers;
}

async function call(
  actor: UserActor | 'anon',
  method: string,
  p: string,
  opts: { body?: unknown; raw?: string; contentType?: string; headers?: Record<string, string> } = {}
): Promise<Res> {
  const headers: Record<string, string> = {
    origin: actor !== 'anon' && STAFF.includes(actor) ? 'http://localhost:3001' : 'http://localhost:3000',
    ...(opts.headers || {})
  };
  if (actor !== 'anon') headers.authorization = `Bearer ${signAccess(actor)}`;
  let body: any;
  if (opts.raw !== undefined) {
    headers['content-type'] = opts.contentType || 'application/json';
    body = opts.raw;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await realFetch(`${base}/api${p}`, { method, headers, body, redirect: 'manual' });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    json = null;
  }
  return { status: res.status, json, buf, headers: res.headers };
}

/** Sends `n` identical requests sequentially and returns their statuses. */
async function repeat(n: number, fn: () => Promise<Res>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await fn()).status);
  return out;
}

function reset() {
  db.reset(seed());
  AccountIpRateLimiterGuard.resetMemoryStore();
  delete process.env.API_DEFAULT_RATE_LIMIT_PER_MIN;
}

const passFiles = (memberId: string) =>
  fs.existsSync(STORAGE_DIR) ? fs.readdirSync(STORAGE_DIR).filter((f) => f.startsWith(`pass-${memberId}-`)) : [];

beforeAll(async () => {
  reset();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PrismaService).useValue(db).compile();
  app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  app.use(rejectNullBytes);
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use(
    '/api/payments/webhook',
    express.raw({ type: '*/*', limit: '1mb', verify: (req: any, _res: any, buf: Buffer) => (req.rawBody = Buffer.from(buf)) })
  );
  registerRouteBodyParsers(app);
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ limit: URLENCODED_BODY_LIMIT, extended: true }));
  app.use(rejectNullBytesInBody);
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
}, 60000);

beforeEach(() => reset());

afterAll(async () => {
  await app?.close();
  delete process.env.API_DEFAULT_RATE_LIMIT_PER_MIN;
  delete process.env.WS_MAX_CONNECTIONS_PER_IP;
  delete process.env.WS_MAX_ROOMS_PER_SOCKET;
  for (const m of [ID.memAcap, ID.memA2, ID.memBcap]) {
    for (const f of passFiles(m)) fs.rmSync(path.join(STORAGE_DIR, f), { force: true });
  }
  if (fs.existsSync(STORAGE_DIR)) {
    for (const f of fs.readdirSync(STORAGE_DIR).filter((n) => n.startsWith(`invoice-${ORDER_A}-`))) {
      fs.rmSync(path.join(STORAGE_DIR, f), { force: true });
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 1. App-wide default limit

describe('app-wide default rate limit', () => {
  test('API_DEFAULT_RATE_LIMIT_PER_MIN: positive integers only, otherwise 300', () => {
    expect(DEFAULT_API_RATE_LIMIT_PER_MIN).toBe(300);
    expect(defaultApiRateLimitPerMinute({} as any)).toBe(300);
    expect(defaultApiRateLimitPerMinute({ API_DEFAULT_RATE_LIMIT_PER_MIN: '120' } as any)).toBe(120);
    for (const bad of ['', '0', '-5', 'abc', '1.5', '1e3']) {
      expect(defaultApiRateLimitPerMinute({ API_DEFAULT_RATE_LIMIT_PER_MIN: bad } as any)).toBe(300);
    }
  });

  test('the default guard is registered globally, ahead of the authentication guards', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'src', 'app.module.ts'), 'utf8');
    const iDefault = src.indexOf('useClass: DefaultApiRateLimitGuard');
    expect(iDefault).toBeGreaterThan(0);
    expect(iDefault).toBeLessThan(src.indexOf('useClass: JwtAuthGuard'));
  });

  test('GET /teams/public answers 429 with Retry-After and the standard error body past the threshold', async () => {
    process.env.API_DEFAULT_RATE_LIMIT_PER_MIN = '5';
    const statuses = await repeat(5, () => call('anon', 'GET', '/teams/public'));
    expect(statuses).toEqual([200, 200, 200, 200, 200]);
    const res = await call('anon', 'GET', '/teams/public');
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(res.json).toMatchObject({ statusCode: 429, error: 'Too Many Requests', retryAfterSeconds: retryAfter });
    expect(String(res.json.message)).toMatch(/Rate limit threshold exceeded/);
  });

  test('the default bucket is per client IP across all default-limited routes (authenticated or not)', async () => {
    process.env.API_DEFAULT_RATE_LIMIT_PER_MIN = '4';
    await repeat(2, () => call('anon', 'GET', '/teams/public'));
    await repeat(2, () => call('capA', 'GET', '/teams/my-team'));
    expect((await call('anon', 'GET', '/events')).status).toBe(429);
    expect((await call('capB', 'GET', '/teams/my-team')).status).toBe(429);
    expect(AccountIpRateLimiterGuard.memoryKeyCount('ratelimit:default:')).toBe(1);
  });

  test('a request rejected by the default limit never reaches authentication or the handler', async () => {
    process.env.API_DEFAULT_RATE_LIMIT_PER_MIN = '1';
    await call('anon', 'GET', '/teams/public');
    const before = db.calls.length;
    const res = await call('capA', 'GET', '/teams/my-team');
    expect(res.status).toBe(429);
    expect(db.calls.length).toBe(before); // no session lookup, no team query
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Routes with their own @RateLimit keep exactly their rule

describe('per-route rules override the default', () => {
  test('a route with @RateLimit is not counted against, nor blocked by, the default bucket', async () => {
    process.env.API_DEFAULT_RATE_LIMIT_PER_MIN = '2';
    await repeat(3, () => call('anon', 'GET', '/teams/public')); // default bucket exhausted
    expect((await call('anon', 'GET', '/teams/public')).status).toBe(429);
    const statuses = await repeat(10, () => call('anon', 'GET', '/certificates/verify/GCDIS-CERT-2026-NOPE0001'));
    expect(statuses.every((s) => s === 200)).toBe(true);
    // Only the three /teams/public hits are in the default bucket
    const counter = await AccountIpRateLimiterGuard.readCounter(
      `ratelimit:default:${[...(AccountIpRateLimiterGuard as any).memoryStore.keys()].find((k: string) => k.startsWith('ratelimit:default:')).slice('ratelimit:default:'.length)}`
    );
    expect(counter.count).toBe(4);
  });

  test('a raised default does not loosen a per-route rule (certificate verify stays at 30 per minute)', async () => {
    process.env.API_DEFAULT_RATE_LIMIT_PER_MIN = '100000';
    const statuses = await repeat(31, () => call('anon', 'GET', '/certificates/verify/GCDIS-CERT-2026-NOPE0001'));
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(AccountIpRateLimiterGuard.memoryKeyCount('ratelimit:default:')).toBe(0);
  });

  test('every route either declares @RateLimit or is covered by the default (only the exemptions skip both)', () => {
    const exempt: string[] = [];
    for (const ctrl of [AppController, PaymentsController, CertificatesController, CspReportController, TeamsController, RegistrationsController]) {
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const handler = ctrl.prototype[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        if (Reflect.getMetadata(SKIP_DEFAULT_RATE_LIMIT_KEY, handler)) exempt.push(`${ctrl.name}.${name}`);
      }
    }
    expect(exempt.sort()).toEqual(['AppController.getHealthStatus', 'PaymentsController.handleWebhook']);
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, CspReportController.prototype.receive)).toEqual(CSP_REPORT_RATE_LIMIT);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Exemptions

describe('exemptions', () => {
  test('GET /health is never rate limited', async () => {
    process.env.API_DEFAULT_RATE_LIMIT_PER_MIN = '2';
    await repeat(3, () => call('anon', 'GET', '/teams/public'));
    const statuses = await repeat(15, () => call('anon', 'GET', '/health'));
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  test('POST /payments/webhook is never rate limited (Razorpay retries)', async () => {
    process.env.API_DEFAULT_RATE_LIMIT_PER_MIN = '2';
    await repeat(3, () => call('anon', 'GET', '/teams/public'));
    const statuses = await repeat(15, () =>
      call('anon', 'POST', '/payments/webhook', {
        raw: JSON.stringify({ event: 'payment.captured', payload: {} }),
        headers: { 'x-razorpay-signature': 'invalid', 'x-razorpay-event-id': `evt_${crypto.randomUUID()}` }
      })
    );
    expect(statuses).not.toContain(429);
    expect(statuses.every((s) => s >= 400 && s < 500)).toBe(true); // rejected for the bad signature only
  });

  test('POST /csp-report keeps its own limit (60 per minute), independent of the default', async () => {
    process.env.API_DEFAULT_RATE_LIMIT_PER_MIN = '2';
    await repeat(3, () => call('anon', 'GET', '/teams/public'));
    const report = JSON.stringify({ 'csp-report': { 'effective-directive': 'script-src', 'blocked-uri': 'https://evil.example/x.js', 'document-uri': 'http://localhost:3000/' } });
    const statuses = await repeat(61, () => call('anon', 'POST', '/csp-report', { raw: report, contentType: 'application/csp-report' }));
    expect(statuses.slice(0, 60).every((s) => s === 204)).toBe(true);
    expect(statuses[60]).toBe(429);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. PDF endpoints: limits and the pass cache

describe('PDF endpoints', () => {
  test('the PDF rule is about 10 per minute per user plus 30 per IP', () => {
    expect(PDF_DOWNLOAD_RATE_LIMIT).toMatchObject({ points: 10, duration: 60, ipPoints: 30 });
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, CertificatesController.prototype.downloadPassPdf)).toMatchObject(PDF_DOWNLOAD_RATE_LIMIT);
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, PaymentsController.prototype.downloadInvoicePdf)).toMatchObject(PDF_DOWNLOAD_RATE_LIMIT);
  });

  test('pass PDF: 10 downloads per minute per user, then 429; another user is unaffected', async () => {
    const statuses = await repeat(11, () => call('capA', 'GET', `/certificates/pass/${ID.memA2}/pdf`));
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    const res = await call('capA', 'GET', `/certificates/pass/${ID.memA2}/pdf`);
    expect(statuses[10]).toBe(429);
    expect(res.status).toBe(429);
    expect(String(res.json?.message)).toMatch(/Too many PDF downloads/);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await call('SA', 'GET', `/certificates/pass/${ID.memA2}/pdf`)).status).toBe(200);
  }, 30000);

  test('pass PDF: the per-IP bucket (30) caps several users on one address', async () => {
    for (const actor of ['capA', 'SA', 'EA'] as UserActor[]) {
      const statuses = await repeat(10, () => call(actor, 'GET', `/certificates/pass/${ID.memA2}/pdf`));
      expect(statuses).toEqual(Array(10).fill(200));
    }
    expect((await call('INS', 'GET', `/certificates/pass/${ID.memA2}/pdf`)).status).toBe(429);
  }, 30000);

  test('invoice PDF: 10 downloads per minute per user, then 429', async () => {
    const statuses = await repeat(11, () => call('capA', 'GET', `/payments/invoice/${ID.payA}/pdf`));
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
  }, 30000);

  test('who may download is unchanged (another captain is still denied, anonymous is 401)', async () => {
    expect([403, 404]).toContain((await call('capB', 'GET', `/certificates/pass/${ID.memA2}/pdf`)).status);
    expect([403, 404]).toContain((await call('capB', 'GET', `/payments/invoice/${ID.payA}/pdf`)).status);
    expect((await call('anon', 'GET', `/certificates/pass/${ID.memA2}/pdf`)).status).toBe(401);
    expect((await call('JUDGE', 'GET', `/certificates/pass/${ID.memA2}/pdf`)).status).toBe(403);
  });

  describe('pass cache', () => {
    let render: jest.SpyInstance;
    beforeEach(() => {
      for (const f of passFiles(ID.memA2)) fs.rmSync(path.join(STORAGE_DIR, f), { force: true });
      render = jest.spyOn(PdfGeneratorService.prototype as any, 'renderAccreditationPassPdf');
    });
    afterEach(() => render.mockRestore());

    test('the second download is served from the encrypted cache without re-rendering', async () => {
      const first = await call('capA', 'GET', `/certificates/pass/${ID.memA2}/pdf`);
      expect(first.status).toBe(200);
      expect(first.buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(render).toHaveBeenCalledTimes(1);

      const files = passFiles(ID.memA2);
      expect(files).toHaveLength(1);
      const stored = fs.readFileSync(path.join(STORAGE_DIR, files[0]));
      expect(isEncryptedFile(stored)).toBe(true);
      expect(stored.includes(Buffer.from('%PDF-'))).toBe(false);
      expect(stored.includes(Buffer.from('Alpha Member'))).toBe(false);

      const second = await call('SA', 'GET', `/certificates/pass/${ID.memA2}/pdf`);
      expect(second.status).toBe(200);
      expect(render).toHaveBeenCalledTimes(1);
      expect(second.buf.equals(first.buf)).toBe(true);
    }, 30000);

    test.each([
      ['the member', () => (db.rows('TeamMember').find((m) => m.id === ID.memA2)!.fullName = 'Alpha Member Renamed')],
      ['the member role', () => (db.rows('TeamMember').find((m) => m.id === ID.memA2)!.memberRole = 'TECHNICIAN')],
      ['the registration status', () => (db.rows('Registration').find((r) => r.id === ID.regA)!.status = 'APPROVED')],
      ['the team name', () => (db.rows('Team').find((t) => t.id === ID.teamA)!.name = 'TEAM ALPHA PRIME')],
      ['the team institution', () => (db.rows('Team').find((t) => t.id === ID.teamA)!.institutionName = 'Alpha Institute of Technology')],
      ['the category', () => (db.rows('Category').find((c) => c.id === ID.category)!.name = 'Class 40')]
    ])('a change to %s invalidates the cached pass (new file, old one removed)', async (_label, mutate) => {
      expect((await call('capA', 'GET', `/certificates/pass/${ID.memA2}/pdf`)).status).toBe(200);
      const [before] = passFiles(ID.memA2);
      expect(render).toHaveBeenCalledTimes(1);

      mutate();
      const res = await call('capA', 'GET', `/certificates/pass/${ID.memA2}/pdf`);
      expect(res.status).toBe(200);
      expect(render).toHaveBeenCalledTimes(2);
      const after = passFiles(ID.memA2);
      expect(after).toHaveLength(1);
      expect(after[0]).not.toBe(before);

      // and the new copy is cached in turn
      expect((await call('capA', 'GET', `/certificates/pass/${ID.memA2}/pdf`)).status).toBe(200);
      expect(render).toHaveBeenCalledTimes(2);
    }, 30000);

    test('a tampered or plaintext cache file is ignored and re-rendered', async () => {
      expect((await call('capA', 'GET', `/certificates/pass/${ID.memA2}/pdf`)).status).toBe(200);
      const [file] = passFiles(ID.memA2);
      fs.writeFileSync(path.join(STORAGE_DIR, file), Buffer.from('%PDF-1.4 forged plaintext'));
      const res = await call('capA', 'GET', `/certificates/pass/${ID.memA2}/pdf`);
      expect(res.status).toBe(200);
      expect(res.buf.toString('latin1')).not.toContain('forged');
      expect(render).toHaveBeenCalledTimes(2);
    }, 30000);

    test('the cache file name hashes every rendered field', () => {
      const data = { teamName: 'T', teamId: 'C', institution: 'I', memberName: 'M', memberRole: 'PILOT', category: 'K', status: 'S', qrUrl: 'q' };
      const name = passCacheFileName('m1', data);
      expect(name).toMatch(/^pass-m1-[0-9a-f]{32}\.pdf$/);
      for (const k of Object.keys(data)) {
        expect(passCacheFileName('m1', { ...data, [k]: `${(data as any)[k]}x` })).not.toBe(name);
      }
      expect(passCacheFileName('../../etc', data)).toMatch(/^pass-______etc-/);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. Team / registration / payment mutation limits

describe('mutation limits', () => {
  test('team routes declare 30 per 10 minutes per user plus a per-IP bucket', () => {
    expect(TEAM_MUTATION_RATE_LIMIT).toMatchObject({ points: 30, duration: 600 });
    expect(TEAM_MUTATION_RATE_LIMIT.ipPoints).toBeGreaterThan(30);
    for (const m of ['createTeam', 'addMember', 'updateMember', 'removeMember']) {
      expect(Reflect.getMetadata(RATE_LIMIT_KEY, TeamsController.prototype[m])).toMatchObject(TEAM_MUTATION_RATE_LIMIT);
    }
    for (const m of ['createRegistration', 'transitionStatus', 'addDocument', 'verifyDocument']) {
      expect(Reflect.getMetadata(RATE_LIMIT_KEY, RegistrationsController.prototype[m])).toBeDefined();
    }
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, PaymentsController.prototype.createOrder)).toMatchObject({ points: 10, duration: 600 });
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, PaymentsController.prototype.verifyPaymentSignature)).toBeDefined();
  });

  test.each([
    ['POST /teams', 'POST', () => '/teams'],
    ['POST /teams/:id/members', 'POST', () => `/teams/${ID.teamA}/members`],
    ['PATCH /teams/:id/members/:memberId', 'PATCH', () => `/teams/${ID.teamA}/members/${ID.memA2}`],
    ['DELETE /teams/:id/members/:memberId', 'DELETE', () => `/teams/${ID.teamA}/members/${uid()}`]
  ])('%s: 30 requests per 10 minutes per captain, the 31st is 429; another captain is unaffected', async (_l, method, p) => {
    // Invalid bodies: each request passes the guards and is then rejected by validation / the service (no state change)
    const body = method === 'DELETE' ? undefined : { name: '' };
    const statuses = await repeat(31, () => call('capA', method, p(), { body }));
    expect(statuses.slice(0, 30)).not.toContain(429);
    expect(statuses[30]).toBe(429);
    expect((await call('capB', method, p(), { body })).status).not.toBe(429);
  }, 30000);

  test('POST /payments/create-order: 10 per 10 minutes per captain', async () => {
    expect(CREATE_ORDER_RATE_LIMIT).toMatchObject({ points: 10, duration: 600 });
    const statuses = await repeat(11, () => call('capA', 'POST', '/payments/create-order', { body: {} }));
    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(statuses[10]).toBe(429);
  });

  test('POST /registrations: 10 per 10 minutes per captain', async () => {
    const statuses = await repeat(11, () => call('capA', 'POST', '/registrations', { body: {} }));
    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(statuses[10]).toBe(429);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 6. Socket.io gateway

describe('scoring gateway resilience', () => {
  const open: ClientSocket[] = [];
  const gateway = () => app.get(ScoringGateway);

  function connect(): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const s = ioClient(base, { transports: ['websocket'], forceNew: true, reconnection: false });
      open.push(s);
      s.once('connect', () => resolve(s));
      s.once('connect_error', (err) => reject(err));
    });
  }

  async function waitFor(cond: () => boolean, ms = 3000) {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  function request(s: ClientSocket, event: string, payload?: unknown): Promise<{ ack?: any; exception?: any }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({}), 3000);
      const onException = (e: any) => {
        clearTimeout(timer);
        resolve({ exception: e });
      };
      s.once('exception', onException);
      const ack = (a: any) => {
        clearTimeout(timer);
        s.off('exception', onException);
        resolve({ ack: a });
      };
      if (payload === undefined) s.emit(event, ack);
      else s.emit(event, payload, ack);
    });
  }

  afterEach(async () => {
    for (const s of open.splice(0)) s.disconnect();
    await waitFor(() => gateway().trackedIpCount() === 0);
    delete process.env.WS_MAX_CONNECTIONS_PER_IP;
    delete process.env.WS_MAX_ROOMS_PER_SOCKET;
  });

  test('defaults: 16 KB messages, 20 connections per IP, 10 rooms per socket', () => {
    expect(WS_MAX_HTTP_BUFFER_SIZE).toBe(16 * 1024);
    expect(WS_DEFAULT_MAX_CONNECTIONS_PER_IP).toBe(20);
    expect(WS_DEFAULT_MAX_ROOMS_PER_SOCKET).toBe(10);
    expect(ScoringGateway.maxConnectionsPerIp()).toBe(20);
    expect(ScoringGateway.maxRoomsPerSocket()).toBe(10);
    expect((gateway().server as any).engine.opts.maxHttpBufferSize).toBe(16 * 1024);
  });

  test('connections beyond the per-IP cap are refused at once with an error; slots are released on disconnect', async () => {
    process.env.WS_MAX_CONNECTIONS_PER_IP = '3';
    const a = await connect();
    await connect();
    await connect();
    const ip = [...(gateway() as any).connectionsPerIp.keys()][0];
    expect(gateway().connectionCount(ip)).toBe(3);

    const err: any = await connect().then(
      () => null,
      (e) => e
    );
    expect(err).toBeTruthy();
    expect(String(err.message)).toMatch(/Too many connections/);
    expect(err.data).toEqual({ code: 'TOO_MANY_CONNECTIONS' });
    expect(gateway().connectionCount(ip)).toBe(3); // the refused socket holds no slot

    a.disconnect();
    await waitFor(() => gateway().connectionCount(ip) === 2);
    const again = await connect();
    expect(again.connected).toBe(true);
    expect(gateway().connectionCount(ip)).toBe(3);
  }, 20000);

  test('connect / disconnect are not logged per connection (no console.log)', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const s = await connect();
      s.disconnect();
      await waitFor(() => gateway().trackedIpCount() === 0);
      expect(log.mock.calls.filter((c) => /WebSocket/i.test(String(c[0])))).toEqual([]);
    } finally {
      log.mockRestore();
    }
    const src = fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'src', 'scoring', 'scoring.gateway.ts'), 'utf8');
    expect(src).not.toMatch(/console\.(log|info)/);
  });

  test('a message larger than 16 KB closes the connection; normal messages work', async () => {
    const s = await connect();
    expect((await request(s, 'join_summary_channel')).ack).toEqual({ status: 'joined', room: 'public_summary' });
    const closed = new Promise<string>((resolve) => s.once('disconnect', (reason) => resolve(String(reason))));
    s.emit('join_match_room', { fixtureId: 'x'.repeat(WS_MAX_HTTP_BUFFER_SIZE + 1024) });
    expect(await closed).toMatch(/transport close|transport error/);
    await waitFor(() => gateway().trackedIpCount() === 0);
  }, 15000);

  test('room subscriptions are capped per socket (10 by default)', async () => {
    const s = await connect();
    expect((await request(s, 'join_summary_channel')).ack?.status).toBe('joined');
    for (let i = 1; i <= 9; i++) {
      expect((await request(s, 'join_match_room', { fixtureId: `fx-${i}` })).ack?.status).toBe('joined');
    }
    const over = await request(s, 'join_match_room', { fixtureId: 'fx-10' });
    expect(String(over.exception?.message)).toMatch(/Subscription limit/);
    // re-joining a held room is free; leaving frees a slot
    expect((await request(s, 'join_match_room', { fixtureId: 'fx-1' })).ack?.status).toBe('joined');
    expect((await request(s, 'leave_match_room', { fixtureId: 'fx-1' })).ack?.status).toBe('left');
    expect((await request(s, 'join_match_room', { fixtureId: 'fx-10' })).ack?.status).toBe('joined');
  }, 20000);

  test('subscription requests are rate limited per socket', async () => {
    const s = await connect();
    const results = [];
    for (let i = 0; i < 21; i++) results.push(await request(s, 'join_summary_channel'));
    expect(results.slice(0, 20).every((r) => r.ack?.status === 'joined')).toBe(true);
    expect(String(results[20].exception?.message)).toMatch(/Too many subscription requests/);
  }, 20000);

  test('invalid fixture ids never name a room', async () => {
    const s = await connect();
    const r = await request(s, 'join_match_room', { fixtureId: '../../admin room' });
    expect(String(r.exception?.message)).toMatch(/invalid fixtureId/);
  });
});

describe('scoring gateway connection accounting (unit)', () => {
  const mkGateway = (prisma?: any) => {
    const jwtStub = {
      verify: (t: string) => {
        if (t === 'judge') return { sub: 'judge-1', sid: 'sess-1', role: 'JUDGE', email: 'j@x', fullName: 'Judge' };
        throw new Error('bad');
      }
    };
    const competition = {
      findFixtureById: async () => ({ id: 'fx', team1Id: 't1', team2Id: 't2' }),
      logMatchEvent: async () => ({ id: 'fx', matchNumber: 1, status: 'LIVE', team1Score: 1, team2Score: 0, winnerId: null })
    };
    const g = new ScoringGateway(competition as any, jwtStub as any, prisma);
    g.server = { to: () => ({ emit: () => undefined }) } as any;
    return g;
  };
  const sock = (id: string, address: string, headers: Record<string, string> = {}): any => ({
    id,
    data: {},
    handshake: { address, headers, auth: {} },
    request: { headers, socket: { remoteAddress: address } },
    join: jest.fn(),
    leave: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn()
  });

  afterEach(() => {
    delete process.env.WS_MAX_CONNECTIONS_PER_IP;
    delete process.env.TRUST_PROXY;
  });

  test('counts per IP, refuses at the cap, and decrements exactly once per admitted socket', () => {
    process.env.WS_MAX_CONNECTIONS_PER_IP = '2';
    const g = mkGateway();
    const s1 = sock('s1', '10.0.0.1');
    const s2 = sock('s2', '10.0.0.1');
    const s3 = sock('s3', '10.0.0.1');
    const other = sock('o1', '10.0.0.2');
    expect(g.admitConnection(s1)).toBe(true);
    expect(g.admitConnection(s2)).toBe(true);
    expect(g.admitConnection(s3)).toBe(false);
    expect(g.admitConnection(other)).toBe(true);
    expect(g.connectionCount('10.0.0.1')).toBe(2);

    g.handleDisconnect(s3); // never admitted: holds no slot
    expect(g.connectionCount('10.0.0.1')).toBe(2);
    g.handleDisconnect(s1);
    g.handleDisconnect(s1); // idempotent
    g.releaseConnection(s1);
    expect(g.connectionCount('10.0.0.1')).toBe(1);
    g.handleDisconnect(s2);
    g.handleDisconnect(other);
    expect(g.trackedIpCount()).toBe(0);
  });

  test('handleConnection disconnects an uncounted socket over the cap with an error event', () => {
    process.env.WS_MAX_CONNECTIONS_PER_IP = '1';
    const g = mkGateway();
    g.handleConnection(sock('a', '10.0.0.9'));
    const extra = sock('b', '10.0.0.9');
    g.handleConnection(extra);
    expect(extra.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'TOO_MANY_CONNECTIONS' }));
    expect(extra.disconnect).toHaveBeenCalledWith(true);
    expect(g.connectionCount('10.0.0.9')).toBe(1);
  });

  test('X-Forwarded-For is ignored unless TRUST_PROXY trusts the hop', () => {
    const spoofed = sock('s', '127.0.0.1', { 'x-forwarded-for': '203.0.113.7' });
    expect(mkGateway().clientIpOf(spoofed)).toBe('127.0.0.1');
    process.env.TRUST_PROXY = '1';
    expect(mkGateway().clientIpOf(spoofed)).toBe('203.0.113.7');
  });

  test('the per-socket score event limit (eventTimestamps) still applies and is cleared on disconnect', async () => {
    const g = mkGateway();
    const judge = sock('judge-sock', '10.0.0.5', { authorization: 'Bearer judge' });
    const evt = { fixtureId: 'fx', teamId: 't1', eventType: 'GOAL', scoreDelta: 1 };
    for (let i = 0; i < 10; i++) await expect(g.handleScoreEvent(evt as any, judge)).resolves.toMatchObject({ status: 'ok' });
    await expect(g.handleScoreEvent(evt as any, judge)).rejects.toThrow(/Rate limit exceeded/);
    // keyed on the user id, so a reconnect does not reset it ...
    await expect(g.handleScoreEvent(evt as any, sock('judge-sock-2', '10.0.0.5', { authorization: 'Bearer judge' }))).rejects.toThrow(/Rate limit exceeded/);
    // ... and a disconnect clears the socket's own entries without error
    g.handleDisconnect(judge);
    expect((g as any).eventTimestamps.has('judge-sock')).toBe(false);
  });

  test('score_event authentication is unchanged (no token: Unauthorized)', async () => {
    const g = mkGateway();
    await expect(g.handleScoreEvent({ fixtureId: 'fx', teamId: 't1', eventType: 'GOAL', scoreDelta: 1 } as any, sock('anon', '10.0.0.6'))).rejects.toThrow(/Unauthorized/);
  });
});

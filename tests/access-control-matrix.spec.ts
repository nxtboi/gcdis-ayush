import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import * as express from 'express';
import cookieParser from 'cookie-parser';
import { INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { InMemoryPrisma } from './support/in-memory-prisma';

/**
 * Access-control matrix (IDOR / BOLA and BFLA) for the NestJS API.
 *
 * Boots the real AppModule (every controller, the global JwtAuthGuard + RolesGuard, AudienceRolesGuard, CsrfGuard,
 * StepUpGuard, EmailVerifiedGuard, the rate limiter, the real JwtStrategy and all services) over HTTP, with Prisma
 * replaced by an in-memory store seeded with two captains (A and B) and their objects, four staff roles, an
 * unverified captain and an anonymous caller. Access tokens are real HS256 session-bound JWTs.
 *
 * Every request starts from a fresh copy of the fixture, so write attempts never affect the next row.
 * Outbound HTTP (Razorpay, HIBP) is stubbed; no database, Redis or external service is contacted.
 */

// ---------------------------------------------------------------------------------------------------------------
// Environment (set before the application is compiled; secrets here are test-only values)

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'acl_matrix_test_public_jwt_secret_0123456789abcdef';
delete process.env.JWT_ADMIN_SECRET;
delete process.env.UPLOAD_SIGNING_SECRET;
delete process.env.PASS_SIGNING_SECRET;
delete process.env.FILE_ENCRYPTION_KEY;
process.env.COOKIE_SECRET = 'acl_matrix_test_cookie_secret_0123456789abcdef';
process.env.ADMIN_IP_ALLOWLIST = '';
process.env.CLAMAV_HOST = '';
process.env.CLAMAV_REQUIRED = '';
process.env.REDIS_URL = '';
// The matrix sends many requests from one IP: raise the app-wide default per-IP limit (the limiter itself is
// covered by tests/resilience-pillar7.spec.ts); per-route limits are unchanged and reset before every row.
process.env.API_DEFAULT_RATE_LIMIT_PER_MIN = '100000';
process.env.RAZORPAY_KEY_ID = 'rzp_acl_matrix_key';
process.env.RAZORPAY_KEY_SECRET = 'acl_matrix_razorpay_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'acl_matrix_webhook_secret';
process.env.PUBLIC_SITE_URL = 'http://localhost:3000';
process.env.ADMIN_SITE_URL = 'http://localhost:3001';
delete process.env.PUBLIC_ORIGIN;
delete process.env.ADMIN_ORIGIN;

// ioredis must never reach a developer's Redis (PaymentsService connects eagerly)
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
const { AccountIpRateLimiterGuard } = require('../apps/api/src/common/guards/rate-limiter.guard');
const { getAdminJwtSecret, getPublicJwtSecret } = require('../apps/api/src/auth/jwt-secrets');
const { IS_PUBLIC_KEY } = require('../apps/api/src/common/decorators/public.decorator');
/* eslint-enable @typescript-eslint/no-var-requires */

const CONTROLLER_FILES = [
  ['app.controller', 'AppController'],
  ['audit/audit.controller', 'AuditController'],
  ['auth/auth.controller', 'AuthController'],
  ['certificates/certificates.controller', 'CertificatesController'],
  ['cms/cms.controller', 'CMSController'],
  ['cms/home-content.controller', 'HomeContentController'],
  ['cms/championship-media.controller', 'ChampionshipMediaController'],
  ['cms/site-content.controller', 'SiteContentController'],
  ['competition/competition.controller', 'CompetitionController'],
  ['events/events.controller', 'EventsController'],
  ['inspection/inspection.controller', 'InspectionController'],
  ['mail/mail.controller', 'MailController'],
  ['payments/payments.controller', 'PaymentsController'],
  ['registrations/registrations.controller', 'RegistrationsController'],
  ['security/csp-report.controller', 'CspReportController'],
  ['teams/teams.controller', 'TeamsController'],
  ['uploads/uploads.controller', 'UploadsController']
] as const;

// ---------------------------------------------------------------------------------------------------------------
// Fixture

const id = (group: number, n: number) => `${String(group).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ID = {
  capA: id(1, 1),
  capB: id(1, 2),
  capU: id(1, 3),
  SA: id(1, 10),
  EA: id(1, 11),
  INS: id(1, 12),
  JUDGE: id(1, 13),
  event: id(2, 1),
  category: id(2, 2),
  arena: id(2, 3),
  teamA: id(3, 1),
  teamB: id(3, 2),
  memAcap: id(4, 1),
  memA2: id(4, 2),
  memBcap: id(4, 3),
  memB2: id(4, 4),
  regA: id(5, 1),
  regB: id(5, 2),
  docA: id(6, 1),
  docB: id(6, 2),
  payA: id(7, 1),
  payB: id(7, 2),
  inspA: id(8, 1),
  inspB: id(8, 2),
  certA: id(9, 1),
  certB: id(9, 2),
  assetAdoc: id(10, 1),
  assetAid: id(10, 2),
  assetAfree: id(10, 3),
  assetBdoc: id(10, 4),
  assetBid: id(10, 5),
  assetBfree: id(10, 6),
  assetPublic: id(10, 7),
  fixture: id(11, 1),
  sponsor: id(12, 1),
  gallery: id(12, 2),
  prize: id(12, 3),
  sessA2: id(13, 1),
  sessB2: id(13, 2)
};

const ACTORS = ['anon', 'capA', 'capB', 'capU', 'SA', 'EA', 'INS', 'JUDGE'] as const;
type Actor = (typeof ACTORS)[number];
type UserActor = Exclude<Actor, 'anon'>;
const STAFF_ACTORS: UserActor[] = ['SA', 'EA', 'INS', 'JUDGE'];
const isStaff = (a: Actor) => (STAFF_ACTORS as string[]).includes(a);

const USER_DEF: Record<UserActor, { role: string; email: string; fullName: string; phone: string; verified: boolean }> = {
  capA: { role: 'TEAM_CAPTAIN', email: 'captain.alpha@acl.test', fullName: 'Captain Alpha', phone: '+91 90000 11111', verified: true },
  capB: { role: 'TEAM_CAPTAIN', email: 'captain.bravo@acl.test', fullName: 'Captain Bravo', phone: '+91 90000 22222', verified: true },
  capU: { role: 'TEAM_CAPTAIN', email: 'captain.unverified@acl.test', fullName: 'Captain Unverified', phone: '+91 90000 33333', verified: false },
  SA: { role: 'SUPER_ADMIN', email: 'super.admin@acl.test', fullName: 'Super Admin', phone: '', verified: true },
  EA: { role: 'EVENT_ADMIN', email: 'event.admin@acl.test', fullName: 'Event Admin', phone: '', verified: true },
  INS: { role: 'INSPECTOR', email: 'inspector@acl.test', fullName: 'Inspector', phone: '', verified: true },
  JUDGE: { role: 'JUDGE', email: 'judge@acl.test', fullName: 'Judge', phone: '', verified: true }
};

/** Session id of each actor's main session. */
const SID: Record<UserActor, string> = {
  capA: id(13, 101),
  capB: id(13, 102),
  capU: id(13, 103),
  SA: id(13, 110),
  EA: id(13, 111),
  INS: id(13, 112),
  JUDGE: id(13, 113)
};

const RUN = crypto.randomBytes(4).toString('hex');
const key = (label: string, ext = 'pdf') => `${crypto.randomUUID()}_${crypto.createHash('sha256').update(label + RUN).digest('hex').slice(0, 16)}.${ext}`;
const KEY = {
  Adoc: key('Adoc'),
  Aid: key('Aid'),
  Afree: key('Afree'),
  Bdoc: key('Bdoc'),
  Bid: key('Bid'),
  Bfree: key('Bfree'),
  public: key('public', 'png')
};
const url = (k: string) => `/api/uploads/files/${k}`;

/** Values that must never reach anyone but captain A, staff and (where legitimate) the public team page. */
const A_PRIVATE = [
  USER_DEF.capA.email,
  USER_DEF.capA.phone,
  'alpha.member@acl.test',
  '+91 98888 00001',
  KEY.Adoc,
  KEY.Aid,
  'pay_A_0001',
  'A-PRIVATE-FILE-CONTENT'
];
/** Captain B's private values: never visible to A or anonymous callers. */
const B_PRIVATE = [USER_DEF.capB.email, USER_DEF.capB.phone, 'bravo.member@acl.test', '+91 98888 00002', KEY.Bdoc, KEY.Bid, 'pay_B_0001'];

const PDF = (label: string) => Buffer.from(`%PDF-1.4\n%${label}\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF`);
// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function seed(): Record<string, any[]> {
  const now = Date.now();
  const inOneHour = new Date(now + 60 * 60 * 1000);
  const users = (Object.keys(USER_DEF) as UserActor[]).map((a) => ({
    id: ID[a],
    email: USER_DEF[a].email,
    passwordHash: '$2b$12$aclmatrixplaceholderhashvalueaclmatrixplaceholderhash',
    fullName: USER_DEF[a].fullName,
    role: USER_DEF[a].role,
    phone: USER_DEF[a].phone || null,
    organization: a.startsWith('cap') ? `${USER_DEF[a].fullName} Institute` : 'GCDIS',
    isTwoFactorEnabled: isStaff(a),
    isActive: true,
    emailVerifiedAt: USER_DEF[a].verified ? new Date(now - 86400000) : null
  }));
  const sessions = [
    ...(Object.keys(SID) as UserActor[]).map((a) => ({
      id: SID[a],
      userId: ID[a],
      familyId: SID[a],
      refreshTokenHash: `hash-${SID[a]}`,
      isActive: true,
      expiresAt: inOneHour,
      // Staff sessions carry a fresh step-up so StepUpGuard does not mask role decisions
      stepUpAt: isStaff(a) ? new Date(now - 1000) : null
    })),
    { id: ID.sessA2, userId: ID.capA, familyId: ID.sessA2, refreshTokenHash: 'hash-sessA2', isActive: true, expiresAt: inOneHour, ipAddress: '10.0.0.1', userAgent: 'Alpha laptop' },
    { id: ID.sessB2, userId: ID.capB, familyId: ID.sessB2, refreshTokenHash: 'hash-sessB2', isActive: true, expiresAt: inOneHour, ipAddress: '10.0.0.2', userAgent: 'Bravo laptop' }
  ];
  const asset = (idv: string, k: string, owner: string, purpose: string, isPublic = false, mime = 'application/pdf') => ({
    id: idv,
    fileName: `${purpose.toLowerCase()}.${mime === 'image/png' ? 'png' : 'pdf'}`,
    fileUrl: url(k),
    mimeType: mime,
    sizeBytes: 100,
    altText: purpose,
    uploadedBy: owner,
    purpose,
    isPublic,
    createdAt: new Date(now - 3600000)
  });
  return {
    User: users,
    Session: sessions,
    Event: [{ id: ID.event, slug: 'drone-soccer-2026', title: 'Drone Soccer 2026', startDate: new Date('2026-12-01'), endDate: new Date('2026-12-03'), venueName: 'Arena' }],
    Category: [{ id: ID.category, eventId: ID.event, slug: 'd20', name: 'Class 20', entryFee: 1000, maxTeamSize: 7, isActive: true }],
    Arena: [{ id: ID.arena, eventId: ID.event, name: 'Arena 1', code: 'A1' }],
    Team: [
      { id: ID.teamA, categoryId: ID.category, name: 'TEAM ALPHA', code: 'GCDIS-2026-T901', captainId: ID.capA, institutionName: 'Alpha Institute', city: 'Delhi', isApprovedPublic: true },
      { id: ID.teamB, categoryId: ID.category, name: 'TEAM BRAVO', code: 'GCDIS-2026-T902', captainId: ID.capB, institutionName: 'Bravo Institute', city: 'Pune', isApprovedPublic: false }
    ],
    TeamMember: [
      { id: ID.memAcap, teamId: ID.teamA, userId: ID.capA, fullName: 'Captain Alpha', email: USER_DEF.capA.email, mobile: USER_DEF.capA.phone, memberRole: 'CAPTAIN', createdAt: new Date(now - 5000) },
      { id: ID.memA2, teamId: ID.teamA, fullName: 'Alpha Member', email: 'alpha.member@acl.test', mobile: '+91 98888 00001', memberRole: 'PILOT', idProofUrl: url(KEY.Aid), createdAt: new Date(now - 4000) },
      { id: ID.memBcap, teamId: ID.teamB, userId: ID.capB, fullName: 'Captain Bravo', email: USER_DEF.capB.email, mobile: USER_DEF.capB.phone, memberRole: 'CAPTAIN', createdAt: new Date(now - 5000) },
      { id: ID.memB2, teamId: ID.teamB, fullName: 'Bravo Member', email: 'bravo.member@acl.test', mobile: '+91 98888 00002', memberRole: 'PILOT', idProofUrl: url(KEY.Bid), createdAt: new Date(now - 4000) }
    ],
    Registration: [
      { id: ID.regA, registrationCode: 'GCDIS-2026-D20-0001', teamId: ID.teamA, categoryId: ID.category, status: 'DOCUMENT_REVIEW' },
      { id: ID.regB, registrationCode: 'GCDIS-2026-D20-0002', teamId: ID.teamB, categoryId: ID.category, status: 'DOCUMENT_REVIEW' }
    ],
    Document: [
      { id: ID.docA, registrationId: ID.regA, type: 'INSTITUTION_NOC', fileName: 'noc-a.pdf', fileUrl: url(KEY.Adoc), status: 'PENDING' },
      { id: ID.docB, registrationId: ID.regB, type: 'INSTITUTION_NOC', fileName: 'noc-b.pdf', fileUrl: url(KEY.Bdoc), status: 'PENDING' }
    ],
    Payment: [
      { id: ID.payA, registrationId: ID.regA, orderId: 'order_A_0001', paymentId: 'pay_A_0001', amount: 1180, baseAmount: 1000, gstRate: 18, gstAmount: 180, status: 'SUCCESS', paidAt: new Date(now - 7200000), gatewaySignature: 'sig_A' },
      { id: ID.payB, registrationId: ID.regB, orderId: 'order_B_0001', paymentId: 'pay_B_0001', amount: 1180, baseAmount: 1000, gstRate: 18, gstAmount: 180, status: 'SUCCESS', paidAt: new Date(now - 7200000), gatewaySignature: 'sig_B' }
    ],
    TechnicalInspection: [
      { id: ID.inspA, registrationId: ID.regA, inspectorId: ID.INS, weightGrams: 900, diameterMm: 400, failsafeLatencySec: 1, status: 'PASSED', notes: 'Alpha inspection note' },
      { id: ID.inspB, registrationId: ID.regB, inspectorId: ID.INS, weightGrams: 900, diameterMm: 400, failsafeLatencySec: 1, status: 'PASSED', notes: 'Bravo inspection note' }
    ],
    Certificate: [
      { id: ID.certA, code: 'GCDIS-CERT-2026-AAAA0001', registrationId: ID.regA, recipientName: 'Captain Alpha', teamName: 'TEAM ALPHA', achievementTitle: 'Participant', qrVerificationUrl: 'http://localhost:3000/verify/GCDIS-CERT-2026-AAAA0001' },
      { id: ID.certB, code: 'GCDIS-CERT-2026-BBBB0002', registrationId: ID.regB, recipientName: 'Captain Bravo', teamName: 'TEAM BRAVO', achievementTitle: 'Participant', qrVerificationUrl: 'http://localhost:3000/verify/GCDIS-CERT-2026-BBBB0002' }
    ],
    MediaAsset: [
      asset(ID.assetAdoc, KEY.Adoc, ID.capA, 'DOCUMENT'),
      asset(ID.assetAid, KEY.Aid, ID.capA, 'ID_PROOF'),
      asset(ID.assetAfree, KEY.Afree, ID.capA, 'DOCUMENT'),
      asset(ID.assetBdoc, KEY.Bdoc, ID.capB, 'DOCUMENT'),
      asset(ID.assetBid, KEY.Bid, ID.capB, 'ID_PROOF'),
      asset(ID.assetBfree, KEY.Bfree, ID.capB, 'DOCUMENT'),
      asset(ID.assetPublic, KEY.public, ID.EA, 'CMS_MEDIA', true, 'image/png')
    ],
    Fixture: [{ id: ID.fixture, categoryId: ID.category, arenaId: ID.arena, matchNumber: 1, team1Id: ID.teamA, team2Id: ID.teamB, status: 'LIVE' }],
    Sponsor: [{ id: ID.sponsor, eventId: ID.event, name: 'Sponsor', tier: 'GOLD' }],
    GalleryImage: [{ id: ID.gallery, imageUrl: url(KEY.public), title: 'Image', altText: 'Image' }],
    Prize: [{ id: ID.prize, category: 'D20', rank: 1, title: 'Winner', amount: 1000 }],
    AuditLog: [
      { actorId: ID.capA, actorEmail: USER_DEF.capA.email, actorRole: 'TEAM_CAPTAIN', action: 'CREATE_REGISTRATION', entityType: 'Registration', entityId: ID.regA, ipAddress: '10.0.0.1' },
      { actorId: ID.capB, actorEmail: USER_DEF.capB.email, actorRole: 'TEAM_CAPTAIN', action: 'CREATE_REGISTRATION', entityType: 'Registration', entityId: ID.regB, ipAddress: '10.0.0.2' }
    ]
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Tokens

function signAccess(actor: UserActor, overrides: Record<string, any> = {}, opts: { secret?: string; expiresIn?: number | string; algorithm?: jwt.Algorithm } = {}): string {
  const staff = isStaff(actor);
  const aud = overrides.aud ?? (staff ? 'gcdis-admin' : 'gcdis-public');
  const payload = {
    sub: ID[actor],
    email: USER_DEF[actor].email,
    role: USER_DEF[actor].role,
    fullName: USER_DEF[actor].fullName,
    aud,
    sid: SID[actor],
    mustChangePassword: false,
    ...overrides
  };
  const secret = opts.secret ?? (aud === 'gcdis-admin' ? getAdminJwtSecret() : getPublicJwtSecret());
  return jwt.sign(payload, secret, { algorithm: opts.algorithm ?? 'HS256', expiresIn: (opts.expiresIn ?? '10m') as any });
}

// ---------------------------------------------------------------------------------------------------------------
// Harness

const db = new InMemoryPrisma();
let app: INestApplication;
let base = '';
const realFetch: typeof fetch = global.fetch;
const outbound: string[] = [];

interface Res {
  status: number;
  text: string;
  json: any;
  headers: Headers;
}

interface CallOpts {
  body?: unknown;
  form?: FormData;
  token?: string | null;
  headers?: Record<string, string>;
  keepState?: boolean;
  mutate?: (s: Record<string, any[]>) => void;
}

const UPLOAD_DIR = process.env.STORAGE_LOCAL_DIR || path.join(os.tmpdir(), 'gcdis-test-uploads');

/** (Re)writes the stored files; staff deletions in earlier rows may have removed them. */
function writeFiles() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  for (const [label, k] of Object.entries(KEY)) {
    fs.writeFileSync(path.join(UPLOAD_DIR, k), label === 'public' ? PNG : Buffer.from(`%PDF-1.4
${label.startsWith('A') ? 'A-PRIVATE-FILE-CONTENT' : `${label}-content`}
%%EOF`));
  }
}

function resetState(mutate?: (s: Record<string, any[]>) => void) {
  writeFiles();
  const s = seed();
  mutate?.(s);
  db.reset(s);
  AccountIpRateLimiterGuard.resetMemoryStore();
}

async function call(actor: Actor, method: string, path_: string, opts: CallOpts = {}): Promise<Res> {
  if (!opts.keepState) resetState(opts.mutate);
  const headers: Record<string, string> = {
    origin: isStaff(actor) ? 'http://localhost:3001' : 'http://localhost:3000',
    ...(opts.headers || {})
  };
  const token = opts.token !== undefined ? opts.token : actor === 'anon' ? null : signAccess(actor);
  if (token) headers.authorization = `Bearer ${token}`;
  let body: any;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await realFetch(`${base}/api${path_}`, { method, headers, body, redirect: 'manual' });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('latin1');
  let json: any = null;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    json = null;
  }
  return { status: res.status, text, json, headers: res.headers };
}

// ---------------------------------------------------------------------------------------------------------------
// Expectations

/**
 * ok    2xx
 * pass  the access-control layer let the caller through: anything but 401 / 403 (and no 5xx)
 * deny  403 or 404 (object-level denial; 404 hides existence)
 * any   public route: any answer below 500 except a CSRF / role 403
 * reject4xx  400 or 401 (e.g. webhook without a valid signature)
 * a number: that exact status
 */
type Exp = 'ok' | 'pass' | 'deny' | 'any' | 'reject4xx' | number;

function meets(status: number, exp: Exp): boolean {
  switch (exp) {
    case 'ok':
      return status >= 200 && status < 300;
    case 'pass':
      return status !== 401 && status !== 403 && status < 500;
    case 'deny':
      return status === 403 || status === 404;
    case 'any':
      return status < 500 && status !== 403;
    case 'reject4xx':
      return status === 400 || status === 401;
    default:
      return status === exp;
  }
}

type Matrix = Record<Actor, Exp>;

const PUBLIC_OK: Matrix = { anon: 'ok', capA: 'ok', capB: 'ok', capU: 'ok', SA: 'ok', EA: 'ok', INS: 'ok', JUDGE: 'ok' };
const PUBLIC_ANY: Matrix = { anon: 'any', capA: 'any', capB: 'any', capU: 'any', SA: 'any', EA: 'any', INS: 'any', JUDGE: 'any' };

/** Staff-only route: only `allowed` staff roles get through; everyone else 401 / 403. */
function staffOnly(allowed: UserActor[], allowExp: Exp = 'pass'): Matrix {
  const m: Matrix = { anon: 401, capA: 403, capB: 403, capU: 403, SA: 403, EA: 403, INS: 403, JUDGE: 403 };
  for (const a of allowed) m[a] = allowExp;
  return m;
}

/** Captain-only (portal) route acting on A's objects; staff sessions are rejected (audience separation). */
function captainOwned(ownerExp: Exp = 'ok', unverified: Exp = 'deny'): Matrix {
  return { anon: 401, capA: ownerExp, capB: 'deny', capU: unverified, SA: 403, EA: 403, INS: 403, JUDGE: 403 };
}

/** Captain-or-staff route on A's object: owner and listed staff succeed, other captains and staff are denied. */
function ownerOrStaff(staff: UserActor[], ownerExp: Exp = 'ok', staffExp: Exp = 'ok'): Matrix {
  const m: Matrix = { anon: 401, capA: ownerExp, capB: 'deny', capU: 'deny', SA: 403, EA: 403, INS: 403, JUDGE: 403 };
  for (const a of staff) m[a] = staffExp;
  return m;
}

/** Self-service route any signed-in user may call for their own account. */
function anySignedIn(exp: Exp = 'ok'): Matrix {
  return { anon: 401, capA: exp, capB: exp, capU: exp, SA: exp, EA: exp, INS: exp, JUDGE: exp };
}

interface Case {
  /** Route key as declared: METHOD /controller/path */
  route: string;
  label?: string;
  method: string;
  path: string;
  body?: unknown | ((actor: Actor) => unknown);
  form?: (actor: Actor) => FormData;
  expect: Matrix;
  /** Identifier-bearing route (path / query / body object id) */
  idor?: boolean;
  /** Extra per-response assertion; return an error message or null. */
  check?: (actor: Actor, res: Res) => string | null;
  /** Skip the private-data leak scan for this case (e.g. the owner's own page is fine). */
  noLeakScan?: boolean;
}

const pdfForm = (label: string, purpose = 'DOCUMENT') => () => {
  const fd = new FormData();
  fd.append('file', new Blob([PDF(label)], { type: 'application/pdf' }), `${label}.pdf`);
  fd.append('purpose', purpose);
  return fd;
};

const has = (res: Res, needle: string) => res.text.includes(needle);

const CASES: Case[] = [
  // ----- app -----
  { route: 'GET /', method: 'GET', path: '/', expect: PUBLIC_OK },
  { route: 'GET /health', method: 'GET', path: '/health', expect: PUBLIC_ANY },
  { route: 'GET /health/details', method: 'GET', path: '/health/details', expect: staffOnly(['SA'], 'ok') },

  // ----- auth: public flows (CSRF-protected, no object identifiers) -----
  { route: 'GET /auth/google/config', method: 'GET', path: '/auth/google/config', expect: PUBLIC_OK },
  { route: 'POST /auth/google', method: 'POST', path: '/auth/google', body: {}, expect: PUBLIC_ANY },
  { route: 'POST /auth/register', method: 'POST', path: '/auth/register', body: {}, expect: PUBLIC_ANY },
  { route: 'POST /auth/login', method: 'POST', path: '/auth/login', body: {}, expect: PUBLIC_ANY },
  { route: 'POST /auth/2fa/verify-login', method: 'POST', path: '/auth/2fa/verify-login', body: {}, expect: PUBLIC_ANY },
  { route: 'POST /auth/2fa/generate', method: 'POST', path: '/auth/2fa/generate', body: {}, expect: PUBLIC_ANY },
  { route: 'POST /auth/2fa/enable', method: 'POST', path: '/auth/2fa/enable', body: {}, expect: PUBLIC_ANY },
  { route: 'POST /auth/verify-email', method: 'POST', path: '/auth/verify-email', body: {}, expect: PUBLIC_ANY },
  { route: 'GET /auth/email-delivery', method: 'GET', path: '/auth/email-delivery', expect: PUBLIC_OK },
  { route: 'POST /auth/forgot-password', method: 'POST', path: '/auth/forgot-password', body: {}, expect: PUBLIC_ANY },
  { route: 'POST /auth/reset-password', method: 'POST', path: '/auth/reset-password', body: {}, expect: PUBLIC_ANY },
  { route: 'POST /auth/refresh', method: 'POST', path: '/auth/refresh', body: {}, expect: PUBLIC_ANY },
  { route: 'POST /auth/logout', method: 'POST', path: '/auth/logout', body: {}, expect: PUBLIC_ANY },
  {
    route: 'GET /auth/me',
    method: 'GET',
    path: '/auth/me',
    expect: PUBLIC_OK,
    check: (a, r) => {
      if (a === 'anon') return r.json?.user === null ? null : 'anonymous /auth/me must answer { user: null }';
      if (r.json?.user?.id !== ID[a as UserActor]) return '/auth/me answered another account';
      return has(r, 'passwordHash') ? '/auth/me leaks passwordHash' : null;
    }
  },

  // ----- auth: captain self-service -----
  { route: 'POST /auth/verify-email-code', method: 'POST', path: '/auth/verify-email-code', body: { code: '000000' }, expect: { ...staffOnly([]), capA: 'pass', capB: 'pass', capU: 'pass' } },
  { route: 'GET /auth/verification-status', method: 'GET', path: '/auth/verification-status', expect: { ...staffOnly([]), capA: 'ok', capB: 'ok', capU: 'ok' } },
  { route: 'POST /auth/resend-verification', method: 'POST', path: '/auth/resend-verification', body: {}, expect: { ...staffOnly([]), capA: 'pass', capB: 'pass', capU: 'pass' } },

  // ----- auth: any signed-in user, own account -----
  { route: 'POST /auth/change-password', method: 'POST', path: '/auth/change-password', body: {}, expect: anySignedIn('pass') },
  { route: 'POST /auth/logout-all', method: 'POST', path: '/auth/logout-all', body: {}, expect: anySignedIn('ok') },
  { route: 'POST /auth/step-up', method: 'POST', path: '/auth/step-up', body: {}, expect: anySignedIn('pass') },
  {
    route: 'GET /auth/sessions',
    method: 'GET',
    path: '/auth/sessions',
    expect: anySignedIn('ok'),
    check: (a, r) => {
      if (r.status !== 200) return null;
      if (!Array.isArray(r.json)) return `unexpected body ${r.text.slice(0, 200)}`;
      const ids: string[] = r.json.map((s: any) => s.id);
      if (a !== 'capA' && (ids.includes(ID.sessA2) || ids.includes(SID.capA))) return `${a} sees captain A's sessions`;
      if (a === 'capA' && !ids.includes(ID.sessA2)) return 'captain A does not see own sessions';
      return null;
    }
  },
  {
    route: 'DELETE /auth/sessions/:id',
    label: "revoke captain A's second session",
    idor: true,
    method: 'DELETE',
    path: `/auth/sessions/${ID.sessA2}`,
    expect: { anon: 401, capA: 'ok', capB: 404, capU: 404, SA: 404, EA: 404, INS: 404, JUDGE: 404 },
    check: (a) => {
      const s = db.rows('Session').find((r) => r.id === ID.sessA2)!;
      if (a !== 'capA' && (s.revokedAt || !s.isActive)) return `${a} revoked captain A's session`;
      return null;
    }
  },

  // ----- auth: staff administration -----
  { route: 'POST /auth/staff-user', method: 'POST', path: '/auth/staff-user', body: { email: 'new.judge@acl.test', fullName: 'New Judge', role: 'JUDGE' }, expect: staffOnly(['SA']) },
  { route: 'GET /auth/users', method: 'GET', path: '/auth/users', expect: staffOnly(['SA'], 'ok') },
  {
    route: 'PATCH /auth/users/:id/role',
    idor: true,
    method: 'PATCH',
    path: `/auth/users/${ID.capA}/role`,
    body: { role: 'SUPER_ADMIN' },
    expect: staffOnly(['SA']),
    check: (a) => (a !== 'SA' && db.rows('User').find((u) => u.id === ID.capA)!.role !== 'TEAM_CAPTAIN' ? `${a} changed a role` : null)
  },
  {
    route: 'PATCH /auth/users/:id/status',
    idor: true,
    method: 'PATCH',
    path: `/auth/users/${ID.capA}/status`,
    body: { isActive: false, reason: 'test' },
    expect: staffOnly(['SA']),
    check: (a) => (a !== 'SA' && !db.rows('User').find((u) => u.id === ID.capA)!.isActive ? `${a} deactivated captain A` : null)
  },
  { route: 'GET /auth/captains/awaiting-verification', method: 'GET', path: '/auth/captains/awaiting-verification', expect: staffOnly(['SA', 'EA'], 'ok') },
  { route: 'POST /auth/users/:id/resend-verification', idor: true, method: 'POST', path: `/auth/users/${ID.capU}/resend-verification`, body: {}, expect: staffOnly(['SA', 'EA']) },
  {
    route: 'POST /auth/users/:id/mark-email-verified',
    idor: true,
    method: 'POST',
    path: `/auth/users/${ID.capU}/mark-email-verified`,
    body: {},
    expect: staffOnly(['SA', 'EA']),
    check: (a) => (!['SA', 'EA'].includes(a) && db.rows('User').find((u) => u.id === ID.capU)!.emailVerifiedAt ? `${a} verified an email address` : null)
  },
  { route: 'POST /auth/users/:id/reveal-verification-code', idor: true, method: 'POST', path: `/auth/users/${ID.capU}/reveal-verification-code`, body: {}, expect: staffOnly(['SA', 'EA']) },

  // ----- audit -----
  { route: 'GET /audit', method: 'GET', path: '/audit', expect: staffOnly(['SA', 'EA'], 'ok') },
  { route: 'GET /audit/export', method: 'GET', path: `/audit/export?actorId=${ID.capA}`, idor: true, expect: staffOnly(['SA', 'EA'], 'ok') },
  { route: 'GET /audit/security-alerts', method: 'GET', path: '/audit/security-alerts', expect: staffOnly(['SA', 'EA'], 'ok') },
  // Audit hash-chain verification: Super Administrator only
  { route: 'GET /audit/verify-chain', method: 'GET', path: '/audit/verify-chain', expect: staffOnly(['SA'], 'ok') },
  { route: 'GET /audit/my-activity', method: 'GET', path: '/audit/my-activity', expect: anySignedIn('ok') },

  // ----- certificates -----
  { route: 'GET /certificates/pass/:memberId/pdf', label: "captain A's member", idor: true, method: 'GET', path: `/certificates/pass/${ID.memA2}/pdf`, expect: ownerOrStaff(['SA', 'EA', 'INS']) },
  { route: 'GET /certificates/pass/:memberId/pdf', label: 'captain A (captain row)', idor: true, method: 'GET', path: `/certificates/pass/${ID.memAcap}/pdf`, expect: ownerOrStaff(['SA', 'EA', 'INS']) },
  {
    route: 'GET /certificates/verify/:code',
    idor: true,
    method: 'GET',
    path: '/certificates/verify/GCDIS-CERT-2026-AAAA0001',
    expect: PUBLIC_OK,
    check: (_a, r) => (r.json?.isValid === true && !has(r, ID.regA) ? null : 'certificate verification leaks the registration id or failed')
  },
  { route: 'GET /certificates', method: 'GET', path: '/certificates', expect: staffOnly(['SA', 'EA'], 'ok') },
  {
    route: 'POST /certificates/generate',
    idor: true,
    method: 'POST',
    path: '/certificates/generate',
    body: { registrationId: ID.regA, recipientName: 'Captain Alpha', teamName: 'TEAM ALPHA', achievementTitle: 'Winner' },
    expect: staffOnly(['SA', 'EA'], 'ok')
  },

  // ----- CMS (content sections, prizes, media) -----
  { route: 'GET /cms/section/:key', method: 'GET', path: '/cms/section/hero', expect: PUBLIC_ANY },
  { route: 'GET /cms/prizes', method: 'GET', path: '/cms/prizes', expect: PUBLIC_OK },
  { route: 'GET /cms/admin/sections', method: 'GET', path: '/cms/admin/sections', expect: staffOnly(['SA', 'EA']) },
  { route: 'POST /cms/admin/section/:key/draft', method: 'POST', path: '/cms/admin/section/hero/draft', body: {}, expect: staffOnly(['SA', 'EA']) },
  { route: 'POST /cms/admin/section/:key/publish', method: 'POST', path: '/cms/admin/section/hero/publish', body: {}, expect: staffOnly(['SA', 'EA']) },
  { route: 'POST /cms/admin/section/:key/rollback/:version', method: 'POST', path: '/cms/admin/section/hero/rollback/1', body: {}, expect: staffOnly(['SA', 'EA']) },
  { route: 'GET /cms/admin/section/:key/versions', method: 'GET', path: '/cms/admin/section/hero/versions', expect: staffOnly(['SA', 'EA']) },
  { route: 'PATCH /cms/admin/prize/:id', idor: true, method: 'PATCH', path: `/cms/admin/prize/${ID.prize}`, body: { amount: 1 }, expect: staffOnly(['SA', 'EA']) },
  { route: 'GET /cms/admin/checklist', method: 'GET', path: '/cms/admin/checklist', expect: staffOnly(['SA', 'EA']) },
  { route: 'POST /cms/admin/media', method: 'POST', path: '/cms/admin/media', body: {}, expect: staffOnly(['SA', 'EA']) },
  { route: 'GET /cms/admin/media', method: 'GET', path: '/cms/admin/media', expect: staffOnly(['SA', 'EA']) },
  // home sections
  { route: 'GET /cms/public/home', method: 'GET', path: '/cms/public/home', expect: PUBLIC_OK },
  { route: 'GET /cms/admin/home/sections', method: 'GET', path: '/cms/admin/home/sections', expect: staffOnly(['SA', 'EA']) },
  { route: 'PUT /cms/admin/home/sections/order', method: 'PUT', path: '/cms/admin/home/sections/order', body: { keys: ['news'] }, expect: staffOnly(['SA', 'EA']) },
  { route: 'GET /cms/admin/home/sections/:key', method: 'GET', path: '/cms/admin/home/sections/news', expect: staffOnly(['SA', 'EA']) },
  { route: 'PATCH /cms/admin/home/sections/:key', method: 'PATCH', path: '/cms/admin/home/sections/news', body: { enabled: false }, expect: staffOnly(['SA', 'EA']) },
  { route: 'POST /cms/admin/home/sections/:key/reset', method: 'POST', path: '/cms/admin/home/sections/news/reset', body: {}, expect: staffOnly(['SA', 'EA']) },
  // championship page media
  { route: 'GET /cms/public/championship-media', method: 'GET', path: '/cms/public/championship-media', expect: PUBLIC_OK },
  { route: 'GET /cms/admin/championship-media', method: 'GET', path: '/cms/admin/championship-media', expect: staffOnly(['SA', 'EA']) },
  { route: 'PUT /cms/admin/championship-media/hero', method: 'PUT', path: '/cms/admin/championship-media/hero', body: {}, expect: staffOnly(['SA', 'EA']) },
  { route: 'DELETE /cms/admin/championship-media/hero/video', method: 'DELETE', path: '/cms/admin/championship-media/hero/video', expect: staffOnly(['SA', 'EA']) },
  { route: 'DELETE /cms/admin/championship-media/hero/poster', method: 'DELETE', path: '/cms/admin/championship-media/hero/poster', expect: staffOnly(['SA', 'EA']) },
  { route: 'POST /cms/admin/championship-media/gallery', method: 'POST', path: '/cms/admin/championship-media/gallery', body: {}, expect: staffOnly(['SA', 'EA']) },
  { route: 'PUT /cms/admin/championship-media/gallery/order', method: 'PUT', path: '/cms/admin/championship-media/gallery/order', body: { ids: [ID.gallery] }, expect: staffOnly(['SA', 'EA']) },
  { route: 'PATCH /cms/admin/championship-media/gallery/:id', idor: true, method: 'PATCH', path: `/cms/admin/championship-media/gallery/${ID.gallery}`, body: { published: false }, expect: staffOnly(['SA', 'EA']) },
  { route: 'PUT /cms/admin/championship-media/sections/:key', method: 'PUT', path: '/cms/admin/championship-media/sections/facts', body: {}, expect: staffOnly(['SA', 'EA']) },
  { route: 'PUT /cms/admin/championship-media/sections/:key/items/:item', method: 'PUT', path: '/cms/admin/championship-media/sections/categories/items/d20', body: {}, expect: staffOnly(['SA', 'EA']) },
  { route: 'DELETE /cms/admin/championship-media/sections/:key/:field', method: 'DELETE', path: '/cms/admin/championship-media/sections/facts/image', expect: staffOnly(['SA', 'EA']) },
  { route: 'DELETE /cms/admin/championship-media/sections/:key/items/:item/:field', method: 'DELETE', path: '/cms/admin/championship-media/sections/prizes/items/d40/video', expect: staffOnly(['SA', 'EA']) },
  { route: 'DELETE /cms/admin/championship-media/gallery/:id', idor: true, method: 'DELETE', path: `/cms/admin/championship-media/gallery/${ID.gallery}`, expect: staffOnly(['SA', 'EA']) },
  // site content
  { route: 'GET /cms/public/site', method: 'GET', path: '/cms/public/site', expect: PUBLIC_OK },
  { route: 'GET /cms/sponsors', method: 'GET', path: '/cms/sponsors', expect: PUBLIC_OK },
  { route: 'GET /cms/gallery', method: 'GET', path: '/cms/gallery', expect: PUBLIC_OK },
  { route: 'GET /cms/admin/settings/site-info', method: 'GET', path: '/cms/admin/settings/site-info', expect: staffOnly(['SA', 'EA']) },
  { route: 'PUT /cms/admin/settings/site-info', method: 'PUT', path: '/cms/admin/settings/site-info', body: {}, expect: staffOnly(['SA', 'EA']) },
  { route: 'GET /cms/admin/settings/sponsors-section', method: 'GET', path: '/cms/admin/settings/sponsors-section', expect: staffOnly(['SA', 'EA']) },
  { route: 'PUT /cms/admin/settings/sponsors-section', method: 'PUT', path: '/cms/admin/settings/sponsors-section', body: {}, expect: staffOnly(['SA', 'EA']) },
  { route: 'GET /cms/admin/settings/gallery-section', method: 'GET', path: '/cms/admin/settings/gallery-section', expect: staffOnly(['SA', 'EA']) },
  { route: 'PUT /cms/admin/settings/gallery-section', method: 'PUT', path: '/cms/admin/settings/gallery-section', body: {}, expect: staffOnly(['SA', 'EA']) },
  { route: 'GET /cms/admin/sponsors', method: 'GET', path: '/cms/admin/sponsors', expect: staffOnly(['SA', 'EA']) },
  { route: 'POST /cms/admin/sponsors', method: 'POST', path: '/cms/admin/sponsors', body: {}, expect: staffOnly(['SA', 'EA']) },
  { route: 'PUT /cms/admin/sponsors/order', method: 'PUT', path: '/cms/admin/sponsors/order', body: { ids: [ID.sponsor] }, expect: staffOnly(['SA', 'EA']) },
  { route: 'PATCH /cms/admin/sponsors/:id', idor: true, method: 'PATCH', path: `/cms/admin/sponsors/${ID.sponsor}`, body: {}, expect: staffOnly(['SA', 'EA']) },
  { route: 'DELETE /cms/admin/sponsors/:id', idor: true, method: 'DELETE', path: `/cms/admin/sponsors/${ID.sponsor}`, expect: staffOnly(['SA', 'EA']) },
  { route: 'GET /cms/admin/gallery', method: 'GET', path: '/cms/admin/gallery', expect: staffOnly(['SA', 'EA']) },
  { route: 'POST /cms/admin/gallery', method: 'POST', path: '/cms/admin/gallery', body: {}, expect: staffOnly(['SA', 'EA']) },
  { route: 'PUT /cms/admin/gallery/order', method: 'PUT', path: '/cms/admin/gallery/order', body: { ids: [ID.gallery] }, expect: staffOnly(['SA', 'EA']) },
  { route: 'PATCH /cms/admin/gallery/:id', idor: true, method: 'PATCH', path: `/cms/admin/gallery/${ID.gallery}`, body: {}, expect: staffOnly(['SA', 'EA']) },
  { route: 'DELETE /cms/admin/gallery/:id', idor: true, method: 'DELETE', path: `/cms/admin/gallery/${ID.gallery}`, expect: staffOnly(['SA', 'EA']) },

  // ----- competition -----
  { route: 'GET /competition/arenas', method: 'GET', path: '/competition/arenas', expect: PUBLIC_OK },
  { route: 'GET /competition/fixtures', method: 'GET', path: '/competition/fixtures', expect: PUBLIC_OK },
  { route: 'GET /competition/fixtures/category/:categoryId', idor: true, method: 'GET', path: `/competition/fixtures/category/${ID.category}`, expect: PUBLIC_OK },
  { route: 'GET /competition/fixtures/:id', idor: true, method: 'GET', path: `/competition/fixtures/${ID.fixture}`, expect: PUBLIC_OK },
  { route: 'GET /competition/fixtures/:id/live-polling', idor: true, method: 'GET', path: `/competition/fixtures/${ID.fixture}/live-polling`, expect: PUBLIC_OK },
  { route: 'GET /competition/rankings/category/:categoryId', idor: true, method: 'GET', path: `/competition/rankings/category/${ID.category}`, expect: PUBLIC_OK },
  { route: 'PATCH /competition/fixtures/:id/status', idor: true, method: 'PATCH', path: `/competition/fixtures/${ID.fixture}/status`, body: { targetStatus: 'PAUSED' }, expect: staffOnly(['SA', 'EA', 'JUDGE'], 'ok') },
  {
    route: 'POST /competition/fixtures/:id/event',
    idor: true,
    method: 'POST',
    path: `/competition/fixtures/${ID.fixture}/event`,
    body: { teamId: ID.teamA, eventType: 'GOAL', scoreDelta: 1 },
    expect: staffOnly(['SA', 'EA', 'JUDGE'], 'ok'),
    check: (a) => (!['SA', 'EA', 'JUDGE'].includes(a) && db.rows('Fixture')[0].team1Score !== 0 ? `${a} changed the score` : null)
  },
  {
    route: 'POST /competition/fixtures/log-event',
    idor: true,
    method: 'POST',
    path: '/competition/fixtures/log-event',
    body: { fixtureId: ID.fixture, teamId: ID.teamA, eventType: 'GOAL', scoreDelta: 1 },
    expect: staffOnly(['SA', 'EA', 'JUDGE'], 'ok')
  },

  // ----- events -----
  { route: 'GET /events', method: 'GET', path: '/events', expect: PUBLIC_OK },
  { route: 'GET /events/:slug', method: 'GET', path: '/events/drone-soccer-2026', expect: PUBLIC_OK },
  { route: 'GET /events/:eventSlug/categories/:categorySlug', method: 'GET', path: '/events/drone-soccer-2026/categories/d20', expect: PUBLIC_OK },
  { route: 'POST /events', method: 'POST', path: '/events', body: {}, expect: staffOnly(['SA', 'EA']) },

  // ----- inspections -----
  { route: 'GET /inspections/registration/:registrationId', idor: true, method: 'GET', path: `/inspections/registration/${ID.regA}`, expect: ownerOrStaff(['SA', 'EA', 'INS']) },
  { route: 'GET /inspections', method: 'GET', path: '/inspections', expect: staffOnly(['SA', 'EA', 'INS'], 'ok') },
  {
    route: 'POST /inspections',
    idor: true,
    method: 'POST',
    path: '/inspections',
    body: { registrationId: ID.regA, checks: { weightGrams: { passed: true, value: 900 } } },
    expect: staffOnly(['SA', 'EA', 'INS'])
  },

  // ----- mail -----
  { route: 'GET /mail/status', method: 'GET', path: '/mail/status', expect: staffOnly(['SA'], 'ok') },
  { route: 'POST /mail/test', method: 'POST', path: '/mail/test', body: {}, expect: staffOnly(['SA'], 'ok') },

  // ----- payments -----
  { route: 'GET /payments/invoice/:invoiceId/pdf', label: 'by payment id', idor: true, method: 'GET', path: `/payments/invoice/${ID.payA}/pdf`, expect: ownerOrStaff(['SA', 'EA']) },
  { route: 'GET /payments/invoice/:invoiceId/pdf', label: 'by gateway order id', idor: true, method: 'GET', path: '/payments/invoice/order_A_0001/pdf', expect: ownerOrStaff(['SA', 'EA']) },
  { route: 'POST /payments/create-order', idor: true, method: 'POST', path: '/payments/create-order', body: { registrationId: ID.regA }, expect: captainOwned('pass') },
  {
    route: 'POST /payments/verify-signature',
    idor: true,
    method: 'POST',
    path: '/payments/verify-signature',
    body: { razorpayOrderId: 'order_A_0001', razorpayPaymentId: 'pay_forged', razorpaySignature: 'forged' },
    expect: captainOwned('pass')
  },
  { route: 'POST /payments/webhook', method: 'POST', path: '/payments/webhook', body: { event: 'payment.captured' }, expect: { anon: 'reject4xx', capA: 'reject4xx', capB: 'reject4xx', capU: 'reject4xx', SA: 'reject4xx', EA: 'reject4xx', INS: 'reject4xx', JUDGE: 'reject4xx' } },
  { route: 'POST /payments/reconcile', method: 'POST', path: '/payments/reconcile', body: {}, expect: staffOnly(['SA', 'EA']) },
  {
    route: 'POST /payments/:id/refund',
    idor: true,
    method: 'POST',
    path: `/payments/${ID.payA}/refund`,
    body: { reason: 'test' },
    expect: staffOnly(['SA']),
    check: (a) => (a !== 'SA' && db.rows('Payment').find((p) => p.id === ID.payA)!.status !== 'SUCCESS' ? `${a} refunded a payment` : null)
  },
  { route: 'GET /payments/registration/:registrationId', idor: true, method: 'GET', path: `/payments/registration/${ID.regA}`, expect: ownerOrStaff(['SA', 'EA']) },
  { route: 'GET /payments', method: 'GET', path: '/payments', expect: staffOnly(['SA', 'EA'], 'ok') },

  // ----- registrations -----
  {
    route: 'GET /registrations',
    method: 'GET',
    path: '/registrations',
    expect: { anon: 401, capA: 'ok', capB: 'ok', capU: 'ok', SA: 'ok', EA: 'ok', INS: 'ok', JUDGE: 403 },
    check: (a, r) => {
      const ids: string[] = (r.json?.registrations || []).map((x: any) => x.id);
      if (a === 'capA' && (ids.length !== 1 || ids[0] !== ID.regA)) return `captain A list = ${JSON.stringify(ids)}`;
      if (a === 'capB' && (ids.length !== 1 || ids[0] !== ID.regB)) return `captain B list = ${JSON.stringify(ids)}`;
      if (a === 'capU' && ids.length !== 0) return 'unverified captain sees registrations';
      if (['SA', 'EA', 'INS'].includes(a) && ids.length !== 2) return `${a} sees ${ids.length} registrations`;
      return null;
    }
  },
  {
    route: 'GET /registrations',
    label: '?categoryId filter does not widen a captain list',
    idor: true,
    method: 'GET',
    path: `/registrations?categoryId=${ID.category}&limit=100`,
    expect: { anon: 401, capA: 'ok', capB: 'ok', capU: 'ok', SA: 'ok', EA: 'ok', INS: 'ok', JUDGE: 403 }
  },
  {
    route: 'GET /registrations/:id',
    idor: true,
    method: 'GET',
    path: `/registrations/${ID.regA}`,
    expect: ownerOrStaff(['SA', 'EA', 'INS']),
    check: (a, r) => {
      if (['SA', 'EA', 'INS'].includes(a) && r.json?.documents?.[0]?.assetId !== ID.assetAdoc) return 'staff detail lacks document assetId';
      if (a === 'capA' && r.json?.documents?.[0]?.assetId !== undefined) return 'captain detail unexpectedly carries staff-only assetId';
      return null;
    }
  },
  {
    route: 'POST /registrations',
    idor: true,
    method: 'POST',
    path: '/registrations',
    body: { teamId: ID.teamA, categoryId: ID.category },
    expect: { anon: 401, capA: 'pass', capB: 403, capU: 403, SA: 403, EA: 403, INS: 403, JUDGE: 403 }
  },
  {
    route: 'PATCH /registrations/:id/status',
    idor: true,
    method: 'PATCH',
    path: `/registrations/${ID.regA}/status`,
    body: { targetStatus: 'WITHDRAWN', reason: 'acl test' },
    expect: { anon: 401, capA: 'ok', capB: 403, capU: 403, SA: 'ok', EA: 'ok', INS: 403, JUDGE: 403 },
    check: (a) => (!['capA', 'SA', 'EA'].includes(a) && db.rows('Registration').find((r) => r.id === ID.regA)!.status !== 'DOCUMENT_REVIEW' ? `${a} changed the registration status` : null)
  },
  {
    route: 'POST /registrations/:id/documents',
    idor: true,
    method: 'POST',
    path: `/registrations/${ID.regA}/documents`,
    // Every captain submits a file they uploaded themselves
    body: (a: Actor) => ({ type: 'INSURANCE', assetId: a === 'capB' ? ID.assetBfree : ID.assetAfree }),
    expect: captainOwned('ok'),
    check: (a) => (a !== 'capA' && db.rows('Document').filter((d) => d.registrationId === ID.regA).length !== 1 ? `${a} attached a document to registration A` : null)
  },
  {
    route: 'PATCH /registrations/:id/documents/:docId',
    idor: true,
    method: 'PATCH',
    path: `/registrations/${ID.regA}/documents/${ID.docA}`,
    body: { status: 'VERIFIED' },
    expect: staffOnly(['SA', 'EA'], 'ok'),
    check: (a) => (!['SA', 'EA'].includes(a) && db.rows('Document').find((d) => d.id === ID.docA)!.status !== 'PENDING' ? `${a} reviewed a document` : null)
  },

  // ----- teams -----
  { route: 'GET /teams/public', method: 'GET', path: '/teams/public', expect: PUBLIC_OK },
  {
    route: 'GET /teams/my-team',
    method: 'GET',
    path: '/teams/my-team',
    expect: { ...staffOnly([]), capA: 'ok', capB: 'ok', capU: 'ok' },
    noLeakScan: false,
    check: (a, r) => {
      if (a === 'capA' && r.json?.id !== ID.teamA) return 'captain A did not get team A';
      if (a === 'capB' && r.json?.id !== ID.teamB) return 'captain B did not get team B';
      if (a === 'capU' && r.json) return 'unverified captain got a team';
      return null;
    }
  },
  { route: 'GET /teams/category/:categoryId', idor: true, method: 'GET', path: `/teams/category/${ID.category}`, expect: PUBLIC_OK },
  {
    route: 'GET /teams/:id',
    label: 'approved team A',
    idor: true,
    method: 'GET',
    path: `/teams/${ID.teamA}`,
    expect: PUBLIC_OK,
    check: (a, r) => {
      const full = a === 'capA' || a === 'SA' || a === 'EA';
      if (full && r.json?.captain?.email !== USER_DEF.capA.email) return `${a} should get the full record`;
      if (!full && (r.json?.captainId || r.json?.captain?.id)) return `${a} sees captain user id on the public team`;
      return null;
    }
  },
  {
    route: 'GET /teams/:id',
    label: 'unapproved team A',
    idor: true,
    method: 'GET',
    path: `/teams/${ID.teamA}`,
    expect: { anon: 404, capA: 'ok', capB: 404, capU: 404, SA: 'ok', EA: 'ok', INS: 404, JUDGE: 404 }
  },
  { route: 'GET /teams', method: 'GET', path: '/teams', expect: staffOnly(['SA', 'EA'], 'ok') },
  {
    route: 'POST /teams',
    method: 'POST',
    path: '/teams',
    body: { categoryId: ID.category, teamName: 'New Team', institutionName: 'Inst', city: 'Delhi' },
    expect: { ...staffOnly([]), capA: 'pass', capB: 'pass', capU: 'ok' }
  },
  {
    route: 'POST /teams/:id/members',
    idor: true,
    method: 'POST',
    path: `/teams/${ID.teamA}/members`,
    body: { fullName: 'Injected Member', email: 'injected@acl.test', memberRole: 'PILOT' },
    expect: captainOwned('ok'),
    check: (a) => (a !== 'capA' && db.rows('TeamMember').some((m) => m.email === 'injected@acl.test') ? `${a} added a member to team A` : null)
  },
  {
    route: 'PATCH /teams/:id/members/:memberId',
    idor: true,
    method: 'PATCH',
    path: `/teams/${ID.teamA}/members/${ID.memA2}`,
    body: { fullName: 'Renamed Member' },
    expect: captainOwned('ok'),
    check: (a) => (a !== 'capA' && db.rows('TeamMember').find((m) => m.id === ID.memA2)!.fullName !== 'Alpha Member' ? `${a} edited A's member` : null)
  },
  {
    route: 'DELETE /teams/:id/members/:memberId',
    idor: true,
    method: 'DELETE',
    path: `/teams/${ID.teamA}/members/${ID.memA2}`,
    expect: captainOwned('ok'),
    check: (a) => (a !== 'capA' && !db.rows('TeamMember').some((m) => m.id === ID.memA2) ? `${a} removed A's member` : null)
  },
  {
    route: 'POST /teams/:id/approve-public',
    idor: true,
    method: 'POST',
    path: `/teams/${ID.teamB}/approve-public`,
    body: {},
    expect: staffOnly(['SA', 'EA'], 'ok'),
    check: (a) => (!['SA', 'EA'].includes(a) && db.rows('Team').find((t) => t.id === ID.teamB)!.isApprovedPublic ? `${a} published team B` : null)
  },

  // ----- uploads -----
  {
    route: 'POST /uploads/stream',
    method: 'POST',
    path: '/uploads/stream',
    form: (a) => pdfForm(`stream-${a}`)(),
    expect: { anon: 401, capA: 'ok', capB: 'ok', capU: 403, SA: 'ok', EA: 'ok', INS: 403, JUDGE: 403 }
  },
  {
    route: 'POST /uploads',
    method: 'POST',
    path: '/uploads',
    body: (a: Actor) => ({ fileName: `json-${a}.pdf`, base64Data: PDF(`json-${a}`).toString('base64'), purpose: 'DOCUMENT' }),
    expect: { anon: 401, capA: 'ok', capB: 'ok', capU: 403, SA: 'ok', EA: 'ok', INS: 403, JUDGE: 403 }
  },
  {
    route: 'GET /uploads/signed-url/:assetId',
    idor: true,
    method: 'GET',
    path: `/uploads/signed-url/${ID.assetAdoc}`,
    expect: ownerOrStaff(['SA', 'EA', 'INS']),
    noLeakScan: true // the signed URL legitimately names A's key for the owner and staff; denials are checked below
  },
  {
    route: 'GET /uploads/signed-url/:assetId',
    label: "captain A's ID proof",
    idor: true,
    method: 'GET',
    path: `/uploads/signed-url/${ID.assetAid}`,
    expect: ownerOrStaff(['SA', 'EA', 'INS']),
    noLeakScan: true
  },
  { route: 'GET /uploads/files/:key', label: "A's private document without a token", idor: true, noLeakScan: true, check: (_a, r) => (has(r, 'A-PRIVATE-FILE-CONTENT') ? 'file content served' : null), method: 'GET', path: `/uploads/files/${KEY.Adoc}`, expect: { anon: 403, capA: 403, capB: 403, capU: 403, SA: 403, EA: 403, INS: 403, JUDGE: 403 } },
  { route: 'GET /uploads/files/:key', label: 'public site image', idor: true, method: 'GET', path: `/uploads/files/${KEY.public}`, expect: PUBLIC_OK },

  // ----- CSP reports -----
  { route: 'POST /csp-report', method: 'POST', path: '/csp-report', body: { 'csp-report': { 'blocked-uri': 'inline' } }, expect: PUBLIC_ANY }
];

/** Body or form for a case and actor. */
function requestFor(c: Case, actor: Actor): CallOpts {
  const opts: CallOpts = {};
  if (c.form) opts.form = c.form(actor);
  else if (c.body !== undefined) opts.body = typeof c.body === 'function' ? (c.body as (a: Actor) => unknown)(actor) : c.body;
  if (c.label === 'unapproved team A') opts.mutate = (s) => (s.Team.find((t) => t.id === ID.teamA)!.isApprovedPublic = false);
  return opts;
}

// ---------------------------------------------------------------------------------------------------------------
// Results table

interface ResultRow {
  route: string;
  label?: string;
  idor: boolean;
  cells: Record<Actor, { status: number; exp: Exp; ok: boolean; note?: string }>;
}
const RESULTS: ResultRow[] = [];

function leakScan(actor: Actor, res: Res): string | null {
  if (actor === 'capA' || isStaff(actor)) return null;
  const secrets = actor === 'capB' ? A_PRIVATE : actor === 'anon' ? [...A_PRIVATE, ...B_PRIVATE] : [...A_PRIVATE, ...B_PRIVATE];
  const found = secrets.filter((s) => res.text.includes(s));
  return found.length ? `leaks ${found.join(', ')}` : null;
}

// ---------------------------------------------------------------------------------------------------------------

beforeAll(async () => {
  // Outbound HTTP stub: the API under test may call Razorpay or HIBP; nothing leaves this process.
  (global as any).fetch = async (input: any, init?: any) => {
    const target = String(input?.url ?? input);
    if (base && target.startsWith(base)) return realFetch(input, init);
    outbound.push(target.replace(/\?.*$/, ''));
    if (target.includes('api.razorpay.com')) {
      const body = target.includes('/refund')
        ? { id: 'rfnd_acl', status: 'processed', amount: 118000 }
        : target.includes('/orders/') && target.endsWith('/payments')
          ? { items: [] }
          : target.includes('/orders')
            ? { id: `order_acl_${Date.now()}`, amount: 118000, currency: 'INR', status: 'created' }
            : { id: 'pay_acl', status: 'captured', order_id: 'order_none', amount: 118000 };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('', { status: 200 });
  };

  // Stored files (plaintext; served as legacy unencrypted uploads)
  const dir = process.env.STORAGE_LOCAL_DIR || path.join(os.tmpdir(), 'gcdis-test-uploads');
  fs.mkdirSync(dir, { recursive: true });
  for (const [label, k] of Object.entries(KEY)) {
    fs.writeFileSync(path.join(dir, k), label === 'public' ? PNG : Buffer.from(`%PDF-1.4\n${label.startsWith('A') ? 'A-PRIVATE-FILE-CONTENT' : `${label}-content`}\n%%EOF`));
  }
  // A file just outside the upload directory, for the traversal checks
  fs.writeFileSync(path.join(path.dirname(dir), `acl-outside-${RUN}.txt`), 'OUTSIDE-UPLOAD-DIR');

  resetState();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PrismaService).useValue(db).compile();
  app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  // Mirror main.ts (middleware order, parsers, filter, pipes, prefix)
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

afterAll(async () => {
  await app?.close();
  (global as any).fetch = realFetch;
  for (const k of Object.values(KEY)) fs.rmSync(path.join(UPLOAD_DIR, k), { force: true });
  fs.rmSync(path.join(path.dirname(UPLOAD_DIR), `acl-outside-${RUN}.txt`), { force: true });

  const out = process.env.ACL_MATRIX_OUT;
  if (out) fs.writeFileSync(out, JSON.stringify(RESULTS, null, 2));
});

// ---------------------------------------------------------------------------------------------------------------
// 1. Route inventory: every declared route has a row in the matrix

function declaredRoutes(): string[] {
  const routes: string[] = [];
  for (const [file, name] of CONTROLLER_FILES) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ctrl = require(`../apps/api/src/${file}`)[name];
    const prefix = String(Reflect.getMetadata(PATH_METADATA, ctrl) ?? '');
    for (const prop of Object.getOwnPropertyNames(ctrl.prototype)) {
      const handler = ctrl.prototype[prop];
      if (typeof handler !== 'function' || prop === 'constructor') continue;
      const p = Reflect.getMetadata(PATH_METADATA, handler);
      const m = Reflect.getMetadata(METHOD_METADATA, handler);
      if (p === undefined || m === undefined) continue;
      const full = ('/' + [prefix, String(p)].filter((s) => s && s !== '/').join('/')).replace(/\/+/g, '/');
      routes.push(`${RequestMethod[m]} ${full}`);
    }
  }
  return routes;
}

describe('route inventory', () => {
  test('every controller route is covered by the matrix', () => {
    const declared = declaredRoutes();
    expect(declared.length).toBeGreaterThan(90);
    const covered = new Set(CASES.map((c) => c.route));
    expect(declared.filter((r) => !covered.has(r))).toEqual([]);
    // and the matrix names no route that does not exist
    expect([...covered].filter((r) => !declared.includes(r))).toEqual([]);
  });

  test('the only routes without authentication are the declared @Public ones', () => {
    const publicRoutes: string[] = [];
    for (const [file, name] of CONTROLLER_FILES) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ctrl = require(`../apps/api/src/${file}`)[name];
      const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, ctrl) === true;
      const prefix = String(Reflect.getMetadata(PATH_METADATA, ctrl) ?? '');
      for (const prop of Object.getOwnPropertyNames(ctrl.prototype)) {
        const handler = ctrl.prototype[prop];
        const p = typeof handler === 'function' ? Reflect.getMetadata(PATH_METADATA, handler) : undefined;
        const m = typeof handler === 'function' ? Reflect.getMetadata(METHOD_METADATA, handler) : undefined;
        if (p === undefined || m === undefined || prop === 'constructor') continue;
        if (classPublic || Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true) {
          publicRoutes.push(`${RequestMethod[m]} ${('/' + [prefix, String(p)].filter((s) => s && s !== '/').join('/')).replace(/\/+/g, '/')}`);
        }
      }
    }
    const matrixPublic = new Set(CASES.filter((c) => c.expect.anon !== 401).map((c) => c.route));
    expect(publicRoutes.sort()).toEqual([...matrixPublic].sort());
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. The matrix: every route x every actor

describe('access-control matrix', () => {
  for (const c of CASES) {
    const title = `${c.route}${c.label ? ` [${c.label}]` : ''}`;
    test(title, async () => {
      const row: ResultRow = { route: c.route, label: c.label, idor: !!c.idor, cells: {} as ResultRow['cells'] };
      const failures: string[] = [];
      for (const actor of ACTORS) {
        const exp = c.expect[actor];
        const res = await call(actor, c.method, c.path, requestFor(c, actor));
        const notes: string[] = [];
        let ok = meets(res.status, exp);
        if (!ok) notes.push(`status ${res.status}, expected ${exp}${res.json?.message ? ` (${JSON.stringify(res.json.message).slice(0, 160)})` : ''}`);
        const extra = c.check?.(actor, res) ?? null;
        if (extra) {
          ok = false;
          notes.push(extra);
        }
        if (!c.noLeakScan) {
          const leak = leakScan(actor, res);
          if (leak) {
            ok = false;
            notes.push(leak);
          }
        }
        row.cells[actor] = { status: res.status, exp, ok, note: notes.join('; ') || undefined };
        if (!ok) failures.push(`${actor}: ${notes.join('; ')}`);
      }
      RESULTS.push(row);
      expect(failures).toEqual([]);
    }, 60000);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Object-level cross-references (an id of A's paired with B's container and vice versa)

describe('cross-object references', () => {
  test("captain B cannot reach A's member through B's own team id (PATCH / DELETE)", async () => {
    let res = await call('capB', 'PATCH', `/teams/${ID.teamB}/members/${ID.memA2}`, { body: { fullName: 'Hijacked' } });
    expect(res.status).toBe(404);
    expect(db.rows('TeamMember').find((m) => m.id === ID.memA2)!.fullName).toBe('Alpha Member');
    res = await call('capB', 'DELETE', `/teams/${ID.teamB}/members/${ID.memA2}`);
    expect(res.status).toBe(404);
    expect(db.rows('TeamMember').some((m) => m.id === ID.memA2)).toBe(true);
  });

  test("captain A cannot edit B's member through A's team id", async () => {
    const res = await call('capA', 'PATCH', `/teams/${ID.teamA}/members/${ID.memB2}`, { body: { fullName: 'Hijacked' } });
    expect(res.status).toBe(404);
    expect(db.rows('TeamMember').find((m) => m.id === ID.memB2)!.fullName).toBe('Bravo Member');
  });

  test("staff review of B's document through A's registration id is refused", async () => {
    const res = await call('SA', 'PATCH', `/registrations/${ID.regA}/documents/${ID.docB}`, { body: { status: 'VERIFIED' } });
    expect(res.status).toBe(404);
    expect(db.rows('Document').find((d) => d.id === ID.docB)!.status).toBe('PENDING');
  });

  test("captain B cannot link A's uploaded file to B's own registration", async () => {
    const res = await call('capB', 'POST', `/registrations/${ID.regB}/documents`, { body: { type: 'INSURANCE', assetId: ID.assetAfree } });
    expect(res.status).toBe(403);
    expect(db.rows('Document').filter((d) => d.registrationId === ID.regB)).toHaveLength(1);
  });

  test("captain B cannot reference A's ID proof as a member ID proof of B's team", async () => {
    let res = await call('capB', 'POST', `/teams/${ID.teamB}/members`, {
      body: { fullName: 'Proxy', email: 'proxy@acl.test', memberRole: 'PILOT', idProofUrl: url(KEY.Aid) }
    });
    expect(res.status).toBe(400);
    expect(db.rows('TeamMember').some((m) => m.email === 'proxy@acl.test')).toBe(false);
    res = await call('capB', 'PATCH', `/teams/${ID.teamB}/members/${ID.memB2}`, { body: { idProofUrl: url(KEY.Aid) } });
    expect(res.status).toBe(400);
  });

  test("captain B cannot open a payment order or verify a payment on A's registration (body ids)", async () => {
    outbound.length = 0;
    expect((await call('capB', 'POST', '/payments/create-order', { body: { registrationId: ID.regA } })).status).toBe(403);
    expect((await call('capB', 'POST', '/payments/verify-signature', { body: { razorpayOrderId: 'order_A_0001', razorpayPaymentId: 'x', razorpaySignature: 'y' } })).status).toBe(403);
    expect(outbound.filter((u) => u.includes('razorpay'))).toEqual([]);
  });

  test('a captain registering with a team id they do not own is refused (body id)', async () => {
    const res = await call('capB', 'POST', '/registrations', { body: { teamId: ID.teamA, categoryId: ID.category } });
    expect(res.status).toBe(403);
    expect(db.rows('Registration')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. Mass assignment

describe('mass assignment', () => {
  test('POST /teams ignores or rejects captainId / isApprovedPublic / code', async () => {
    const res = await call('capU', 'POST', '/teams', {
      body: { categoryId: ID.category, teamName: 'Sneaky', institutionName: 'X', city: 'Y', captainId: ID.capA, isApprovedPublic: true, code: 'X1' }
    });
    expect(res.status).toBe(400);
    const teams = db.rows('Team');
    expect(teams.filter((t) => t.captainId === ID.capA)).toHaveLength(1);
    expect(teams.some((t) => t.name === 'SNEAKY')).toBe(false);
  });

  test('POST /teams member rows cannot carry userId / status / teamId', async () => {
    const res = await call('capU', 'POST', '/teams', {
      body: {
        categoryId: ID.category,
        teamName: 'Sneaky',
        institutionName: 'X',
        city: 'Y',
        members: [{ fullName: 'M', email: 'm@acl.test', memberRole: 'PILOT', userId: ID.SA, status: 'APPROVED', teamId: ID.teamA }]
      }
    });
    expect(res.status).toBe(400);
    expect(db.rows('TeamMember').some((m) => m.email === 'm@acl.test')).toBe(false);
  });

  test('PATCH member: teamId / status / userId / role fields are rejected', async () => {
    for (const extra of [{ teamId: ID.teamB }, { status: 'APPROVED' }, { userId: ID.SA }, { role: 'SUPER_ADMIN' }, { memberRole: 'CAPTAIN' }]) {
      const res = await call('capA', 'PATCH', `/teams/${ID.teamA}/members/${ID.memA2}`, { body: { fullName: 'Renamed', ...extra } });
      expect({ extra, status: res.status }).toEqual({ extra, status: 400 });
      const m = db.rows('TeamMember').find((r) => r.id === ID.memA2)!;
      expect({ teamId: m.teamId, status: m.status, userId: m.userId, memberRole: m.memberRole }).toEqual({ teamId: ID.teamA, status: 'PENDING', userId: null, memberRole: 'PILOT' });
    }
  });

  test('POST /registrations: status / approvedAt / registrationCode are rejected', async () => {
    const res = await call('capB', 'POST', '/registrations', {
      body: { teamId: ID.teamB, categoryId: ID.category, status: 'APPROVED', approvedAt: new Date().toISOString(), registrationCode: 'X' }
    });
    expect(res.status).toBe(400);
    const res2 = await call('capA', 'POST', '/registrations', { body: { teamId: ID.teamA, categoryId: ID.category, status: 'APPROVED' } });
    expect(res2.status).toBe(400);
    expect(db.rows('Registration').find((r) => r.id === ID.regA)!.status).toBe('DOCUMENT_REVIEW');
  });

  test('PATCH /registrations/:id/status: a captain cannot self-approve or smuggle approvedAt / teamId', async () => {
    let res = await call('capA', 'PATCH', `/registrations/${ID.regA}/status`, { body: { targetStatus: 'APPROVED' } });
    expect([400, 403]).toContain(res.status);
    res = await call('capA', 'PATCH', `/registrations/${ID.regA}/status`, { body: { targetStatus: 'WITHDRAWN', approvedAt: new Date().toISOString(), teamId: ID.teamB } });
    expect(res.status).toBe(400);
    const reg = db.rows('Registration').find((r) => r.id === ID.regA)!;
    expect({ status: reg.status, approvedAt: reg.approvedAt, teamId: reg.teamId }).toEqual({ status: 'DOCUMENT_REVIEW', approvedAt: null, teamId: ID.teamA });
  });

  test('POST /registrations/:id/documents: status / fileUrl / registrationId are rejected', async () => {
    for (const extra of [{ status: 'VERIFIED' }, { fileUrl: url(KEY.Bdoc) }, { registrationId: ID.regB }]) {
      const res = await call('capA', 'POST', `/registrations/${ID.regA}/documents`, { body: { type: 'INSURANCE', assetId: ID.assetAfree, ...extra } });
      expect({ extra, status: res.status }).toEqual({ extra, status: 400 });
    }
  });

  test('PATCH document review (staff): registrationId / fileUrl cannot be rewritten', async () => {
    const res = await call('EA', 'PATCH', `/registrations/${ID.regA}/documents/${ID.docA}`, { body: { status: 'VERIFIED', registrationId: ID.regB, fileUrl: url(KEY.Bdoc) } });
    expect(res.status).toBe(400);
    const d = db.rows('Document').find((x) => x.id === ID.docA)!;
    expect({ registrationId: d.registrationId, fileUrl: d.fileUrl, status: d.status }).toEqual({ registrationId: ID.regA, fileUrl: url(KEY.Adoc), status: 'PENDING' });
  });

  test('POST /uploads: uploadedBy / isPublic are rejected; captains cannot pick public purposes', async () => {
    let res = await call('capA', 'POST', '/uploads', { body: { fileName: 'a.pdf', base64Data: PDF('a').toString('base64'), uploadedBy: ID.capB, isPublic: true } });
    expect(res.status).toBe(400);
    res = await call('capA', 'POST', '/uploads', { body: { fileName: 'a.png', base64Data: PNG.toString('base64'), purpose: 'CMS_MEDIA' } });
    expect(res.status).toBe(403);
    const fd = new FormData();
    fd.append('file', new Blob([PNG], { type: 'image/png' }), 'a.png');
    fd.append('purpose', 'SITE_IMAGE');
    res = await call('capA', 'POST', '/uploads/stream', { form: fd });
    expect(res.status).toBe(403);
    expect(db.rows('MediaAsset').filter((m) => m.isPublic && m.uploadedBy === ID.capA)).toHaveLength(0);
  });

  test('POST /auth/register: role is always TEAM_CAPTAIN', async () => {
    const res = await call('anon', 'POST', '/auth/register', {
      body: { email: 'escalate@acl.test', password: 'Vq7!acl-Matrix-Pass-2026', fullName: 'Escalation Attempt', role: 'SUPER_ADMIN' }
    });
    expect([200, 201]).toContain(res.status);
    const u = db.rows('User').find((x) => x.email === 'escalate@acl.test')!;
    expect(u.role).toBe('TEAM_CAPTAIN');
    expect(res.json?.user?.role).toBe('TEAM_CAPTAIN');
  });

  test('PATCH /auth/users/:id/role: a captain cannot promote itself', async () => {
    const res = await call('capA', 'PATCH', `/auth/users/${ID.capA}/role`, { body: { role: 'SUPER_ADMIN' } });
    expect(res.status).toBe(403);
    expect(db.rows('User').find((u) => u.id === ID.capA)!.role).toBe('TEAM_CAPTAIN');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. Signed URLs for private files

describe('signed URLs', () => {
  const sign = (k: string, expires: number) => crypto.createHmac('sha256', process.env.JWT_SECRET as string).update(`${k}:${expires}`).digest('hex');

  async function signedUrlFor(actor: UserActor, assetId: string): Promise<string> {
    const res = await call(actor, 'GET', `/uploads/signed-url/${assetId}`);
    expect(res.status).toBe(200);
    return res.json.url as string;
  }

  test("A's signed URL downloads A's file (anonymously, as intended for short-lived links)", async () => {
    const u = await signedUrlFor('capA', ID.assetAdoc);
    const res = await call('anon', 'GET', u.replace(/^\/api/, ''), { keepState: true });
    expect(res.status).toBe(200);
    expect(res.text).toContain('A-PRIVATE-FILE-CONTENT');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  test("A's token cannot be reused for B's file", async () => {
    const u = new URL(await signedUrlFor('capA', ID.assetAdoc), 'http://x');
    const token = u.searchParams.get('token')!;
    const expires = u.searchParams.get('expires')!;
    const res = await call('capA', 'GET', `/uploads/files/${KEY.Bdoc}?token=${token}&expires=${expires}`, { keepState: true });
    expect(res.status).toBe(403);
    expect(res.text).not.toContain('Bdoc-content');
  });

  test('expired, extended, tampered, empty and malformed tokens are rejected', async () => {
    const u = new URL(await signedUrlFor('capA', ID.assetAdoc), 'http://x');
    const token = u.searchParams.get('token')!;
    const expires = Number(u.searchParams.get('expires'));
    const past = Math.floor(Date.now() / 1000) - 10;
    const attempts: Array<[string, string]> = [
      ['expired (validly signed)', `token=${sign(KEY.Adoc, past)}&expires=${past}`],
      ['expires extended', `token=${token}&expires=${expires + 3600}`],
      ['tampered token', `token=${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}&expires=${expires}`],
      ['truncated token', `token=${token.slice(0, 32)}&expires=${expires}`],
      ['no token', `expires=${expires}`],
      ['no expiry', `token=${token}`],
      ['non-numeric expiry', `token=${token}&expires=abc`],
      ['token array', `token=${token}&token=${token}&expires=${expires}`]
    ];
    for (const [what, qs] of attempts) {
      const res = await call('anon', 'GET', `/uploads/files/${KEY.Adoc}?${qs}`, { keepState: true });
      expect({ what, status: res.status }).toEqual({ what, status: 403 });
    }
  });

  test('key path traversal cannot escape the upload directory or swap the signed key', async () => {
    const u = new URL(await signedUrlFor('capA', ID.assetAdoc), 'http://x');
    const qs = u.search;
    const attempts = [
      `..%2Facl-outside-${RUN}.txt`,
      `..%2F..%2F..%2Fetc%2Fpasswd`,
      `..%5Cacl-outside-${RUN}.txt`,
      `sub%2F..%2F${KEY.Bdoc}${qs}`,
      `${KEY.Bdoc}%2F..%2F${KEY.Adoc}${qs.replace(/^\?/, '?x=1&')}`,
      `%2E%2E%2F${KEY.Bdoc}${qs}`
    ];
    for (const p of attempts) {
      const res = await call('capB', 'GET', `/uploads/files/${p}`, { keepState: true });
      expect({ p, ok: res.status === 200 && (res.text.includes('OUTSIDE-UPLOAD-DIR') || res.text.includes('Bdoc-content') || res.text.includes('root:')) }).toEqual({ p, ok: false });
      expect({ p, status: res.status >= 400 || res.text.includes('A-PRIVATE-FILE-CONTENT') }).toEqual({ p, status: true });
    }
  });

  test("captain B cannot mint a signed URL for A's document or ID proof, JUDGE cannot either", async () => {
    for (const a of ['capB', 'capU', 'JUDGE'] as const) {
      for (const asset of [ID.assetAdoc, ID.assetAid, ID.assetAfree]) {
        const res = await call(a, 'GET', `/uploads/signed-url/${asset}`);
        expect({ a, asset, status: res.status }).toEqual({ a, asset, status: 403 });
        expect(res.text).not.toContain('token=');
      }
    }
  });

  test('a private file stays private once linked even if a public asset row claims the same URL', async () => {
    const res = await call('anon', 'GET', `/uploads/files/${KEY.Adoc}`, {
      mutate: (s) => s.MediaAsset.push({ ...s.MediaAsset[0], id: id(10, 99), isPublic: true, purpose: 'CMS_MEDIA' })
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 6. Sessions and tokens

describe('sessions and tokens', () => {
  test("DELETE /auth/sessions/:id for another user's session fails and leaves it active", async () => {
    for (const a of ['capB', 'capU', 'SA', 'EA', 'INS', 'JUDGE'] as const) {
      const res = await call(a, 'DELETE', `/auth/sessions/${ID.sessA2}`);
      expect({ a, status: res.status }).toEqual({ a, status: 404 });
      const s = db.rows('Session').find((r) => r.id === ID.sessA2)!;
      expect({ a, active: s.isActive, revokedAt: s.revokedAt }).toEqual({ a, active: true, revokedAt: null });
    }
    // Owner can revoke it
    const own = await call('capA', 'DELETE', `/auth/sessions/${ID.sessA2}`);
    expect(own.status).toBe(200);
    expect(db.rows('Session').find((r) => r.id === ID.sessA2)!.isActive).toBe(false);
  });

  test("captain B's token bound to A's session id (sid swap) is rejected", async () => {
    const token = signAccess('capB', { sid: SID.capA });
    expect((await call('capB', 'GET', '/teams/my-team', { token })).status).toBe(401);
  });

  test('a public token re-labelled with the admin audience is rejected (wrong key)', async () => {
    const forged = signAccess('capA', { aud: 'gcdis-admin', role: 'SUPER_ADMIN' }, { secret: getPublicJwtSecret() });
    expect((await call('capA', 'GET', '/auth/users', { token: forged })).status).toBe(401);
  });

  test('alg=none, expired, foreign-key and sessionless tokens are rejected', async () => {
    const payload = { sub: ID.capA, role: 'TEAM_CAPTAIN', aud: 'gcdis-public', sid: SID.capA };
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.`;
    const expired = signAccess('capA', {}, { expiresIn: -10 });
    const foreign = signAccess('capA', {}, { secret: 'some-other-secret-with-enough-length-0123456789' });
    const noSid = jwt.sign({ sub: ID.capA, role: 'TEAM_CAPTAIN', aud: 'gcdis-public' }, getPublicJwtSecret());
    const challenge = jwt.sign({ ...payload, type: '2fa_challenge' }, getPublicJwtSecret());
    for (const [what, token] of Object.entries({ none, expired, foreign, noSid, challenge })) {
      const res = await call('capA', 'GET', '/teams/my-team', { token });
      expect({ what, status: res.status }).toEqual({ what, status: 401 });
    }
  });

  test('a revoked or expired session invalidates its access token immediately', async () => {
    let res = await call('capA', 'GET', '/teams/my-team', { mutate: (s) => (s.Session.find((x) => x.id === SID.capA)!.revokedAt = new Date()) });
    expect(res.status).toBe(401);
    res = await call('capA', 'GET', '/teams/my-team', { mutate: (s) => (s.Session.find((x) => x.id === SID.capA)!.expiresAt = new Date(Date.now() - 1000)) });
    expect(res.status).toBe(401);
    res = await call('capA', 'GET', '/teams/my-team', { mutate: (s) => (s.User.find((x) => x.id === ID.capA)!.isActive = false) });
    expect(res.status).toBe(401);
  });

  test('the role claim in a token is not trusted: the database role decides', async () => {
    // A judge token claiming SUPER_ADMIN (e.g. issued before a demotion)
    const token = signAccess('JUDGE', { role: 'SUPER_ADMIN' });
    expect((await call('JUDGE', 'GET', '/auth/users', { token })).status).toBe(403);
    expect((await call('JUDGE', 'POST', `/payments/${ID.payA}/refund`, { token, body: {} })).status).toBe(403);
  });

  test('a staff session of an account demoted to captain is rejected', async () => {
    const res = await call('EA', 'GET', '/audit', { mutate: (s) => (s.User.find((x) => x.id === ID.EA)!.role = 'TEAM_CAPTAIN') });
    expect(res.status).toBe(401);
  });

  test('staff without two-factor authentication cannot use staff routes', async () => {
    const res = await call('SA', 'GET', '/auth/users', { mutate: (s) => (s.User.find((x) => x.id === ID.SA)!.isTwoFactorEnabled = false) });
    expect(res.status).toBe(403);
    expect(res.json?.code).toBe('TWO_FACTOR_REQUIRED');
  });

  test('step-up protected routes refuse a staff session without a recent step-up', async () => {
    const noStepUp = (s: Record<string, any[]>) => s.Session.forEach((x) => (x.stepUpAt = null));
    for (const [method, p, body] of [
      ['POST', `/payments/${ID.payA}/refund`, {}],
      ['PATCH', `/auth/users/${ID.capA}/role`, { role: 'JUDGE' }],
      ['PATCH', `/auth/users/${ID.capA}/status`, { isActive: false }],
      ['POST', '/auth/staff-user', { email: 'x@acl.test', fullName: 'X Y', role: 'JUDGE' }],
      ['POST', `/auth/users/${ID.capU}/mark-email-verified`, {}],
      ['POST', `/auth/users/${ID.capU}/reveal-verification-code`, {}],
      ['POST', '/cms/admin/home/sections/news/reset', {}],
      ['PUT', '/cms/admin/settings/site-info', {}],
      ['DELETE', `/cms/admin/sponsors/${ID.sponsor}`, undefined],
      ['DELETE', `/cms/admin/gallery/${ID.gallery}`, undefined],
      ['DELETE', `/cms/admin/championship-media/gallery/${ID.gallery}`, undefined],
      ['DELETE', '/cms/admin/championship-media/hero/video', undefined],
      ['DELETE', '/cms/admin/championship-media/hero/poster', undefined],
      ['DELETE', '/cms/admin/championship-media/sections/facts/image', undefined],
      ['DELETE', '/cms/admin/championship-media/sections/categories/items/d20/video', undefined],
      // Sensitive reads (admin hardening): audit export and staff signed URLs for ID proofs / documents
      ['GET', `/audit/export?actorId=${ID.capA}`, undefined],
      ['GET', `/uploads/signed-url/${ID.assetAdoc}`, undefined]
    ] as const) {
      const res = await call('SA', method, p, { body, mutate: noStepUp });
      expect({ p, status: res.status, code: res.json?.code }).toEqual({ p, status: 403, code: 'STEP_UP_REQUIRED' });
    }
    expect(db.rows('Payment').find((x) => x.id === ID.payA)!.status).toBe('SUCCESS');
  });

  test('CSRF: state-changing calls from a foreign origin are refused before any ownership logic', async () => {
    const res = await call('capA', 'POST', `/teams/${ID.teamA}/members`, {
      body: { fullName: 'X', email: 'csrf@acl.test', memberRole: 'PILOT' },
      headers: { origin: 'https://evil.example' }
    });
    expect(res.status).toBe(403);
    expect(db.rows('TeamMember').some((m) => m.email === 'csrf@acl.test')).toBe(false);
  });

  test('unverified captain: EmailVerifiedGuard blocks registration, payment order and uploads', async () => {
    for (const [method, p, opts] of [
      ['POST', '/registrations', { body: { teamId: ID.teamA, categoryId: ID.category } }],
      ['POST', '/payments/create-order', { body: { registrationId: ID.regA } }],
      ['POST', '/uploads', { body: { fileName: 'u.pdf', base64Data: PDF('u').toString('base64') } }],
      ['POST', '/uploads/stream', { form: pdfForm('u')() }]
    ] as const) {
      const res = await call('capU', method, p, opts as CallOpts);
      expect({ p, status: res.status, code: res.json?.code }).toEqual({ p, status: 403, code: 'EMAIL_NOT_VERIFIED' });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 7. Public routes do not leak private fields or unapproved teams

describe('public data exposure', () => {
  const PRIVATE_FIELD = /"(email|phone|mobile|idProofUrl|passwordHash|captainId|userId|paymentId|orderId|gatewaySignature)"\s*:/;

  test('GET /teams/public and /teams/category/:id list approved teams only, without contact fields', async () => {
    for (const p of ['/teams/public', `/teams/category/${ID.category}`]) {
      const res = await call('anon', 'GET', p);
      expect(res.status).toBe(200);
      const ids = (res.json as any[]).map((t) => t.id);
      expect({ p, ids }).toEqual({ p, ids: [ID.teamA] });
      expect({ p, privateField: res.text.match(PRIVATE_FIELD)?.[1] ?? null }).toEqual({ p, privateField: null });
    }
  });

  test("anonymous GET /teams/:id of an approved team has no emails, phones, ID proofs or user ids", async () => {
    const res = await call('anon', 'GET', `/teams/${ID.teamA}`);
    expect(res.status).toBe(200);
    expect(res.text.match(PRIVATE_FIELD)?.[1] ?? null).toBeNull();
  });

  test('public fixtures and live polling expose no private team fields', async () => {
    for (const p of ['/competition/fixtures', `/competition/fixtures/${ID.fixture}`, `/competition/fixtures/${ID.fixture}/live-polling`, `/competition/fixtures/category/${ID.category}`]) {
      const res = await call('anon', 'GET', p);
      expect({ p, status: res.status, privateField: res.text.match(PRIVATE_FIELD)?.[1] ?? null }).toEqual({ p, status: 200, privateField: null });
    }
  });

  test('public rankings do not reveal teams that are not publicly approved', async () => {
    const res = await call('anon', 'GET', `/competition/rankings/category/${ID.category}`);
    expect(res.status).toBe(200);
    expect(res.text.match(PRIVATE_FIELD)?.[1] ?? null).toBeNull();
    // Team B is registered but not approved for public display (GET /teams/:id answers 404 for it)
    expect({ unapprovedTeamListed: res.text.includes('TEAM BRAVO') || res.text.includes(ID.teamB) }).toEqual({ unapprovedTeamListed: false });
  });

  test("a captain's own activity feed does not expose the staff member's email, IP or user agent", async () => {
    // A Super Administrator verifies the unverified captain's email (audited with entityId = the captain's user id)
    const staffAction = await call('SA', 'POST', `/auth/users/${ID.capU}/mark-email-verified`, {
      body: { reason: 'Verified by telephone' },
      headers: { 'user-agent': 'StaffConsoleBrowser/1.0' }
    });
    expect(staffAction.status).toBe(200);
    const res = await call('capU', 'GET', '/audit/my-activity', { keepState: true });
    expect(res.status).toBe(200);
    const exposed = [USER_DEF.SA.email, 'StaffConsoleBrowser/1.0', ID.SA].filter((v) => res.text.includes(v));
    expect({ exposed }).toEqual({ exposed: [] });
  });

  test('public certificate verification shows only the certificate summary', async () => {
    const res = await call('anon', 'GET', '/certificates/verify/gcdis-cert-2026-aaaa0001');
    expect(res.status).toBe(200);
    expect(Object.keys(res.json.certificate).sort()).toEqual(['achievementTitle', 'code', 'issuedDate', 'recipientName', 'teamName']);
    const missing = await call('anon', 'GET', '/certificates/verify/GCDIS-CERT-2026-FFFFFFFF');
    expect(missing.json?.isValid).toBe(false);
  });

  test('public events / gallery / sponsors / site content contain no captain data', async () => {
    for (const p of ['/events', '/events/drone-soccer-2026', '/cms/public/site', '/cms/sponsors', '/cms/gallery', '/cms/public/home', '/cms/public/championship-media', '/competition/arenas']) {
      const res = await call('anon', 'GET', p);
      expect({ p, leak: leakScan('anon', res) }).toEqual({ p, leak: null });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 8. Socket.io scoring gateway

describe('scoring gateway (socket.io)', () => {
  function connect(token?: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const s = ioClient(base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: token ? { token } : {} });
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  }

  function scoreEvent(s: ClientSocket): Promise<{ ack?: any; exception?: any }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({}), 4000);
      s.once('exception', (e: any) => {
        clearTimeout(timer);
        resolve({ exception: e });
      });
      s.emit('score_event', { fixtureId: ID.fixture, teamId: ID.teamA, eventType: 'GOAL', scoreDelta: 1 }, (ack: any) => {
        clearTimeout(timer);
        resolve({ ack });
      });
    });
  }

  const cases: Array<[string, () => string | undefined, boolean]> = [
    ['anonymous', () => undefined, false],
    ['captain A public token', () => signAccess('capA'), false],
    ['captain A token relabelled admin audience', () => signAccess('capA', { aud: 'gcdis-admin' }, { secret: getPublicJwtSecret() }), false],
    ['INSPECTOR admin token', () => signAccess('INS'), false],
    ['JUDGE admin token', () => signAccess('JUDGE'), true],
    ['EVENT_ADMIN admin token', () => signAccess('EA'), true]
  ];

  for (const [who, tokenFn, allowed] of cases) {
    test(`score_event as ${who} is ${allowed ? 'accepted' : 'rejected'}`, async () => {
      resetState();
      const s = await connect(tokenFn());
      try {
        const r = await scoreEvent(s);
        const fixture = db.rows('Fixture')[0];
        if (allowed) {
          expect(r.exception).toBeUndefined();
          expect(r.ack?.status).toBe('ok');
          expect(fixture.team1Score).toBe(1);
        } else {
          expect(r.ack?.status).not.toBe('ok');
          expect(String(r.exception?.message ?? '')).toMatch(/Unauthorized|Forbidden/);
          expect(fixture.team1Score).toBe(0);
        }
      } finally {
        s.disconnect();
      }
    }, 15000);
  }

  test('a judge token whose session was revoked is rejected', async () => {
    resetState((sd) => (sd.Session.find((x) => x.id === SID.JUDGE)!.revokedAt = new Date()));
    const s = await connect(signAccess('JUDGE'));
    try {
      const r = await scoreEvent(s);
      expect(String(r.exception?.message ?? '')).toMatch(/revoked|expired/i);
      expect(db.rows('Fixture')[0].team1Score).toBe(0);
    } finally {
      s.disconnect();
    }
  }, 15000);
});

// ---------------------------------------------------------------------------------------------------------------
// 9. No external calls were made during the run except stubbed ones

describe('isolation', () => {
  test('outbound HTTP went only to stubbed hosts', () => {
    expect(outbound.filter((u) => !/api\.razorpay\.com|api\.pwnedpasswords\.com/.test(u))).toEqual([]);
  });
});

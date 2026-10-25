/**
 * Security audit 2026-10: data and business-logic findings (roster lock, uploads, invoices,
 * certificate verification, log redaction, refunds, payment edge cases, one team per captain,
 * inactive categories, registration state machine). All Prisma access is mocked.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import PDFDocument from 'pdfkit';
import {
  ALLOWED_REGISTRATION_TRANSITIONS,
  RegistrationStatus,
  TeamMemberRole,
  UserRole,
  canTransitionRegistration,
  isRoleAuthorizedForTransition
} from '@gcdis/shared';
import { REGISTRATION_TRANSITIONS } from '../apps/admin/src/app/_components/types';
import { TeamsService, ROSTER_LOCKED_MESSAGE, CAPTAIN_TEAM_EXISTS_MESSAGE } from '../apps/api/src/teams/teams.service';
import {
  UploadsService,
  PUBLIC_UPLOAD_PURPOSES,
  UPLOAD_PURPOSES,
  DEFAULT_CAPTAIN_UPLOAD_QUOTA_BYTES,
  UNLINKED_UPLOAD_MAX_AGE_MS
} from '../apps/api/src/uploads/uploads.service';
import { UploadsController, UPLOAD_RATE_LIMIT } from '../apps/api/src/uploads/uploads.controller';
import { UploadFileDto } from '../apps/api/src/uploads/dto/upload-file.dto';
import { EmailVerifiedGuard } from '../apps/api/src/auth/email-verified.guard';
import { StepUpGuard } from '../apps/api/src/auth/step-up.guard';
import { AccountIpRateLimiterGuard, RATE_LIMIT_KEY } from '../apps/api/src/common/guards/rate-limiter.guard';
import { CsrfGuard } from '../apps/api/src/common/guards/csrf.guard';
import {
  PdfGeneratorService,
  invoiceCacheFileName,
  formatGstRate
} from '../apps/api/src/certificates/pdf-generator.service';
import { CertificatesController } from '../apps/api/src/certificates/certificates.controller';
import { GenerateCertificateDto } from '../apps/api/src/certificates/dto/generate-certificate.dto';
import { RequestIdMiddleware } from '../apps/api/src/common/middleware/request-id.middleware';
import { redactUrl, validClientRequestId } from '../apps/api/src/common/middleware/log-sanitizer';
import { GlobalExceptionFilter } from '../apps/api/src/common/filters/global-exception.filter';
import { PaymentsService, minimalWebhookSnapshot } from '../apps/api/src/payments/payments.service';
import { PaymentsController } from '../apps/api/src/payments/payments.controller';
import { RefundPaymentDto } from '../apps/api/src/payments/dto/refund-payment.dto';
import { VerifyDocumentDto } from '../apps/api/src/registrations/dto/verify-document.dto';
import { RegistrationsService } from '../apps/api/src/registrations/registrations.service';

const ROOT = path.resolve(__dirname, '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const guardsOf = (fn: any): any[] => Reflect.getMetadata(GUARDS_METADATA, fn) || [];
const savedEnv = { ...process.env };
const validPdf = Buffer.from('%PDF-1.4\nsecurity audit fixture\n%%EOF');

async function statusOf(p: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await p;
    return 'ok';
  } catch (err: any) {
    return err instanceof HttpException ? err.getStatus() : -1;
  }
}

afterEach(() => {
  process.env = { ...savedEnv };
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------
describe('Finding 1: the roster is locked for add and edit once approved', () => {
  const CAPTAIN_ID = 'captain-1';
  function teamsPrisma(lockedStatus: string | null) {
    const prisma: any = {
      team: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'team-1',
          captainId: CAPTAIN_ID,
          category: { maxTeamSize: 7 },
          members: [
            { id: 'm0', email: 'cap@example.test', memberRole: TeamMemberRole.CAPTAIN, userId: CAPTAIN_ID },
            { id: 'm1', email: 'pilot@example.test', memberRole: TeamMemberRole.PILOT, userId: null }
          ]
        })
      },
      registration: {
        findFirst: jest.fn(async ({ where }: any) =>
          lockedStatus && where.status.in.includes(lockedStatus) ? { id: 'reg-1', status: lockedStatus } : null
        )
      },
      teamMember: {
        create: jest.fn(async ({ data }: any) => ({ id: 'new', ...data })),
        update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
        delete: jest.fn()
      },
      mediaAsset: { findFirst: jest.fn().mockResolvedValue(null) },
      $executeRaw: jest.fn().mockResolvedValue(1)
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    return prisma;
  }

  test.each(['APPROVED', 'ACCREDITED', 'COMPETING', 'ARENA_CLEARED', 'COMPLETED'])(
    'addMember and updateMember answer 409 with the roster-locked message at %s',
    async (status) => {
      const prisma = teamsPrisma(status);
      const svc = new TeamsService(prisma);
      const add = svc.addMember(CAPTAIN_ID, 'team-1', { fullName: 'New Pilot', email: 'new@example.test' });
      await expect(add).rejects.toThrow(ConflictException);
      await expect(svc.addMember(CAPTAIN_ID, 'team-1', { fullName: 'New Pilot' })).rejects.toThrow(ROSTER_LOCKED_MESSAGE);
      await expect(svc.updateMember(CAPTAIN_ID, 'team-1', 'm1', { fullName: 'Renamed' })).rejects.toThrow(
        ROSTER_LOCKED_MESSAGE
      );
      await expect(svc.removeMember({ id: CAPTAIN_ID }, 'team-1', 'm1')).rejects.toThrow(ROSTER_LOCKED_MESSAGE);
      expect(prisma.teamMember.create).not.toHaveBeenCalled();
      expect(prisma.teamMember.update).not.toHaveBeenCalled();
      expect(prisma.teamMember.delete).not.toHaveBeenCalled();
    }
  );

  test('before approval the roster can still be changed (check runs inside the locked transaction)', async () => {
    const prisma = teamsPrisma(null);
    const svc = new TeamsService(prisma);
    await expect(svc.addMember(CAPTAIN_ID, 'team-1', { fullName: 'New Pilot' })).resolves.toMatchObject({ teamId: 'team-1' });
    await expect(svc.updateMember(CAPTAIN_ID, 'team-1', 'm1', { fullName: 'Renamed' })).resolves.toMatchObject({
      fullName: 'Renamed'
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.registration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ teamId: 'team-1' }) })
    );
  });

  test('the API message is the one the portal shows, and the portal disables Add and Edit when locked', () => {
    const types = read('apps', 'web', 'src', 'app', 'portal', '_components', 'types.ts');
    expect(types).toContain(`'${ROSTER_LOCKED_MESSAGE}'`);
    const tab = read('apps', 'web', 'src', 'app', 'portal', '_components', 'MembersTab.tsx');
    expect(tab).toContain('disabled={!canManage || rosterFull || Boolean(removeLockedReason)}');
    expect(tab.match(/disabled=\{!canManage \|\| Boolean\(editDisabledReason\)\}/g)).toHaveLength(2);
    // API errors (including this 409) are shown as returned in the add/edit dialog
    const modal = read('apps', 'web', 'src', 'app', 'portal', '_components', 'MemberRequestModal.tsx');
    expect(modal).toMatch(/setError\(err instanceof Error && err\.message \? err\.message/);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('Finding 2 and 3: upload limits, quota, verified email, cleanup and strict purposes', () => {
  let assets: any[];
  let prisma: any;
  let service: UploadsService;

  beforeEach(() => {
    assets = [];
    prisma = {
      mediaAsset: {
        create: jest.fn(async ({ data }: any) => {
          const row = { id: `asset-${assets.length + 1}`, ...data };
          assets.push(row);
          return row;
        }),
        aggregate: jest.fn().mockResolvedValue({ _sum: { sizeBytes: 0 } }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      document: { findFirst: jest.fn().mockResolvedValue(null) },
      teamMember: { findFirst: jest.fn().mockResolvedValue(null) },
      team: { findFirst: jest.fn().mockResolvedValue(null) },
      sponsor: { findFirst: jest.fn().mockResolvedValue(null) },
      galleryImage: { findFirst: jest.fn().mockResolvedValue(null) },
      event: { findFirst: jest.fn().mockResolvedValue(null) },
      category: { findFirst: jest.fn().mockResolvedValue(null) }
    };
    service = new UploadsService(prisma, { logAction: jest.fn() } as any);
  });

  test('both upload routes allow 20 uploads per 10 minutes per account and 40 per IP', () => {
    for (const fn of [UploadsController.prototype.uploadFile, UploadsController.prototype.uploadFileStream]) {
      const rule = Reflect.getMetadata(RATE_LIMIT_KEY, fn);
      expect(rule).toEqual(expect.objectContaining({ points: 20, duration: 600, ipPoints: 40 }));
      expect(guardsOf(fn)).toContain(AccountIpRateLimiterGuard);
    }
    expect(UPLOAD_RATE_LIMIT).toEqual(expect.objectContaining({ points: 20, duration: 600, ipPoints: 40 }));
  });

  test('the 21st upload within 10 minutes is refused with 429', async () => {
    delete process.env.REDIS_URL;
    AccountIpRateLimiterGuard.resetMemoryStore();
    const guard = new AccountIpRateLimiterGuard(new Reflector());
    const ctx = {
      getHandler: () => UploadsController.prototype.uploadFileStream,
      getClass: () => UploadsController,
      switchToHttp: () => ({
        getRequest: () => ({ ip: '198.18.40.1', user: { id: 'cap-rl' }, route: { path: '/api/uploads/stream' } }),
        getResponse: () => ({ setHeader: jest.fn() })
      })
    } as any;
    const results: Array<number | 'ok'> = [];
    for (let i = 0; i < 21; i++) results.push(await statusOf(guard.canActivate(ctx)));
    expect(results.slice(0, 20).every((r) => r === 'ok')).toBe(true);
    expect(results[20]).toBe(429);
  });

  test('captain uploads require a verified email (EmailVerifiedGuard runs after authentication)', async () => {
    for (const fn of [UploadsController.prototype.uploadFile, UploadsController.prototype.uploadFileStream]) {
      const guards = guardsOf(fn);
      expect(guards).toContain(EmailVerifiedGuard);
      expect(guards).toContain(CsrfGuard);
    }
    const guard = new EmailVerifiedGuard({ user: { findUnique: jest.fn() } } as any);
    const ctx = (user: any) => ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as any;
    await expect(guard.canActivate(ctx({ id: 'c', role: 'TEAM_CAPTAIN', emailVerified: false }))).rejects.toThrow(
      ForbiddenException
    );
    await expect(guard.canActivate(ctx({ id: 'a', role: 'EVENT_ADMIN' }))).resolves.toBe(true);
  });

  test('a captain cannot exceed the 100 MB storage quota (SUM of sizeBytes); nothing is stored', async () => {
    expect(DEFAULT_CAPTAIN_UPLOAD_QUOTA_BYTES).toBe(100 * 1024 * 1024);
    prisma.mediaAsset.aggregate.mockResolvedValue({ _sum: { sizeBytes: DEFAULT_CAPTAIN_UPLOAD_QUOTA_BYTES - 10 } });
    const err: any = await service
      .processUpload(validPdf, 'doc.pdf', 'cap-1', UserRole.TEAM_CAPTAIN, 'DOCUMENT')
      .catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(413);
    expect(err.getResponse().code).toBe('UPLOAD_QUOTA_EXCEEDED');
    expect(prisma.mediaAsset.aggregate).toHaveBeenCalledWith({ where: { uploadedBy: 'cap-1' }, _sum: { sizeBytes: true } });
    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();

    // Within the quota the upload is accepted
    prisma.mediaAsset.aggregate.mockResolvedValue({ _sum: { sizeBytes: 1024 } });
    await expect(service.processUpload(validPdf, 'doc.pdf', 'cap-1', UserRole.TEAM_CAPTAIN, 'DOCUMENT')).resolves.toMatchObject({
      isPublic: false
    });
  });

  test('staff uploads are not counted against the captain quota', async () => {
    prisma.mediaAsset.aggregate.mockResolvedValue({ _sum: { sizeBytes: DEFAULT_CAPTAIN_UPLOAD_QUOTA_BYTES * 5 } });
    await expect(service.processUpload(validPdf, 'doc.pdf', 'admin-1', UserRole.EVENT_ADMIN, 'DOCUMENT')).resolves.toBeDefined();
    expect(prisma.mediaAsset.aggregate).not.toHaveBeenCalled();
  });

  test('cleanup deletes only unreferenced private DOCUMENT / ID_PROOF uploads older than 24 hours', async () => {
    const now = new Date('2026-10-15T12:00:00Z');
    prisma.mediaAsset.findMany.mockResolvedValue([
      { id: 'a-old', fileUrl: '/api/uploads/files/old_unlinked.pdf' },
      { id: 'a-doc', fileUrl: '/api/uploads/files/linked_document.pdf' },
      { id: 'a-id', fileUrl: '/api/uploads/files/linked_idproof.pdf' },
      { id: 'a-bad', fileUrl: 'https://elsewhere.example/x.pdf' }
    ]);
    prisma.document.findFirst.mockImplementation(async ({ where }: any) =>
      where.fileUrl === '/api/uploads/files/linked_document.pdf' ? { id: 'd1' } : null
    );
    prisma.teamMember.findFirst.mockImplementation(async ({ where }: any) =>
      where.idProofUrl === '/api/uploads/files/linked_idproof.pdf' ? { id: 'tm1' } : null
    );
    const del = jest.spyOn(service, 'deleteStoredFile').mockResolvedValue(true);

    const removed = await service.cleanupUnlinkedUploads(now);

    expect(removed).toBe(1);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith('/api/uploads/files/old_unlinked.pdf');
    const where = prisma.mediaAsset.findMany.mock.calls[0][0].where;
    expect(where.isPublic).toBe(false);
    expect(where.purpose).toEqual({ in: ['DOCUMENT', 'ID_PROOF'] });
    expect(where.createdAt.lt.getTime()).toBe(now.getTime() - UNLINKED_UPLOAD_MAX_AGE_MS);
  });

  test('cleanup fails safe: a reference lookup error keeps the file', async () => {
    prisma.mediaAsset.findMany.mockResolvedValue([{ id: 'a1', fileUrl: '/api/uploads/files/maybe.pdf' }]);
    prisma.sponsor.findFirst.mockRejectedValue(new Error('db down'));
    const del = jest.spyOn(service, 'deleteStoredFile').mockResolvedValue(true);
    expect(await service.cleanupUnlinkedUploads()).toBe(0);
    expect(del).not.toHaveBeenCalled();
  });

  test('cleanup runs opportunistically after an upload, at most once per interval', async () => {
    await service.processUpload(validPdf, 'a.pdf', 'cap-1', UserRole.TEAM_CAPTAIN, 'DOCUMENT');
    await service.processUpload(validPdf, 'b.pdf', 'cap-1', UserRole.TEAM_CAPTAIN, 'DOCUMENT');
    await new Promise((r) => setImmediate(r));
    expect(prisma.mediaAsset.findMany).toHaveBeenCalledTimes(1);
  });

  test('purpose is a strict enum: unknown values and TEAM_LOGO are refused by the DTO and the service', async () => {
    expect(UPLOAD_PURPOSES).not.toContain('TEAM_LOGO' as any);
    expect(PUBLIC_UPLOAD_PURPOSES.has('TEAM_LOGO')).toBe(false);

    const dto = (purpose: unknown) => plainToInstance(UploadFileDto, { fileName: 'a.pdf', base64Data: 'QQ==', purpose });
    expect(await validate(dto('DOCUMENT'))).toHaveLength(0);
    expect(await validate(dto(undefined))).toHaveLength(0);
    for (const bad of ['TEAM_LOGO', 'document', 'ANYTHING', '../x']) {
      const errors = await validate(dto(bad));
      expect(errors.map((e) => e.property)).toContain('purpose');
    }

    // The multipart route passes the raw form field: the service enforces the same whitelist
    for (const bad of ['TEAM_LOGO', 'PUBLIC', '']) {
      await expect(service.processUpload(validPdf, 'a.pdf', 'cap-1', UserRole.TEAM_CAPTAIN, bad)).rejects.toThrow(
        BadRequestException
      );
    }
    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
  });

  test('captains have no public purpose left (every public purpose is administrator-only)', async () => {
    for (const purpose of PUBLIC_UPLOAD_PURPOSES) {
      await expect(
        service.processUpload(validPdf, 'a.pdf', 'cap-1', UserRole.TEAM_CAPTAIN, purpose)
      ).rejects.toThrow(ForbiddenException);
    }
    const doc = await service.processUpload(validPdf, 'a.pdf', 'cap-1', UserRole.TEAM_CAPTAIN, 'ID_PROOF');
    expect(doc.isPublic).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('Finding 4: invoices carry no fake GSTIN, the real GST rate and the refund status', () => {
  const SOURCE = read('apps', 'api', 'src', 'certificates', 'pdf-generator.service.ts');

  function generator(): PdfGeneratorService {
    const svc = Object.create(PdfGeneratorService.prototype);
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gcdis-invoice-'));
    Object.assign(svc, { storageDir: dir, logger: { warn: jest.fn() } });
    return svc;
  }

  async function renderText(data: Partial<Parameters<PdfGeneratorService['generateInvoicePdf']>[0]>) {
    const texts: string[] = [];
    const original = (PDFDocument.prototype as any).text;
    jest.spyOn(PDFDocument.prototype as any, 'text').mockImplementation(function (this: any, ...args: any[]) {
      if (typeof args[0] === 'string') texts.push(args[0]);
      return original.apply(this, args);
    });
    const buf = await generator().generateInvoicePdf({
      invoiceNumber: `order_${crypto.randomBytes(4).toString('hex')}`,
      teamName: 'AERO',
      teamId: 'GCDIS-2026-T001',
      institution: 'Institute',
      captainName: 'Captain',
      captainEmail: 'captain@example.test',
      category: 'D40',
      amount: 11200,
      gstAmount: 1200,
      baseAmount: 10000,
      paymentRef: 'pay_1',
      issuedDate: 'October 15, 2026',
      ...data
    } as any);
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    return texts.join('\n');
  }

  test('the source contains no hard-coded GSTIN or IGST 18% label', () => {
    expect(SOURCE).not.toMatch(/\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/);
    expect(SOURCE).not.toContain('IGST 18%');
  });

  test('without INVOICE_GSTIN: no GSTIN and no ITC line', async () => {
    delete process.env.INVOICE_GSTIN;
    const text = await renderText({ paymentStatus: 'SUCCESS', gstRate: 18 });
    expect(text).not.toContain('GSTIN');
    expect(text).not.toContain('Input Tax Credit');
    expect(text).toContain('STATUS: PAID (VERIFIED)');
  });

  test('with INVOICE_GSTIN: the configured GSTIN is printed with the ITC line', async () => {
    process.env.INVOICE_GSTIN = '07TESTX0000T1Z5';
    const text = await renderText({ paymentStatus: 'SUCCESS', gstRate: 18 });
    expect(text).toContain('GSTIN: 07TESTX0000T1Z5');
    expect(text).toContain('Input Tax Credit (ITC) is applicable subject to filing under GSTIN 07TESTX0000T1Z5.');
  });

  test("the payment's own gstRate is printed", async () => {
    const text = await renderText({ paymentStatus: 'SUCCESS', gstRate: 12 });
    expect(text).toContain('Integrated GST (IGST 12%):');
    expect(formatGstRate(12.5)).toBe('12.5%');
    expect(formatGstRate(null)).toBe('18%');
  });

  test('REFUNDED payments are marked REFUNDED, never PAID (VERIFIED)', async () => {
    const text = await renderText({ paymentStatus: 'REFUNDED', gstRate: 18 });
    expect(text).toContain('STATUS: REFUNDED');
    expect(text).not.toContain('PAID (VERIFIED)');
  });

  test('the cache key includes the payment status (a refund invalidates the cached PDF)', () => {
    const paid = invoiceCacheFileName('order_1', 'SUCCESS', {} as any);
    const refunded = invoiceCacheFileName('order_1', 'REFUNDED', {} as any);
    expect(paid).not.toBe(refunded);
    expect(invoiceCacheFileName('../../etc/passwd', 'SUCCESS', {} as any)).not.toContain('/');
    expect(invoiceCacheFileName('order_1', 'SUCCESS', { INVOICE_GSTIN: 'X' } as any)).not.toBe(paid);
  });

  test('PaymentsService passes the payment status and gstRate to the generator', async () => {
    const pdf = { generateInvoicePdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')) };
    const prisma: any = {
      payment: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'p1',
          orderId: 'order_1',
          status: 'REFUNDED',
          amount: 11200,
          gstRate: 12,
          baseAmount: 10000,
          gstAmount: 1200,
          paidAt: new Date(),
          registration: {
            team: { captainId: 'c1', name: 'T', code: 'C', institutionName: 'I', captain: { fullName: 'F', email: 'e@x.test' } },
            category: { name: 'D40' }
          }
        })
      }
    };
    const svc = new PaymentsService(prisma, pdf as any, { logAction: jest.fn() } as any);
    await svc.generateInvoicePdf('p1', 'c1', UserRole.TEAM_CAPTAIN);
    expect(pdf.generateInvoicePdf).toHaveBeenCalledWith(expect.objectContaining({ paymentStatus: 'REFUNDED', gstRate: 12 }));
  });
});

// ---------------------------------------------------------------------------------------------------
describe('Finding 5: certificate verification is rate limited; generation needs CSRF and a UUID', () => {
  test('GET verify/:code: 30 per minute per IP, the 31st is refused with 429', async () => {
    const fn = CertificatesController.prototype.verifyCode;
    expect(guardsOf(fn)).toContain(AccountIpRateLimiterGuard);
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, fn)).toEqual(expect.objectContaining({ points: 30, duration: 60, ipPoints: 30 }));

    delete process.env.REDIS_URL;
    AccountIpRateLimiterGuard.resetMemoryStore();
    const guard = new AccountIpRateLimiterGuard(new Reflector());
    const ctx = {
      getHandler: () => fn,
      getClass: () => CertificatesController,
      switchToHttp: () => ({
        getRequest: () => ({ ip: '198.18.41.7', route: { path: '/api/certificates/verify/:code' } }),
        getResponse: () => ({ setHeader: jest.fn() })
      })
    } as any;
    const results: Array<number | 'ok'> = [];
    for (let i = 0; i < 31; i++) results.push(await statusOf(guard.canActivate(ctx)));
    expect(results.slice(0, 30).every((r) => r === 'ok')).toBe(true);
    expect(results[30]).toBe(429);
  });

  test('POST certificates/generate has CsrfGuard and registrationId must be a UUID', async () => {
    expect(guardsOf(CertificatesController.prototype.generateCertificate)).toContain(CsrfGuard);
    const dto = (registrationId: string) =>
      plainToInstance(GenerateCertificateDto, { registrationId, recipientName: 'A', teamName: 'B', achievementTitle: 'C' });
    expect(await validate(dto(crypto.randomUUID()))).toHaveLength(0);
    for (const bad of ['reg-1', "1' OR '1'='1", '']) {
      expect((await validate(dto(bad))).map((e) => e.property)).toContain('registrationId');
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe('Finding 6: signed-URL tokens never reach logs; request IDs are validated', () => {
  test('redactUrl hides token, expires, code, p and s values and keeps the rest', () => {
    const out = redactUrl('/api/uploads/files/k.pdf?token=abc123&expires=1700000000&page=2&code=XYZ&p=1&s=sig&TOKEN=x');
    expect(out).not.toMatch(/abc123|1700000000|XYZ|=sig\b|TOKEN=x/);
    expect(out).toContain('page=2');
    expect(out).toContain('token=[REDACTED]');
    expect(out).toContain('expires=[REDACTED]');
    expect(redactUrl('/api/health')).toBe('/api/health');
    expect(redactUrl('/a?%74oken=enc')).toBe('/a?%74oken=[REDACTED]');
    expect(redactUrl('/x?' + 'a=1&'.repeat(2000)).length).toBeLessThanOrEqual(2048);
  });

  test('validClientRequestId accepts at most 64 chars of [A-Za-z0-9_-]', () => {
    expect(validClientRequestId('req_abc-123')).toBe('req_abc-123');
    expect(validClientRequestId('a'.repeat(64))).toBe('a'.repeat(64));
    for (const bad of ['a'.repeat(65), 'bad id', 'x\ninjected', '<script>', '', undefined, 42]) {
      expect(validClientRequestId(bad)).toBeNull();
    }
  });

  function runMiddleware(headers: Record<string, any>, originalUrl: string) {
    const middleware = new RequestIdMiddleware();
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    (middleware as any).logger = logger;
    let finish: () => void = () => undefined;
    const req: any = { headers, method: 'GET', originalUrl, socket: { remoteAddress: '127.0.0.1' } };
    const res: any = { setHeader: jest.fn(), on: jest.fn((ev: string, cb: any) => ev === 'finish' && (finish = cb)), statusCode: 403 };
    middleware.use(req, res, jest.fn());
    finish();
    return { req, res, line: String(logger.warn.mock.calls[0][0]) };
  }

  test('the request log redacts the query string of signed URLs', () => {
    const { line } = runMiddleware({}, '/api/uploads/files/k.pdf?token=deadbeefcafe&expires=1799999999');
    expect(line).not.toContain('deadbeefcafe');
    expect(line).not.toContain('1799999999');
    expect(line).toContain('/api/uploads/files/k.pdf?token=[REDACTED]&expires=[REDACTED]');
  });

  test('a malformed client x-request-id is replaced; a valid one is kept', () => {
    const bad = runMiddleware({ 'x-request-id': 'x'.repeat(300) + '\n{"forged":1}' }, '/api/health');
    expect(bad.req.headers['x-request-id']).toMatch(/^req_[0-9a-f-]{36}$/);
    expect(bad.res.setHeader).toHaveBeenCalledWith('x-request-id', bad.req.headers['x-request-id']);
    expect(bad.line).not.toContain('forged');

    const good = runMiddleware({ 'x-request-id': 'client_id-42' }, '/api/health');
    expect(good.req.headers['x-request-id']).toBe('client_id-42');
  });

  test('the global exception filter echoes a redacted path and a validated request ID', () => {
    const filter = new GlobalExceptionFilter();
    (filter as any).logger = { error: jest.fn(), warn: jest.fn() };
    const json = jest.fn();
    const host: any = {
      switchToHttp: () => ({
        getResponse: () => ({ status: () => ({ json }) }),
        getRequest: () => ({ url: '/api/uploads/files/k.pdf?token=t0psecret&expires=1&p=2', headers: { 'x-request-id': 'bad id\r\n' } })
      })
    };
    filter.catch(new ForbiddenException('Invalid or expired signed URL for private asset'), host);
    const body = json.mock.calls[0][0];
    expect(body.path).toBe('/api/uploads/files/k.pdf?token=[REDACTED]&expires=[REDACTED]&p=[REDACTED]');
    expect(body.requestId).not.toContain('bad id');
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('Finding 7: refunds need step-up, are claimed atomically and are idempotent', () => {
  beforeEach(() => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_audit_key';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_test_audit_secret';
  });

  function refundPrisma(claimCount = 1) {
    const prisma: any = {
      payment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'pay-1',
          paymentId: 'pay_gw_1',
          amount: 11800,
          status: 'SUCCESS',
          registrationId: 'reg-1'
        }),
        updateMany: jest.fn().mockResolvedValue({ count: claimCount }),
        update: jest.fn().mockResolvedValue({ id: 'pay-1', status: 'REFUNDED', refundId: 'rfnd_1' })
      },
      registration: { update: jest.fn() }
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    return prisma;
  }

  test('POST payments/:id/refund requires StepUpGuard (and CSRF)', () => {
    const guards = guardsOf(PaymentsController.prototype.refundPayment);
    expect(guards).toContain(StepUpGuard);
    expect(guards).toContain(CsrfGuard);
  });

  test('a concurrent refund (claim count 0) answers 409 and never calls the gateway', async () => {
    const prisma = refundPrisma(0);
    const fetchMock = jest.spyOn(global, 'fetch' as any).mockResolvedValue({ ok: true, json: async () => ({}) } as any);
    const svc = new PaymentsService(prisma, {} as any, { logAction: jest.fn() } as any);
    await expect(svc.processRefund('pay-1', 'Duplicate click', 'admin-1')).rejects.toThrow(ConflictException);
    expect(fetchMock).not.toHaveBeenCalled();
    const claim = prisma.payment.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual(expect.objectContaining({ id: 'pay-1', status: 'SUCCESS' }));
    expect(claim.data).toEqual(expect.objectContaining({ refundStatus: 'PENDING' }));
  });

  test('the gateway call carries an idempotency key and runs only after the claim', async () => {
    const prisma = refundPrisma(1);
    const fetchMock = jest
      .spyOn(global, 'fetch' as any)
      .mockResolvedValue({ ok: true, json: async () => ({ id: 'rfnd_1', status: 'processed' }) } as any);
    const svc = new PaymentsService(prisma, {} as any, { logAction: jest.fn() } as any);
    await svc.processRefund('pay-1', 'Team withdrawal', 'admin-1');
    expect(prisma.payment.updateMany.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
    const [, init] = fetchMock.mock.calls[0] as any[];
    expect(init.headers['X-Idempotency-Key']).toBe('refund_pay-1');
    expect(JSON.parse(init.body).receipt).toBe('refund_pay-1');
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REFUNDED' }) })
    );
  });

  test('a gateway failure releases the claim (FAILED) so the refund can be retried', async () => {
    const prisma = refundPrisma(1);
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' } as any);
    const svc = new PaymentsService(prisma, {} as any, { logAction: jest.fn() } as any);
    (svc as any).logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
    await expect(svc.processRefund('pay-1', 'x', 'admin-1')).rejects.toThrow(BadGatewayException);
    expect(prisma.payment.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'pay-1', status: 'SUCCESS', refundStatus: 'PENDING' },
      data: { refundStatus: 'FAILED' }
    });
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  test('refund reason is capped at 500 characters; document feedback is capped too', async () => {
    expect(await validate(plainToInstance(RefundPaymentDto, { reason: 'x'.repeat(500) }))).toHaveLength(0);
    expect(await validate(plainToInstance(RefundPaymentDto, { reason: 'x'.repeat(501) }))).not.toHaveLength(0);
    expect(await validate(plainToInstance(VerifyDocumentDto, { status: 'VERIFIED', feedback: 'ok' }))).toHaveLength(0);
    expect(
      await validate(plainToInstance(VerifyDocumentDto, { status: 'VERIFIED', feedback: 'x'.repeat(1001) }))
    ).not.toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('Finding 8: payment edge cases', () => {
  function successPrisma(payment: any, otherSuccess: any = null) {
    const prisma: any = {
      payment: {
        findUnique: jest.fn().mockResolvedValue(payment),
        findFirst: jest.fn().mockResolvedValue(otherSuccess),
        update: jest.fn(async ({ data }: any) => ({ ...payment, ...data }))
      },
      registration: { update: jest.fn() },
      processedWebhookEvent: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() }
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    return prisma;
  }
  const basePayment = (overrides: any = {}) => ({
    id: 'pay-1',
    orderId: 'order_1',
    amount: 100,
    currency: 'INR',
    status: 'PENDING',
    registrationId: 'reg-1',
    registration: { id: 'reg-1', status: 'PAYMENT_PENDING' },
    ...overrides
  });

  test('processPaymentSuccess never overwrites a REFUNDED payment', async () => {
    const prisma = successPrisma(basePayment({ status: 'REFUNDED' }));
    const svc = new PaymentsService(prisma, {} as any, { logAction: jest.fn() } as any);
    (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
    const result = await (svc as any).processPaymentSuccess('order_1', 'pay_gw', 'sig', 'recon_x');
    expect(result.status).toBe('REFUNDED');
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.registration.update).not.toHaveBeenCalled();
  });

  test.each(['WITHDRAWN', 'CANCELLED', 'REJECTED'])(
    'a capture for a %s registration raises the manual-refund alert and leaves the registration alone',
    async (status) => {
      const prisma = successPrisma(basePayment({ registration: { id: 'reg-1', status } }));
      const alerts = { alert: jest.fn().mockResolvedValue(true) };
      const svc = new PaymentsService(prisma, {} as any, { logAction: jest.fn() } as any, alerts as any);
      (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
      await (svc as any).processPaymentSuccess('order_1', 'pay_gw', 'sig', 'sig_pay_gw');
      expect(alerts.alert).toHaveBeenCalledWith(
        'PAYMENT_REQUIRES_MANUAL_REFUND',
        'order_1',
        expect.objectContaining({ reason: `REGISTRATION_${status}`, registrationId: 'reg-1' })
      );
      expect(prisma.registration.update).not.toHaveBeenCalled();
      expect(prisma.payment.update).toHaveBeenCalled(); // the capture itself is recorded
    }
  );

  test('a second capture for an already paid registration raises the alert (webhook path)', async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_audit_test_value';
    const prisma = successPrisma(basePayment({ registration: { id: 'reg-1', status: 'PAYMENT_VERIFIED' } }), { id: 'pay-0' });
    const alerts = { alert: jest.fn().mockResolvedValue(true), recordWebhookSignatureFailure: jest.fn() };
    const svc = new PaymentsService(prisma, {} as any, { logAction: jest.fn() } as any, alerts as any);
    (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
    const body = Buffer.from(
      JSON.stringify({
        id: 'evt_1',
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_gw_2',
              order_id: 'order_1',
              amount: 10000,
              currency: 'INR',
              status: 'captured',
              email: 'payer@example.test',
              contact: '+919999999999',
              vpa: 'payer@upi',
              card: { last4: '4242' }
            }
          }
        }
      })
    );
    const sig = crypto.createHmac('sha256', 'whsec_audit_test_value').update(body).digest('hex');
    await svc.handleWebhook(body, sig, 'evt_1');

    expect(alerts.alert).toHaveBeenCalledWith(
      'PAYMENT_REQUIRES_MANUAL_REFUND',
      'order_1',
      expect.objectContaining({ reason: 'DUPLICATE_PAYMENT' })
    );
    expect(prisma.registration.update).not.toHaveBeenCalled();

    // Minimal webhook snapshot: no payer email, phone, VPA or card data
    const snapshot = prisma.processedWebhookEvent.create.mock.calls[0][0].data.payloadSnapshot;
    expect(snapshot).toEqual({
      eventId: 'evt_1',
      eventType: 'payment.captured',
      orderId: 'order_1',
      paymentId: 'pay_gw_2',
      amount: 10000,
      currency: 'INR',
      status: 'captured'
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/payer|9999|upi|4242/);
  });

  test('minimalWebhookSnapshot keeps only identifiers, amount, currency and status', () => {
    const snap = minimalWebhookSnapshot('e', 'order.paid', undefined, { id: 'order_9', amount: 5, currency: 'INR', status: 'paid', notes: { x: 1 } });
    expect(Object.keys(snap).sort()).toEqual(['amount', 'currency', 'eventId', 'eventType', 'orderId', 'paymentId', 'status']);
    expect(snap.orderId).toBe('order_9');
  });

  test("Razorpay's raw error body is logged server-side, never echoed in the 502", async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_audit_key';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_test_audit_secret';
    const svc = new PaymentsService({} as any, {} as any, { logAction: jest.fn() } as any);
    const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
    (svc as any).logger = logger;

    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":{"description":"merchant acct_SECRET123 payer leak@example.test"}}'
    } as any);
    const err: any = await (svc as any).callRazorpay('/payments/pay_1').catch((e: any) => e);
    expect(err).toBeInstanceOf(BadGatewayException);
    expect(JSON.stringify(err.getResponse())).not.toMatch(/acct_SECRET123|leak@example/);
    expect(logger.error.mock.calls[0][0]).toContain('acct_SECRET123');

    (global.fetch as any).mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:443'));
    const err2: any = await (svc as any).callRazorpay('/orders').catch((e: any) => e);
    expect(err2).toBeInstanceOf(BadGatewayException);
    expect(JSON.stringify(err2.getResponse())).not.toContain('10.0.0.5');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('Finding 9: one team per captain (unique index + 409)', () => {
  test('a unique-index violation on captainId is answered with 409', async () => {
    const prisma: any = {
      team: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: '5.14.0',
            meta: { target: ['captainId'] }
          })
        )
      },
      category: { findUnique: jest.fn().mockResolvedValue({ id: 'cat-1', isActive: true, maxTeamSize: 7 }) },
      user: { findUnique: jest.fn().mockResolvedValue({ fullName: 'Cap', email: 'cap@example.test', phone: '' }) },
      mediaAsset: { findFirst: jest.fn() },
      $executeRawUnsafe: jest.fn().mockRejectedValue(new Error('no sequences')),
      $queryRawUnsafe: jest.fn()
    };
    const svc = new TeamsService(prisma);
    const err = await svc.createTeam('cap-1', { categoryId: 'cat-1', teamName: 'Second' }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe(CAPTAIN_TEAM_EXISTS_MESSAGE);
  });

  test('the migration creates a unique index on teams.captainId', () => {
    const dir = path.join(ROOT, 'apps', 'api', 'prisma', 'migrations', '20261016000000_team_one_per_captain');
    const sql = fs.readFileSync(path.join(dir, 'migration.sql'), 'utf-8');
    expect(sql).toMatch(/CREATE UNIQUE INDEX[^;]*"teams"\s*\(\s*"captainId"\s*\)/);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('Finding 10: inactive categories accept no registrations or payments', () => {
  test('createRegistration refuses an inactive category', async () => {
    const prisma: any = {
      team: { findUnique: jest.fn().mockResolvedValue({ id: 't1', captainId: 'c1', categoryId: 'cat-1', captain: {} }) },
      category: { findUnique: jest.fn().mockResolvedValue({ id: 'cat-1', isActive: false, entryFee: 100, name: 'D40' }) },
      registration: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() }
    };
    const svc = new RegistrationsService(prisma, { logAction: jest.fn() } as any);
    await expect(svc.createRegistration('t1', 'cat-1', 'c1', UserRole.TEAM_CAPTAIN)).rejects.toThrow(
      'The selected competition category is not open for registration.'
    );
    expect(prisma.registration.create).not.toHaveBeenCalled();
  });

  test('createOrder refuses an inactive category before calling the gateway', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_audit_key';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_test_audit_secret';
    const fetchMock = jest.spyOn(global, 'fetch' as any);
    const prisma: any = {
      registration: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'reg-1',
          status: 'PAYMENT_PENDING',
          category: { isActive: false, entryFee: 100, name: 'D40' },
          team: { captainId: 'c1', name: 'T', code: 'C' }
        })
      },
      payment: { findFirst: jest.fn().mockResolvedValue(null) }
    };
    const svc = new PaymentsService(prisma, {} as any, { logAction: jest.fn() } as any);
    await expect(svc.createOrder({ registrationId: 'reg-1' }, 'c1')).rejects.toThrow(BadRequestException);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------
describe('Finding 11: registration state machine', () => {
  test('PAYMENT_VERIFIED may move to ADMINISTRATIVE_REVIEW and REJECTED', () => {
    expect(canTransitionRegistration(RegistrationStatus.PAYMENT_VERIFIED, RegistrationStatus.ADMINISTRATIVE_REVIEW)).toBe(true);
    expect(canTransitionRegistration(RegistrationStatus.PAYMENT_VERIFIED, RegistrationStatus.REJECTED)).toBe(true);
  });

  test('the admin console table mirrors the shared table exactly', () => {
    expect(REGISTRATION_TRANSITIONS).toEqual(ALLOWED_REGISTRATION_TRANSITIONS);
  });

  test('captains reach TECHNICAL_SUBMISSION only after staff moved past PAYMENT_VERIFIED', () => {
    const can = (from?: RegistrationStatus) =>
      isRoleAuthorizedForTransition(UserRole.TEAM_CAPTAIN, RegistrationStatus.TECHNICAL_SUBMISSION, from);
    expect(can(RegistrationStatus.PAYMENT_VERIFIED)).toBe(false);
    expect(can(undefined)).toBe(false);
    expect(can(RegistrationStatus.DOCUMENT_REVIEW)).toBe(true);
    expect(can(RegistrationStatus.REQUIRES_ACTION)).toBe(true);
    // Staff keep the direct edge
    expect(
      isRoleAuthorizedForTransition(UserRole.EVENT_ADMIN, RegistrationStatus.TECHNICAL_SUBMISSION, RegistrationStatus.PAYMENT_VERIFIED)
    ).toBe(true);
  });

  test('transitionStatus refuses a captain moving PAYMENT_VERIFIED -> TECHNICAL_SUBMISSION (403)', async () => {
    const prisma: any = {
      registration: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'reg-1',
          status: RegistrationStatus.PAYMENT_VERIFIED,
          team: { captainId: 'c1' },
          payments: [{ status: 'SUCCESS' }],
          documents: [{ status: 'VERIFIED' }]
        }),
        update: jest.fn()
      },
      $executeRaw: jest.fn().mockResolvedValue(1)
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    const svc = new RegistrationsService(prisma, { logAction: jest.fn() } as any);
    await expect(
      svc.transitionStatus('reg-1', RegistrationStatus.TECHNICAL_SUBMISSION as any, UserRole.TEAM_CAPTAIN, 'c1')
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.registration.update).not.toHaveBeenCalled();
  });

  describe('ADMINISTRATIVE_REVIEW -> DOCUMENT_REVIEW (post-payment review)', () => {
    const regPrisma = (payments: Array<{ status: string }>) => {
      const prisma: any = {
        registration: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'reg-2',
            status: RegistrationStatus.ADMINISTRATIVE_REVIEW,
            team: { captainId: 'c1' },
            payments,
            documents: []
          }),
          update: jest.fn().mockResolvedValue({ id: 'reg-2', status: RegistrationStatus.DOCUMENT_REVIEW, team: {}, category: {} })
        },
        $executeRaw: jest.fn().mockResolvedValue(1)
      };
      prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
      return prisma;
    };

    test('the edge exists in the shared table', () => {
      expect(canTransitionRegistration(RegistrationStatus.ADMINISTRATIVE_REVIEW, RegistrationStatus.DOCUMENT_REVIEW)).toBe(true);
    });

    test('refused for an unpaid entry, so payment cannot be skipped', async () => {
      const prisma = regPrisma([{ status: 'FAILED' }]);
      const svc = new RegistrationsService(prisma, { logAction: jest.fn() } as any);
      await expect(
        svc.transitionStatus('reg-2', RegistrationStatus.DOCUMENT_REVIEW as any, UserRole.EVENT_ADMIN, 'a1')
      ).rejects.toThrow(/has not been paid/);
      expect(prisma.registration.update).not.toHaveBeenCalled();
    });

    test('allowed for staff once the entry has a successful payment', async () => {
      const prisma = regPrisma([{ status: 'SUCCESS' }]);
      const svc = new RegistrationsService(prisma, { logAction: jest.fn() } as any);
      await svc.transitionStatus('reg-2', RegistrationStatus.DOCUMENT_REVIEW as any, UserRole.EVENT_ADMIN, 'a1');
      expect(prisma.registration.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: RegistrationStatus.DOCUMENT_REVIEW }) })
      );
    });
  });
});

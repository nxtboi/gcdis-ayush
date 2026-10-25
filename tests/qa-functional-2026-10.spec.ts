/**
 * Functional QA pass, October 2026: regression tests for the bugs fixed during the full walkthrough of the
 * public site, team portal and staff console.
 */
import * as fs from 'fs';
import * as path from 'path';
import { RegistrationStatus, UserRole, canTransitionRegistration } from '@gcdis/shared';
import { RegistrationsService } from '../apps/api/src/registrations/registrations.service';
import { buildTeamJourney } from '../apps/web/src/app/portal/_components/team-journey';
import { formatFee } from '../apps/web/src/app/portal/_components/categories';

const rootDir = path.join(__dirname, '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(rootDir, ...parts), 'utf-8');

describe('Paid-only review: no path into DOCUMENT_REVIEW skips the entry fee', () => {
  const regPrisma = (status: RegistrationStatus, payments: Array<{ status: string }>, entryFee = 1500) => {
    const prisma: any = {
      registration: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'reg-9',
          status,
          team: { captainId: 'c1' },
          category: { entryFee },
          payments,
          documents: []
        }),
        update: jest.fn().mockResolvedValue({ id: 'reg-9', status: RegistrationStatus.DOCUMENT_REVIEW, team: {}, category: {} })
      },
      $executeRaw: jest.fn().mockResolvedValue(1)
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    return prisma;
  };

  test('PAYMENT_PENDING -> REQUIRES_ACTION -> DOCUMENT_REVIEW is a path in the shared table', () => {
    expect(canTransitionRegistration(RegistrationStatus.PAYMENT_PENDING as any, RegistrationStatus.REQUIRES_ACTION as any)).toBe(true);
    expect(canTransitionRegistration(RegistrationStatus.REQUIRES_ACTION as any, RegistrationStatus.DOCUMENT_REVIEW as any)).toBe(true);
  });

  test('REQUIRES_ACTION -> DOCUMENT_REVIEW is refused for an unpaid entry', async () => {
    const prisma = regPrisma(RegistrationStatus.REQUIRES_ACTION, [{ status: 'PENDING' }]);
    const svc = new RegistrationsService(prisma, { logAction: jest.fn() } as any);
    await expect(
      svc.transitionStatus('reg-9', RegistrationStatus.DOCUMENT_REVIEW as any, UserRole.EVENT_ADMIN, 'a1')
    ).rejects.toThrow(/has not been paid\. Move the registration to SUBMITTED, then through ADMINISTRATIVE_REVIEW to PAYMENT_PENDING/);
    expect(prisma.registration.update).not.toHaveBeenCalled();
  });

  test('REQUIRES_ACTION -> DOCUMENT_REVIEW is allowed once the entry has a successful payment', async () => {
    const prisma = regPrisma(RegistrationStatus.REQUIRES_ACTION, [{ status: 'SUCCESS' }]);
    const svc = new RegistrationsService(prisma, { logAction: jest.fn() } as any);
    await svc.transitionStatus('reg-9', RegistrationStatus.DOCUMENT_REVIEW as any, UserRole.EVENT_ADMIN, 'a1');
    expect(prisma.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: RegistrationStatus.DOCUMENT_REVIEW }) })
    );
  });

  test('a free category (entry fee 0) is not blocked, since there is nothing to pay', async () => {
    const prisma = regPrisma(RegistrationStatus.ADMINISTRATIVE_REVIEW, [], 0);
    const svc = new RegistrationsService(prisma, { logAction: jest.fn() } as any);
    await svc.transitionStatus('reg-9', RegistrationStatus.DOCUMENT_REVIEW as any, UserRole.EVENT_ADMIN, 'a1');
    expect(prisma.registration.update).toHaveBeenCalled();
  });
});

describe('Staff overview: Razorpay test keys do not count as live keys', () => {
  const { CMSService } = require('../apps/api/src/cms/cms.service');
  const original = process.env.RAZORPAY_KEY_ID;
  afterAll(() => {
    if (original === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = original;
  });

  const checklistFor = async (keyId: string) => {
    process.env.RAZORPAY_KEY_ID = keyId;
    const prisma: any = {
      siteSetting: { findMany: jest.fn().mockResolvedValue([]) },
      contentSection: { findUnique: jest.fn().mockResolvedValue({ key: 'hero' }) },
      event: { findMany: jest.fn().mockResolvedValue([{ venueName: 'Galgotias University' }]) }
    };
    const svc = Object.create(CMSService.prototype);
    svc.prisma = prisma;
    svc.getPrizes = jest.fn().mockResolvedValue({ unallocated: 0, poolTotal: 100000 });
    const result = await svc.getOperationalChecklist();
    return result.items.find((i: any) => i.id === 'gateway_credentials');
  };

  test('rzp_test_ keys are reported as test mode and the item stays incomplete', async () => {
    const item = await checklistFor('rzp_test_abc123');
    expect(item.isComplete).toBe(false);
    expect(item.detail).toMatch(/Test-mode keys/);
    expect(item.detail).not.toMatch(/^Live keys are configured/);
  });

  test('rzp_live_ keys complete the item', async () => {
    const item = await checklistFor('rzp_live_abc123');
    expect(item.isComplete).toBe(true);
    expect(item.detail).toMatch(/Live keys are configured/);
  });
});

describe('Portal: the entry fee amount is shown with the Pay button', () => {
  test('formatFee renders GST-inclusive rupee amounts for D20 and D40', () => {
    expect(formatFee(1500, 'INR')).toBe('₹1,500');
    expect(formatFee(3500, 'INR')).toBe('₹3,500');
    expect(formatFee(0, 'INR')).toBe('Fee announced later');
  });

  test('the Overview Pay card renders the category fee beside "Pay entry fee"', () => {
    const overview = read('apps', 'web', 'src', 'app', 'portal', '_components', 'OverviewTab.tsx');
    expect(overview).toContain("import { formatFee, type CategoriesState } from './categories';");
    expect(overview).toMatch(/categoriesState\.categories\.find\(\(c\) => c\.id === teamInfo\.categoryId\)/);
    expect(overview).toContain('{entryFeeLabel} (incl. GST)');
  });

  test('the wizard and the Overview share one fee formatter', () => {
    const wizard = read('apps', 'web', 'src', 'app', 'portal', '_components', 'WizardParts.tsx');
    expect(wizard).not.toMatch(/function formatFee\(/);
    expect(wizard).toContain("import { formatFee, type CategoriesState } from './categories';");
  });
});

describe('Portal: the journey tracker no longer says payment follows the administrative review', () => {
  test('payment is described as requested on submission', () => {
    const steps = buildTeamJourney({
      teamSaved: true,
      emailVerified: true,
      memberCount: 5,
      submitted: false,
      status: 'NOT_SUBMITTED',
      isPaid: false
    });
    const payment = steps.find((s) => s.id === 'payment');
    expect(payment?.detail).toBe('Requested once the registration has been submitted.');
    expect(steps.map((s) => s.detail).join(' ')).not.toMatch(/after the administrative review/);
  });
});

describe('Audit log: FILE_UPLOAD rows name the uploader and carry the client IP', () => {
  const { UploadsController } = require('../apps/api/src/uploads/uploads.controller');

  test('both upload endpoints pass the actor email, IP and user agent to the service', async () => {
    const processUpload = jest.fn().mockResolvedValue({ id: 'asset-1' });
    const controller = new UploadsController({ processUpload } as any);
    const req = {
      user: { id: 'cap-1', email: 'captain@example.test', role: 'TEAM_CAPTAIN' },
      ip: '203.0.113.7',
      headers: { 'user-agent': 'Jest' }
    };
    await controller.uploadFile(req, { fileName: 'doc.pdf', base64Data: Buffer.from('%PDF-1.4').toString('base64') });
    await controller.uploadFileStream(req, { buffer: Buffer.from('%PDF-1.4'), originalname: 'doc.pdf' }, 'DOCUMENT');
    for (const call of processUpload.mock.calls) {
      expect(call[5]).toEqual({ actorEmail: 'captain@example.test', ipAddress: '203.0.113.7', userAgent: 'Jest' });
    }
    expect(processUpload).toHaveBeenCalledTimes(2);
  });

  test('the service writes the context into the audit entry', () => {
    const code = read('apps', 'api', 'src', 'uploads', 'uploads.service.ts');
    const audit = code.slice(code.indexOf("action: 'FILE_UPLOAD'") - 200, code.indexOf("action: 'FILE_UPLOAD'") + 500);
    expect(audit).toContain('actorEmail: auditContext.actorEmail');
    expect(audit).toContain('ipAddress: auditContext.ipAddress');
    expect(audit).toContain('userAgent: auditContext.userAgent');
  });
});

describe('Portal: registration completeness hint for a saved but unsubmitted team', () => {
  test('asks the captain to submit rather than to fill in the form again', () => {
    const overview = read('apps', 'web', 'src', 'app', 'portal', '_components', 'OverviewTab.tsx');
    expect(overview).toContain("'Your team is saved. Submit the registration above to continue.'");
  });
});

describe('Auth follow-ups from the functional QA run', () => {
  const read = (p: string) => require('fs').readFileSync(require('path').join(__dirname, '..', p), 'utf8');

  test('successful password sign-ins (with and without 2FA) are written to the audit log', () => {
    const svc = read('apps/api/src/auth/auth.service.ts');
    expect(svc).toContain("| 'AUTH_LOGIN_SUCCESS'");
    expect(svc).toContain("this.auditAuthEvent('AUTH_LOGIN_SUCCESS', user, ipAddress, userAgent, { method: 'password' })");
    expect(svc).toContain("this.auditAuthEvent('AUTH_LOGIN_SUCCESS', user, ipAddress, userAgent, { method: 'password+2fa' })");
  });

  test('registration reports whether the verification email was actually sent, and the portal uses it', () => {
    const ctrl = read('apps/api/src/auth/auth.controller.ts');
    expect(ctrl).toContain('verificationEmailSent = await this.accountRecovery.sendVerificationEmail(result.user as any).catch(() => false);');
    expect(ctrl).toMatch(/message: 'Registration successful',\s+verificationEmailSent/);
    const portal = read('apps/web/src/app/portal/page.tsx');
    expect(portal).toContain('setVerificationJustSent(registered?.verificationEmailSent !== false);');
  });
});

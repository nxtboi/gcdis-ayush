import 'reflect-metadata';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import {
  SecurityAlertService,
  securityAlertConfigErrors,
  securityWebhookUrl
} from '../apps/api/src/security/security-alert.service';
import { MailService, mailConfigErrors } from '../apps/api/src/mail/mail.service';
import { escapeHtml, verificationEmail } from '../apps/api/src/mail/mail.templates';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { TwoFactorService } from '../apps/api/src/auth/two-factor.service';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { AccountIpRateLimiterGuard } from '../apps/api/src/common/guards/rate-limiter.guard';

describe('SecurityAlertService', () => {
  const env = { ...process.env };
  const realFetch = (globalThis as any).fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    SecurityAlertService.reset();
    process.env.SECURITY_ALERT_WEBHOOK_URL = 'https://hooks.example.test/T000/B000';
    delete process.env.SECURITY_ALERT_EMAIL;
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    (globalThis as any).fetch = fetchMock;
  });
  afterEach(() => {
    (globalThis as any).fetch = realFetch;
    process.env = { ...env };
  });

  test('posts a Slack/Discord compatible JSON body with "text"', async () => {
    const svc = new SecurityAlertService();
    await expect(svc.alert('ACCOUNT_LOCKOUT', 'cap@example.org', { ipAddress: '203.0.113.5' })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.example.test/T000/B000');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.text).toContain('Account temporarily locked');
    expect(body.text).toContain('cap@example.org');
    expect(body.text).toContain('203.0.113.5');
  });

  test('deduplicates the same event + subject for 10 minutes; other subjects still alert', async () => {
    const svc = new SecurityAlertService();
    await svc.alert('STEP_UP_LOCKED', 'admin@example.org');
    await expect(svc.alert('STEP_UP_LOCKED', 'admin@example.org')).resolves.toBe(false);
    await svc.alert('STEP_UP_LOCKED', 'other@example.org');
    await svc.alert('ADMIN_IP_DENIED', 'admin@example.org');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('never throws: webhook failure, timeout-like rejection or missing config', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const svc = new SecurityAlertService();
    await expect(svc.alert('REFRESH_TOKEN_REPLAY', 'u1')).resolves.toBe(true);
    delete process.env.SECURITY_ALERT_WEBHOOK_URL;
    await expect(svc.alert('REFRESH_TOKEN_REPLAY', 'u2')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('emails SECURITY_ALERT_EMAIL through MailService', async () => {
    process.env.SECURITY_ALERT_EMAIL = 'security@example.org';
    const mail = { sendSafe: jest.fn().mockResolvedValue(true) } as any;
    const svc = new SecurityAlertService(mail);
    await svc.alert('UPLOAD_MALWARE_BLOCKED', 'abc123', { signature: 'Eicar-Test-Signature' });
    expect(mail.sendSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'security@example.org',
        subject: expect.stringMatching(/^GCDIS security alert: /),
        text: expect.stringContaining('Eicar-Test-Signature')
      })
    );
  });

  test('https required in production (http allowed only outside production)', () => {
    expect(securityWebhookUrl({ SECURITY_ALERT_WEBHOOK_URL: 'http://localhost:9000/hook' } as any)).toBe('http://localhost:9000/hook');
    expect(securityWebhookUrl({ NODE_ENV: 'production', SECURITY_ALERT_WEBHOOK_URL: 'http://x.example/hook' } as any)).toBeNull();
    expect(securityAlertConfigErrors({ NODE_ENV: 'production', SECURITY_ALERT_WEBHOOK_URL: 'http://x.example/hook' } as any)).toHaveLength(1);
    expect(securityAlertConfigErrors({ NODE_ENV: 'production', SECURITY_ALERT_WEBHOOK_URL: '' } as any)).toHaveLength(0);
  });

  test('payment webhook signature failures alert at 3 within 10 minutes', async () => {
    const svc = new SecurityAlertService();
    const spy = jest.spyOn(svc, 'alert');
    svc.recordWebhookSignatureFailure('198.51.100.1');
    svc.recordWebhookSignatureFailure('198.51.100.1');
    expect(spy).not.toHaveBeenCalled();
    svc.recordWebhookSignatureFailure('198.51.100.2');
    expect(spy).toHaveBeenCalledWith('PAYMENT_WEBHOOK_SIGNATURE_FAILURES', 'razorpay-webhook', expect.objectContaining({ failuresInLast10Minutes: 3 }));
  });
});

describe('Alert triggers', () => {
  const env = { ...process.env };
  let alerts: any;
  beforeEach(() => {
    alerts = { alert: jest.fn().mockResolvedValue(true), recordWebhookSignatureFailure: jest.fn() };
  });
  afterEach(() => {
    process.env = { ...env };
  });

  function authWith(prisma: any, twoFactor = new TwoFactorService()) {
    return new AuthService(prisma, new JwtService({ secret: 'r3_alert_trigger_secret_0123456789abcdefgh' }), twoFactor, undefined, alerts);
  }

  test('account lockout: the 5th failed sign-in raises ACCOUNT_LOCKOUT', async () => {
    const hash = await bcrypt.hash('Right-Password-2026', 4);
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'c1', email: 'cap@example.org', role: 'TEAM_CAPTAIN', isActive: true, passwordHash: hash }) },
      loginAttempt: { count: jest.fn().mockResolvedValue(3), create: jest.fn() }
    };
    const svc = authWith(prisma);
    await expect(svc.login({ email: 'cap@example.org', password: 'Wrong-Password-2026' } as any, '203.0.113.7')).rejects.toThrow();
    expect(alerts.alert).not.toHaveBeenCalled();
    prisma.loginAttempt.count.mockResolvedValue(4);
    await expect(svc.login({ email: 'cap@example.org', password: 'Wrong-Password-2026' } as any, '203.0.113.7')).rejects.toThrow();
    expect(alerts.alert).toHaveBeenCalledWith('ACCOUNT_LOCKOUT', 'cap@example.org', expect.objectContaining({ ipAddress: '203.0.113.7' }));
  });

  test('refresh-token replay alerts only when the token had been rotated', async () => {
    const revoked = { id: 's1', userId: 'u1', familyId: 'f1', revokedAt: new Date(Date.now() - 60_000), isActive: false, user: { email: 'a@example.org', role: 'SUPER_ADMIN' } };
    const prisma: any = {
      session: {
        findUnique: jest.fn().mockResolvedValue(revoked),
        findFirst: jest.fn().mockResolvedValue({ id: 's2' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };
    const svc = authWith(prisma);
    await expect(svc.rotateSession('stolen-token', '198.51.100.9')).rejects.toThrow(/reuse detected/);
    expect(alerts.alert).toHaveBeenCalledWith('REFRESH_TOKEN_REPLAY', 'a@example.org', expect.objectContaining({ familyId: 'f1' }));

    // a token of a signed-out / reset session (no successor) is stale, not a replay
    alerts.alert.mockClear();
    prisma.session.findFirst.mockResolvedValue(null);
    await expect(svc.rotateSession('stale-token', '198.51.100.9')).rejects.toThrow();
    expect(alerts.alert).not.toHaveBeenCalled();
  });

  test('step-up lock (5 failures) raises STEP_UP_LOCKED once', async () => {
    const twoFactor = new TwoFactorService();
    const secret = twoFactor.generateBase32Secret();
    const user = {
      id: `step-${crypto.randomUUID()}`,
      email: 'admin@example.org',
      role: 'SUPER_ADMIN',
      isActive: true,
      isTwoFactorEnabled: true,
      twoFactor: { isEnabled: true, secret: twoFactor.encryptSecret(secret), lastUsedStep: null, backupCodes: [] }
    };
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      twoFactor: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      auditLog: { create: jest.fn() }
    };
    const svc = authWith(prisma, twoFactor);
    for (let i = 0; i < 5; i++) {
      await expect(svc.stepUp({ id: user.id, sid: 's1' }, '000000', '10.0.0.1')).rejects.toThrow();
    }
    expect(alerts.alert).toHaveBeenCalledTimes(1);
    expect(alerts.alert).toHaveBeenCalledWith('STEP_UP_LOCKED', 'admin@example.org', expect.any(Object));
    const locked: any = await svc.stepUp({ id: user.id, sid: 's1' }, '000000').catch((e) => e);
    expect(locked).toBeInstanceOf(HttpException);
    expect(alerts.alert).toHaveBeenCalledTimes(1);
    twoFactor.clearUserAttempts(user.id);
  });

  test('admin IP denied and staff sign-in from a new network / device raise alerts', async () => {
    const staff = { id: 'a1', email: 'admin@example.org', role: 'SUPER_ADMIN', isActive: true, isTwoFactorEnabled: true, mustChangePassword: false, fullName: 'Admin' };
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue(staff) },
      session: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn() }
    };
    const svc = authWith(prisma);
    // Admin hardening: the earlier exact-IP STAFF_NEW_IP_SIGN_IN alert became STAFF_NEW_DEVICE_LOGIN (/24 network or browser family)
    await (svc as any).createSession('a1', '203.0.113.50', 'jest');
    expect(alerts.alert).toHaveBeenCalledWith(
      'STAFF_NEW_DEVICE_LOGIN',
      'admin@example.org|203.0.113.0/24|Other on Other',
      expect.objectContaining({ ipAddress: '203.0.113.50', newNetwork: true })
    );
    expect(prisma.session.findMany.mock.calls[0][0].where).toMatchObject({ userId: 'a1' });

    // known network and browser -> no alert; refresh rotation never checks
    alerts.alert.mockClear();
    prisma.session.findMany.mockResolvedValue([{ ipAddress: '203.0.113.7', userAgent: 'jest' }]);
    await (svc as any).createSession('a1', '203.0.113.50', 'jest');
    prisma.session.findMany.mockResolvedValue([]);
    await (svc as any).createSession('a1', '198.51.100.99', 'jest', 'fam', { rotated: true });
    expect(alerts.alert).not.toHaveBeenCalled();

    process.env.ADMIN_IP_ALLOWLIST = '10.0.0.0/8';
    await expect((svc as any).createSession('a1', '203.0.113.50', 'jest')).rejects.toThrow(/not permitted/);
    expect(alerts.alert).toHaveBeenCalledWith('ADMIN_IP_DENIED', 'admin@example.org', expect.objectContaining({ ipAddress: '203.0.113.50' }));
  });

  test('invalid payment webhook signatures are counted', async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = 'r3_webhook_secret_value';
    const payments = new PaymentsService({} as any, {} as any, { logAction: jest.fn() } as any, alerts);
    await expect(payments.handleWebhook(Buffer.from('{}'), 'deadbeef', 'evt_1', '198.51.100.4')).rejects.toThrow('Invalid webhook signature');
    await expect(payments.handleWebhook(Buffer.from('{}'), '', 'evt_2', '198.51.100.4')).rejects.toThrow('Missing webhook signature');
    expect(alerts.recordWebhookSignatureFailure).toHaveBeenCalledTimes(2);
    expect(alerts.recordWebhookSignatureFailure).toHaveBeenCalledWith('198.51.100.4');
  });
});

describe('MailService', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  test('production requires SMTP_HOST and MAIL_FROM', () => {
    expect(mailConfigErrors({ NODE_ENV: 'production' } as any)).toHaveLength(2);
    expect(mailConfigErrors({ NODE_ENV: 'production', SMTP_HOST: 'smtp.example.org', MAIL_FROM: 'GCDIS <no-reply@example.org>' } as any)).toEqual([]);
    expect(mailConfigErrors({ NODE_ENV: 'development' } as any)).toEqual([]);
  });

  test('without SMTP outside production, messages go to the outbox directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcdis-outbox-'));
    process.env.MAIL_OUTBOX_DIR = dir;
    process.env.SMTP_HOST = '';
    const mail = new MailService();
    await mail.send({ to: 'cap@example.org', ...verificationEmail('Cap <b>Tain</b>', 'http://localhost:3000/portal/verify-email?token=abc') });
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    const eml = fs.readFileSync(path.join(dir, files[0]), 'utf-8');
    expect(eml).toContain('To: cap@example.org');
    expect(eml).toContain('Subject: GCDIS: Please confirm your email address');
    expect(eml).toContain('Cap &lt;b&gt;Tain&lt;/b&gt;');
    expect(eml).not.toContain('\r');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('refuses header injection and production sends without SMTP; sendSafe never throws', async () => {
    const mail = new MailService();
    await expect(mail.send({ to: 'a@example.org\r\nBcc: x@example.org', subject: 's', text: 't', html: 'h' })).rejects.toThrow();
    process.env.NODE_ENV = 'production';
    process.env.SMTP_HOST = '';
    await expect(mail.send({ to: 'a@example.org', subject: 's', text: 't', html: 'h' })).rejects.toThrow(/SMTP is not configured/);
    await expect(mail.sendSafe({ to: 'a@example.org', subject: 's', text: 't', html: 'h' })).resolves.toBe(false);
  });

  test('escapeHtml', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});

describe('Rate limiter ipPoints (per-IP limit next to the per-account limit)', () => {
  test('forgot-password style rule: 3 per account+IP and 3 per IP across accounts', async () => {
    const rule = { points: 3, duration: 3600, isStrictAuth: true, ipPoints: 3 };
    const reflector: any = { getAllAndOverride: () => rule };
    const guard = new AccountIpRateLimiterGuard(reflector);
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 20}`;
    const ctx = (email: string) =>
      ({
        getHandler: () => null,
        getClass: () => null,
        switchToHttp: () => ({
          getRequest: () => ({ ip, body: { email }, route: { path: '/api/auth/forgot-password-r3-test' } }),
          getResponse: () => ({ setHeader: jest.fn() })
        })
      }) as any;
    await expect(guard.canActivate(ctx('a@example.org'))).resolves.toBe(true);
    await expect(guard.canActivate(ctx('b@example.org'))).resolves.toBe(true);
    await expect(guard.canActivate(ctx('c@example.org'))).resolves.toBe(true);
    const err: any = await guard.canActivate(ctx('d@example.org')).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(429);
  });
});

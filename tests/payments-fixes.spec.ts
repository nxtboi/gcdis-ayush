import { BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PaymentStatus, RegistrationStatus } from '@prisma/client';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { PaymentsController } from '../apps/api/src/payments/payments.controller';

describe('Payments fixes: webhook event types, captured-only, raw body', () => {
  const webhookSecret = 'secure_webhook_secret_for_fix_tests_123';
  let mockPrisma: any;
  let mockAudit: any;
  let service: PaymentsService;
  const originalFetch = global.fetch;

  const sign = (raw: string) => crypto.createHmac('sha256', webhookSecret).update(Buffer.from(raw)).digest('hex');

  const pendingPayment = (status: PaymentStatus = PaymentStatus.PENDING) => ({
    id: 'p-1',
    orderId: 'order_123',
    paymentId: null,
    amount: 17700,
    currency: 'INR',
    status,
    registration: { id: 'reg-1', status: RegistrationStatus.PAYMENT_PENDING }
  });

  const webhookBody = (event: string, id: string) =>
    JSON.stringify({
      event,
      id,
      payload: {
        payment: {
          entity: { id: 'pay_123', order_id: 'order_123', amount: 1770000, currency: 'INR' }
        }
      }
    });

  beforeEach(() => {
    process.env.RAZORPAY_WEBHOOK_SECRET = webhookSecret;
    process.env.RAZORPAY_KEY_ID = 'rzp_live_fixkey_123';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_live_fixsecret_456';

    mockPrisma = {
      processedWebhookEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn()
      },
      payment: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(async ({ data }: any) => ({ id: 'p-1', ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      registration: { update: jest.fn() },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(async (cb: any) => cb(mockPrisma))
    };
    mockAudit = { logAction: jest.fn() };
    service = new PaymentsService(mockPrisma, {} as any, mockAudit);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('1. Webhook honours the event type', () => {
    test('signed payment.failed with matching amount marks payment FAILED, never SUCCESS', async () => {
      const raw = webhookBody('payment.failed', 'evt_failed_1');
      mockPrisma.payment.findUnique.mockResolvedValue(pendingPayment());

      const res: any = await service.handleWebhook(raw, sign(raw), 'evt_failed_1');

      expect(res.status).toBe('payment_failed');
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: PaymentStatus.FAILED }) })
      );
      expect(mockPrisma.payment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: PaymentStatus.SUCCESS }) })
      );
      expect(mockPrisma.registration.update).not.toHaveBeenCalled();
      expect(mockPrisma.processedWebhookEvent.create).toHaveBeenCalled();
    });

    test('payment.failed does not regress an already SUCCESS payment', async () => {
      const raw = webhookBody('payment.failed', 'evt_failed_2');
      mockPrisma.payment.findUnique.mockResolvedValue(pendingPayment(PaymentStatus.SUCCESS));

      const res: any = await service.handleWebhook(raw, sign(raw), 'evt_failed_2');

      expect(res.status).toBe('already_success');
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    });

    test('payment.authorized (and other events) are recorded and acknowledged without state change', async () => {
      for (const evt of ['payment.authorized', 'refund.created', 'payment.dispute.created']) {
        const raw = webhookBody(evt, `evt_${evt}`);
        mockPrisma.payment.findUnique.mockResolvedValue(pendingPayment());

        const res: any = await service.handleWebhook(raw, sign(raw), `evt_${evt}`);

        expect(res.status).toBe('ignored_event_type');
      }
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
      expect(mockPrisma.registration.update).not.toHaveBeenCalled();
      expect(mockPrisma.processedWebhookEvent.create).toHaveBeenCalledTimes(3);
    });

    test('order.paid marks payment SUCCESS and moves registration to PAYMENT_VERIFIED, audits via tx client', async () => {
      const raw = JSON.stringify({
        event: 'order.paid',
        id: 'evt_order_paid_1',
        payload: {
          order: { entity: { id: 'order_123', amount: 1770000, currency: 'INR' } },
          payment: { entity: { id: 'pay_123', order_id: 'order_123', amount: 1770000, currency: 'INR' } }
        }
      });
      mockPrisma.payment.findUnique.mockResolvedValue(pendingPayment());

      const res: any = await service.handleWebhook(raw, sign(raw), 'evt_order_paid_1');

      expect(res.status).toBe('ok');
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: PaymentStatus.SUCCESS }) })
      );
      expect(mockPrisma.registration.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: RegistrationStatus.PAYMENT_VERIFIED } })
      );
      // Audit rows are written through the transaction client, not the out-of-transaction service
      expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(2);
      expect(mockAudit.logAction).not.toHaveBeenCalled();
    });
  });

  describe('2. Only Razorpay "captured" counts as paid', () => {
    test('verifyPaymentSignature rejects an authorized-but-not-captured payment', async () => {
      const orderId = 'order_auth_1';
      const paymentId = 'pay_auth_1';
      const sig = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET as string)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');

      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'p-1',
        orderId,
        amount: 14160,
        registration: { id: 'reg-1', status: RegistrationStatus.PAYMENT_PENDING, team: { captainId: 'captain-a' } }
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: paymentId, order_id: orderId, status: 'authorized', amount: 1416000 })
      } as any);

      await expect(
        service.verifyPaymentSignature(
          { razorpayOrderId: orderId, razorpayPaymentId: paymentId, razorpaySignature: sig },
          'captain-a'
        )
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    });

    test('reconciliation does not mark an authorized-only order as SUCCESS', async () => {
      mockPrisma.payment.findMany.mockResolvedValue([
        {
          id: 'pay-stale-1',
          orderId: 'order_stale_1',
          amount: 11800,
          status: PaymentStatus.PENDING,
          createdAt: new Date(Date.now() - 20 * 60 * 1000)
        }
      ]);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ count: 1, items: [{ id: 'pay_auth', status: 'authorized', amount: 1180000 }] })
      } as any);

      const results: any = await service.reconcileStalePayments();

      expect(results.reconciled).toBe(0);
      expect(results.skipped).toBe(1);
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('3. Webhook raw body handling', () => {
    test('controller passes the exact raw bytes to the service (HMAC verifies on original formatting)', async () => {
      // Formatting that JSON.stringify(JSON.parse(raw)) would NOT reproduce
      const raw = '{ "event" : "payment.captured",\n  "id": "evt_raw_1", "payload": {} }';
      const handleWebhook = jest.fn().mockResolvedValue({ status: 'ok' });
      const controller = new PaymentsController({ handleWebhook } as any);

      await controller.handleWebhook({ rawBody: Buffer.from(raw), body: JSON.parse(raw) }, sign(raw), 'evt_raw_1');

      const passed: Buffer = handleWebhook.mock.calls[0][0];
      expect(Buffer.isBuffer(passed)).toBe(true);
      expect(passed.toString('utf-8')).toBe(raw);
    });

    test('controller rejects with 400 when no raw body is available (no JSON.stringify fallback)', async () => {
      const handleWebhook = jest.fn();
      const controller = new PaymentsController({ handleWebhook } as any);

      await expect(
        controller.handleWebhook({ body: { event: 'payment.captured', id: 'evt_x' } }, 'sig', 'evt_x')
      ).rejects.toThrow(BadRequestException);
      expect(handleWebhook).not.toHaveBeenCalled();
    });

    test('service verifies HMAC against raw bytes from the real controller path end-to-end', async () => {
      const raw = '{"event":"payment.captured","id":"evt_e2e_1",  "payload":{"payment":{"entity":{"id":"pay_123","order_id":"order_123","amount":1770000,"currency":"INR"}}}}';
      mockPrisma.payment.findUnique.mockResolvedValue(pendingPayment());
      const controller = new PaymentsController(service);

      const res: any = await controller.handleWebhook({ rawBody: Buffer.from(raw) }, sign(raw), 'evt_e2e_1');
      expect(res.status).toBe('ok');
    });

    test('main.ts preserves raw bytes for the webhook route before the JSON body parser', () => {
      const mainTs = fs.readFileSync(path.resolve(__dirname, '..', 'apps', 'api', 'src', 'main.ts'), 'utf-8');
      const rawIdx = mainTs.indexOf("'/api/payments/webhook'");
      const jsonIdx = mainTs.indexOf('express.json(');
      expect(rawIdx).toBeGreaterThan(-1);
      expect(mainTs).toContain('express.raw(');
      expect(mainTs).toContain('req.rawBody');
      expect(rawIdx).toBeLessThan(jsonIdx);

      const controllerTs = fs.readFileSync(
        path.resolve(__dirname, '..', 'apps', 'api', 'src', 'payments', 'payments.controller.ts'),
        'utf-8'
      );
      expect(controllerTs).not.toContain('JSON.stringify(body)');
    });
  });
});

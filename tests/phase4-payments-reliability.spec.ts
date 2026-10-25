import { BadRequestException, BadGatewayException, ForbiddenException, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PaymentStatus, RegistrationStatus } from '@prisma/client';
import { UserRole } from '@gcdis/shared';
import { PaymentsService } from '../apps/api/src/payments/payments.service';

describe('Phase 4: Payments, Webhooks, Reconciliation & Reliability Hardening', () => {
  const rootDir = path.resolve(__dirname, '..');
  const mainTsPath = path.join(rootDir, 'apps', 'api', 'src', 'main.ts');
  const paymentsServicePath = path.join(rootDir, 'apps', 'api', 'src', 'payments', 'payments.service.ts');

  describe('1. Fail Closed: Startup Check & Gateway Outage Protections', () => {
    test('main.ts refuses to start in production if Razorpay key, secret, or webhook secret is missing or contains placeholder', () => {
      const code = fs.readFileSync(mainTsPath, 'utf-8');
      expect(code).toContain('RAZORPAY_KEY_ID is required in production');
      expect(code).toContain('RAZORPAY_KEY_SECRET is required in production');
      expect(code).toContain('RAZORPAY_WEBHOOK_SECRET is required in production');
      expect(code).toContain('placeholder');
    });

    test('PaymentsService has removed fake local order, 12000 fallback, and rzp_test_placeholder', () => {
      const code = fs.readFileSync(paymentsServicePath, 'utf-8');
      expect(code).not.toContain('rzp_test_placeholder');
      expect(code).not.toContain(': 12000');
    });

    test('createOrder throws 502 Bad Gateway and creates nothing in DB when Razorpay fails', async () => {
      const mockPrisma: any = {
        registration: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'reg-1',
            status: RegistrationStatus.PAYMENT_PENDING,
            registrationCode: 'GCDIS-CAT-0001',
            category: { entryFee: 15000, name: 'D20' },
            team: { captainId: 'captain-1', code: 'T001', name: 'Team One' }
          })
        },
        payment: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn()
        },
        siteSetting: {
          findUnique: jest.fn().mockResolvedValue({ value: 18 })
        },
        $executeRawUnsafe: jest.fn()
      };

      process.env.RAZORPAY_KEY_ID = 'rzp_live_validkey123';
      process.env.RAZORPAY_KEY_SECRET = 'valid_secret_xyz12345';

      // Mock fetch to simulate Razorpay API outage
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockRejectedValue(new Error('Razorpay 502 Bad Gateway Outage'));

      const service = new PaymentsService(mockPrisma, {} as any, { logAction: jest.fn() } as any);

      await expect(
        service.createOrder({ registrationId: 'reg-1' }, 'captain-1')
      ).rejects.toThrow(BadGatewayException);

      // Verify that NOTHING was created in the database
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();

      global.fetch = originalFetch;
    });
  });

  describe('2. Webhook: RAW Body HMAC, Timing Attacks, Mismatches, and Atomicity', () => {
    let mockPrisma: any;
    let mockAudit: any;
    let service: PaymentsService;
    const webhookSecret = 'secure_webhook_secret_for_tests_999';

    beforeEach(() => {
      process.env.RAZORPAY_WEBHOOK_SECRET = webhookSecret;

      mockPrisma = {
        processedWebhookEvent: {
          findUnique: jest.fn(),
          create: jest.fn()
        },
        payment: {
          findUnique: jest.fn(),
          update: jest.fn()
        },
        registration: {
          update: jest.fn()
        },
        $transaction: jest.fn(async (cb) => cb(mockPrisma)),
        $executeRawUnsafe: jest.fn()
      };
      mockAudit = { logAction: jest.fn() };
      service = new PaymentsService(mockPrisma, {} as any, mockAudit);
    });

    test('Webhook rejects invalid signature with 400 Bad Request, never 500 (length check before timingSafeEqual)', async () => {
      const rawBody = JSON.stringify({ event: 'payment.captured', id: 'evt_1' });
      // Shorter signature length should cleanly return 400 without crashing timingSafeEqual
      await expect(
        service.handleWebhook(rawBody, 'short_sig', 'evt_1')
      ).rejects.toThrow(BadRequestException);
    });

    test('Webhook verifies valid HMAC on raw body buffer', async () => {
      const rawPayload = JSON.stringify({
        event: 'payment.captured',
        id: 'evt_valid_1',
        payload: {
          payment: {
            entity: {
              id: 'pay_123',
              order_id: 'order_123',
              amount: 1770000,
              currency: 'INR'
            }
          }
        }
      });
      const validSig = crypto.createHmac('sha256', webhookSecret).update(Buffer.from(rawPayload)).digest('hex');

      mockPrisma.processedWebhookEvent.findUnique.mockResolvedValue(null);
      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'p-1',
        orderId: 'order_123',
        amount: 17700,
        currency: 'INR',
        status: PaymentStatus.PENDING,
        registration: { id: 'reg-1', status: RegistrationStatus.PAYMENT_PENDING }
      });
      mockPrisma.payment.update.mockResolvedValue({ id: 'p-1', status: PaymentStatus.SUCCESS });

      const res = await service.handleWebhook(rawPayload, validSig, 'evt_valid_1');
      expect(res.status).toBe('ok');
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: PaymentStatus.SUCCESS }) })
      );
      expect(mockPrisma.processedWebhookEvent.create).toHaveBeenCalled();
    });

    test('Webhook rejects payment amount or currency mismatch with 400 Bad Request', async () => {
      const rawPayload = JSON.stringify({
        event: 'payment.captured',
        id: 'evt_mismatch_1',
        payload: {
          payment: {
            entity: {
              id: 'pay_123',
              order_id: 'order_123',
              amount: 50000, // Attacker reports 500 INR instead of 17700 INR
              currency: 'INR'
            }
          }
        }
      });
      const validSig = crypto.createHmac('sha256', webhookSecret).update(Buffer.from(rawPayload)).digest('hex');

      mockPrisma.processedWebhookEvent.findUnique.mockResolvedValue(null);
      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'p-1',
        orderId: 'order_123',
        amount: 17700,
        currency: 'INR',
        status: PaymentStatus.PENDING,
        registration: { id: 'reg-1', status: RegistrationStatus.PAYMENT_PENDING }
      });

      await expect(
        service.handleWebhook(rawPayload, validSig, 'evt_mismatch_1')
      ).rejects.toThrow(BadRequestException);
    });

    test('Webhook is strictly idempotent: duplicate event returns already_processed without re-processing', async () => {
      const rawPayload = JSON.stringify({ event: 'payment.captured', id: 'evt_dup_1' });
      const validSig = crypto.createHmac('sha256', webhookSecret).update(Buffer.from(rawPayload)).digest('hex');

      mockPrisma.processedWebhookEvent.findUnique.mockResolvedValue({ gatewayEventId: 'evt_dup_1' });

      const res = await service.handleWebhook(rawPayload, validSig, 'evt_dup_1');
      expect(res.status).toBe('already_processed');
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    });

    test('Out-of-order webhook protection: does not revert already REFUNDED payment to SUCCESS', async () => {
      const rawPayload = JSON.stringify({
        event: 'payment.captured',
        id: 'evt_delayed_1',
        payload: {
          payment: {
            entity: { id: 'pay_123', order_id: 'order_123', amount: 1770000, currency: 'INR' }
          }
        }
      });
      const validSig = crypto.createHmac('sha256', webhookSecret).update(Buffer.from(rawPayload)).digest('hex');

      mockPrisma.processedWebhookEvent.findUnique.mockResolvedValue(null);
      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'p-1',
        orderId: 'order_123',
        amount: 17700,
        currency: 'INR',
        status: PaymentStatus.REFUNDED, // Terminal state
        registration: { id: 'reg-1', status: RegistrationStatus.CANCELLED }
      });

      const res = await service.handleWebhook(rawPayload, validSig, 'evt_delayed_1');
      expect(res.status).toBe('ignored_terminal_state');
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    });
  });

  describe('3. verify-signature: Ownership Check & Razorpay API Verification', () => {
    let mockPrisma: any;
    let service: PaymentsService;
    const keyId = 'rzp_live_testkey_123';
    const keySecret = 'secret_test_signature_xyz';

    beforeEach(() => {
      process.env.RAZORPAY_KEY_ID = keyId;
      process.env.RAZORPAY_KEY_SECRET = keySecret;

      mockPrisma = {
        payment: {
          findUnique: jest.fn(),
          update: jest.fn()
        },
        registration: {
          update: jest.fn()
        },
        $transaction: jest.fn(async (cb) => cb(mockPrisma)),
        $executeRawUnsafe: jest.fn()
      };

      service = new PaymentsService(mockPrisma, {} as any, { logAction: jest.fn() } as any);
    });

    test('verifyPaymentSignature confirms payment belongs to caller (throws 403 on Captain B touching Captain A payment)', async () => {
      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'p-1',
        orderId: 'order_captain_a',
        registration: {
          team: { captainId: 'captain-a' }
        }
      });

      await expect(
        service.verifyPaymentSignature(
          {
            razorpayOrderId: 'order_captain_a',
            razorpayPaymentId: 'pay_1',
            razorpaySignature: 'sig_1'
          },
          'captain-b' // Captain B caller
        )
      ).rejects.toThrow(ForbiddenException);
    });

    test('verifyPaymentSignature fetches payment from Razorpay and confirms captured status and amount', async () => {
      const orderId = 'order_valid_123';
      const paymentId = 'pay_valid_123';
      const sig = crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');

      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'p-1',
        orderId,
        amount: 14160,
        registration: {
          id: 'reg-1',
          status: RegistrationStatus.PAYMENT_PENDING,
          team: { captainId: 'captain-a' }
        }
      });
      mockPrisma.payment.update.mockResolvedValue({ id: 'p-1', status: PaymentStatus.SUCCESS });

      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: paymentId,
          order_id: orderId,
          status: 'captured',
          amount: 1416000 // 14,160 INR in paise
        })
      } as any);

      const res = await service.verifyPaymentSignature(
        {
          razorpayOrderId: orderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: sig
        },
        'captain-a'
      );

      expect(res.status).toBe(PaymentStatus.SUCCESS);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/payments/${paymentId}`),
        expect.any(Object)
      );

      global.fetch = originalFetch;
    });

    test('verifyPaymentSignature rejects if Razorpay reports uncaptured status or amount mismatch', async () => {
      const orderId = 'order_valid_123';
      const paymentId = 'pay_failed_123';
      const sig = crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');

      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'p-1',
        orderId,
        amount: 14160,
        registration: {
          id: 'reg-1',
          status: RegistrationStatus.PAYMENT_PENDING,
          team: { captainId: 'captain-a' }
        }
      });

      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: paymentId,
          order_id: orderId,
          status: 'failed', // Not captured!
          amount: 1416000
        })
      } as any);

      await expect(
        service.verifyPaymentSignature(
          {
            razorpayOrderId: orderId,
            razorpayPaymentId: paymentId,
            razorpaySignature: sig
          },
          'captain-a'
        )
      ).rejects.toThrow(BadRequestException);

      global.fetch = originalFetch;
    });
  });

  describe('4. createOrder: Fee from Category, PAYMENT_PENDING Requirement, Stored GST Rate, and Concurrency', () => {
    let mockPrisma: any;
    let service: PaymentsService;

    beforeEach(() => {
      process.env.RAZORPAY_KEY_ID = 'rzp_live_key_order';
      process.env.RAZORPAY_KEY_SECRET = 'rzp_live_secret_order';

      mockPrisma = {
        registration: {
          findUnique: jest.fn()
        },
        payment: {
          findFirst: jest.fn(),
          create: jest.fn()
        },
        siteSetting: {
          findUnique: jest.fn().mockResolvedValue({ value: 18 })
        },
        $transaction: jest.fn(async (cb) => cb(mockPrisma)),
        $executeRawUnsafe: jest.fn()
      };

      service = new PaymentsService(mockPrisma, {} as any, { logAction: jest.fn() } as any);
    });

    test('createOrder rejects if category.entryFee is unset (no 12000 fallback, returns clear "Needs input" error)', async () => {
      mockPrisma.registration.findUnique.mockResolvedValue({
        id: 'reg-1',
        status: RegistrationStatus.PAYMENT_PENDING,
        category: { entryFee: 0 }, // Unset / zero
        team: { captainId: 'captain-1' }
      });

      await expect(
        service.createOrder({ registrationId: 'reg-1' }, 'captain-1')
      ).rejects.toThrow('Needs input');
    });

    test('createOrder requires registration to be in PAYMENT_PENDING status', async () => {
      mockPrisma.registration.findUnique.mockResolvedValue({
        id: 'reg-1',
        status: RegistrationStatus.SUBMITTED, // Not in PAYMENT_PENDING!
        category: { entryFee: 10000 },
        team: { captainId: 'captain-1' }
      });

      await expect(
        service.createOrder({ registrationId: 'reg-1' }, 'captain-1')
      ).rejects.toThrow('PAYMENT_PENDING');
    });

    test('createOrder stores baseAmount and dynamic gstRate on payment row, used dynamically by invoices without hardcoded 1.18', async () => {
      mockPrisma.registration.findUnique.mockResolvedValue({
        id: 'reg-1',
        status: RegistrationStatus.PAYMENT_PENDING,
        registrationCode: 'GCDIS-D40-001',
        category: { entryFee: 3500, name: 'D40 Drone Soccer' },
        team: { captainId: 'captain-1', code: 'T001', name: 'AERO', institutionName: 'NIT' }
      });
      mockPrisma.payment.findFirst.mockResolvedValue(null);
      mockPrisma.payment.create.mockImplementation(async (args: any) => ({
        id: 'pay-new-1',
        ...args.data
      }));

      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'order_rzp_dynamic_gst' })
      } as any);

      const res = await service.createOrder({ registrationId: 'reg-1' }, 'captain-1');

      // 3500 INR GST-inclusive = 2966.10 taxable value + 533.90 GST (18%) = 350000 paise
      expect(res.amountInPaise).toBe(350000);
      expect(mockPrisma.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            baseAmount: 2966.1,
            gstRate: 18,
            gstAmount: 533.9,
            amount: 3500
          })
        })
      );

      global.fetch = originalFetch;
    });

    test('Concurrent double-clicks safely return existing order within 15 minutes', async () => {
      const existingPendingOrder = {
        id: 'p-existing',
        orderId: 'order_active_15m',
        amount: 11800,
        currency: 'INR',
        createdAt: new Date() // Just created
      };

      mockPrisma.registration.findUnique.mockResolvedValue({
        id: 'reg-1',
        status: RegistrationStatus.PAYMENT_PENDING,
        category: { entryFee: 10000 },
        team: { captainId: 'captain-1', name: 'AERO' }
      });
      mockPrisma.payment.findFirst.mockImplementation(async ({ where }: any) => {
        if (where?.status === PaymentStatus.SUCCESS) return null;
        if (where?.status === PaymentStatus.PENDING) return existingPendingOrder;
        return null;
      });

      const res = await service.createOrder({ registrationId: 'reg-1' }, 'captain-1');
      expect(res.isExistingOrder).toBe(true);
      expect(res.payment.orderId).toBe('order_active_15m');
    });
  });

  describe('5. Refunds: Razorpay API, Stored Refund ID, and Idempotency', () => {
    let mockPrisma: any;
    let mockAudit: any;
    let service: PaymentsService;

    beforeEach(() => {
      process.env.RAZORPAY_KEY_ID = 'rzp_live_refund_key';
      process.env.RAZORPAY_KEY_SECRET = 'rzp_live_refund_secret';

      mockPrisma = {
        payment: {
          findUnique: jest.fn(),
          update: jest.fn(),
          // Atomic refund claim (SUCCESS with no refund in flight)
          updateMany: jest.fn().mockResolvedValue({ count: 1 })
        },
        registration: {
          update: jest.fn()
        },
        $transaction: jest.fn(async (cb) => cb(mockPrisma)),
        $executeRawUnsafe: jest.fn()
      };
      mockAudit = { logAction: jest.fn() };
      service = new PaymentsService(mockPrisma, {} as any, mockAudit);
    });

    test('processRefund calls Razorpay refund API, updates payment and registration to CANCELLED', async () => {
      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        paymentId: 'pay_gateway_id_1',
        amount: 11800,
        status: PaymentStatus.SUCCESS,
        registrationId: 'reg-1'
      });
      mockPrisma.payment.update.mockResolvedValue({
        id: 'pay-1',
        status: PaymentStatus.REFUNDED,
        refundId: 'rfnd_12345'
      });

      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'rfnd_12345', status: 'processed' })
      } as any);

      const result = await service.processRefund('pay-1', 'Team withdrawal', 'admin-user-1');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/payments/pay_gateway_id_1/refund'),
        expect.objectContaining({ method: 'POST' })
      );
      expect(mockPrisma.registration.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: RegistrationStatus.CANCELLED } })
      );
      expect(result.refundId).toBe('rfnd_12345');

      global.fetch = originalFetch;
    });

    test('processRefund is strictly idempotent: re-invoking refund returns existing refund record without re-calling gateway', async () => {
      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'pay-1',
        paymentId: 'pay_gateway_id_1',
        amount: 11800,
        status: PaymentStatus.REFUNDED, // Already refunded
        refundId: 'rfnd_existing_999'
      });

      const originalFetch = global.fetch;
      global.fetch = jest.fn();

      const result: any = await service.processRefund('pay-1', 'Duplicate refund call');
      expect(result.status).toBe('already_refunded');
      expect(result.refundId).toBe('rfnd_existing_999');
      expect(global.fetch).not.toHaveBeenCalled();

      global.fetch = originalFetch;
    });
  });

  describe('6. Scheduled Reconciliation: Redis Lock & Razorpay Gateway Inquiry', () => {
    let mockPrisma: any;
    let service: PaymentsService;

    beforeEach(() => {
      process.env.RAZORPAY_KEY_ID = 'rzp_live_recon_key';
      process.env.RAZORPAY_KEY_SECRET = 'rzp_live_recon_secret';

      mockPrisma = {
        payment: {
          findMany: jest.fn(),
          findUnique: jest.fn(),
          update: jest.fn()
        },
        registration: {
          update: jest.fn()
        },
        $transaction: jest.fn(async (cb) => cb(mockPrisma)),
        $executeRawUnsafe: jest.fn()
      };

      service = new PaymentsService(mockPrisma, {} as any, { logAction: jest.fn() } as any);
    });

    test('Reconciliation never marks pending payment as failed without asking Razorpay (skips if gateway unreachable)', async () => {
      mockPrisma.payment.findMany.mockResolvedValue([
        {
          id: 'pay-stale-1',
          orderId: 'order_stale_1',
          amount: 11800,
          status: PaymentStatus.PENDING,
          createdAt: new Date(Date.now() - 20 * 60 * 1000) // 20 mins ago
        }
      ]);

      const originalFetch = global.fetch;
      // Gateway error / unreachable
      global.fetch = jest.fn().mockRejectedValue(new Error('Razorpay Gateway 503'));

      const results: any = await service.reconcileStalePayments();

      expect(results.skipped).toBe(1);
      expect(results.expired).toBe(0);
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();

      global.fetch = originalFetch;
    });

    test('Reconciliation reconciles captured payment on Razorpay to SUCCESS', async () => {
      mockPrisma.payment.findMany.mockResolvedValue([
        {
          id: 'pay-stale-1',
          orderId: 'order_stale_1',
          amount: 11800,
          status: PaymentStatus.PENDING,
          createdAt: new Date(Date.now() - 20 * 60 * 1000)
        }
      ]);
      mockPrisma.payment.findUnique.mockResolvedValue({
        id: 'pay-stale-1',
        orderId: 'order_stale_1',
        amount: 11800,
        registration: { id: 'reg-1', status: RegistrationStatus.PAYMENT_PENDING }
      });
      mockPrisma.payment.update.mockResolvedValue({ id: 'pay-stale-1', status: PaymentStatus.SUCCESS });

      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          count: 1,
          items: [{ id: 'pay_captured_on_rzp', status: 'captured', amount: 1180000 }]
        })
      } as any);

      const results: any = await service.reconcileStalePayments();

      expect(results.reconciled).toBe(1);
      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: PaymentStatus.SUCCESS })
        })
      );

      global.fetch = originalFetch;
    });
  });
});

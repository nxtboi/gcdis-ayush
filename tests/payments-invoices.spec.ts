import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PaymentsService } from '../apps/api/src/payments/payments.service';
import { PaymentStatus, RegistrationStatus } from '@gcdis/shared';
import * as crypto from 'crypto';

describe('Payments & Invoicing Integration (Execution Engine)', () => {
  let paymentsService: PaymentsService;
  let mockPrisma: any;
  let mockPdf: any;
  let mockAudit: any;
  let paymentsDb: Map<string, any>;
  let registrationsDb: Map<string, any>;

  const RZP_KEY = 'rzp_test_prod_key_123';
  const RZP_SECRET = 'rzp_test_prod_secret_456';
  const RZP_WEBHOOK_SECRET = 'rzp_webhook_secret_789';

  beforeAll(() => {
    process.env.RAZORPAY_KEY_ID = RZP_KEY;
    process.env.RAZORPAY_KEY_SECRET = RZP_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = RZP_WEBHOOK_SECRET;
  });

  beforeEach(() => {
    paymentsDb = new Map();
    registrationsDb = new Map();

    registrationsDb.set('reg-101', {
      id: 'reg-101',
      status: RegistrationStatus.PAYMENT_PENDING,
      team: {
        id: 'team-1',
        name: 'AERO HAWK',
        captainId: 'captain-1',
        captain: { fullName: 'Captain Rajesh', email: 'rajesh@aerohawk.in' }
      },
      category: { id: 'cat-d20', name: 'AirMouse (D20)', entryFee: 1500 }
    });

    mockPdf = {
      generateInvoicePdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 Official Tax Invoice'))
    };

    mockAudit = {
      logAction: jest.fn().mockResolvedValue({})
    };

    mockPrisma = {
      registration: {
        findUnique: jest.fn(async ({ where }) => registrationsDb.get(where.id) || null),
        update: jest.fn(async ({ where, data }) => {
          const reg = registrationsDb.get(where.id);
          const updated = { ...reg, ...data };
          registrationsDb.set(where.id, updated);
          return updated;
        })
      },
      siteSetting: {
        findUnique: jest.fn().mockResolvedValue({ value: 18 })
      },
      payment: {
        findFirst: jest.fn(async ({ where }) => {
          if (where?.OR) {
            for (const cond of where.OR) {
              if (cond.id && paymentsDb.get(cond.id)) return paymentsDb.get(cond.id);
              if (cond.orderId) {
                for (const p of paymentsDb.values()) {
                  if (p.orderId === cond.orderId) return p;
                }
              }
            }
          }
          if (where?.id) return paymentsDb.get(where.id) || null;
          if (where?.registrationId) {
            for (const p of paymentsDb.values()) {
              if (p.registrationId === where.registrationId) return p;
            }
          }
          return null;
        }),
        findUnique: jest.fn(async ({ where }) => {
          if (where.id) return paymentsDb.get(where.id) || null;
          if (where.orderId) {
            for (const p of paymentsDb.values()) {
              if (p.orderId === where.orderId) return p;
            }
          }
          return null;
        }),
        create: jest.fn(async ({ data }) => {
          const p = {
            id: `pay-${paymentsDb.size + 1}`,
            ...data,
            registration: registrationsDb.get(data.registrationId),
            createdAt: new Date()
          };
          paymentsDb.set(p.id, p);
          return p;
        }),
        update: jest.fn(async ({ where, data }) => {
          const p = paymentsDb.get(where.id);
          const updated = { ...p, ...data };
          paymentsDb.set(where.id, updated);
          return updated;
        })
      },
      processedWebhookEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'evt-1' })
      },
      $transaction: jest.fn(async (cb) => cb(mockPrisma))
    };

    paymentsService = new PaymentsService(mockPrisma as any, mockPdf as any, mockAudit as any);
  });

  test('1. createOrder treats the entry fee as GST-inclusive (1500 INR -> 1271.19 + 228.81 GST -> 150000 paise)', async () => {
    // Mock Razorpay API call
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'order_rzp_mock_123',
        amount: 150000,
        currency: 'INR',
        status: 'created'
      })
    } as any);

    const orderRes = await paymentsService.createOrder({ registrationId: 'reg-101' }, 'captain-1');

    expect(orderRes.keyId).toBe(RZP_KEY);
    expect(orderRes.amountInPaise).toBe(150000);
    expect(orderRes.currency).toBe('INR');
    expect(orderRes.payment.amount).toBe(1500);
    expect(orderRes.payment.baseAmount).toBe(1271.19);
    expect(orderRes.payment.gstAmount).toBe(228.81);
    expect(orderRes.payment.gstRate).toBe(18);

    global.fetch = originalFetch;
  });

  test('2. verifyPaymentSignature validates HMAC SHA-256 and updates status to SUCCESS', async () => {
    // Seed pending payment
    const pendingPayment = {
      id: 'pay-1',
      orderId: 'order_rzp_mock_123',
      amount: 11800,
      status: PaymentStatus.PENDING,
      registrationId: 'reg-101',
      registration: registrationsDb.get('reg-101')
    };
    paymentsDb.set('pay-1', pendingPayment);

    // Mock Razorpay payment capture verification endpoint
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'pay_rzp_capture_789',
        order_id: 'order_rzp_mock_123',
        status: 'captured',
        amount: 1180000
      })
    } as any);

    // Valid HMAC SHA-256 signature
    const payload = `order_rzp_mock_123|pay_rzp_capture_789`;
    const validSignature = crypto.createHmac('sha256', RZP_SECRET).update(payload).digest('hex');

    const result = await paymentsService.verifyPaymentSignature(
      {
        razorpayOrderId: 'order_rzp_mock_123',
        razorpayPaymentId: 'pay_rzp_capture_789',
        razorpaySignature: validSignature
      },
      'captain-1'
    );

    expect(result.status).toBe(PaymentStatus.SUCCESS);
    expect(result.paymentId).toBe('pay_rzp_capture_789');

    // Registration should transition to PAYMENT_VERIFIED
    expect(registrationsDb.get('reg-101').status).toBe(RegistrationStatus.PAYMENT_VERIFIED);

    global.fetch = originalFetch;
  });

  test('3. generateInvoicePdf produces signed PDF buffer with team & GST metadata', async () => {
    const successPayment = {
      id: 'pay-inv-1',
      orderId: 'order_inv_123',
      amount: 11800,
      baseAmount: 10000,
      gstAmount: 1800,
      gstRate: 18,
      status: PaymentStatus.SUCCESS,
      paidAt: new Date(),
      registration: registrationsDb.get('reg-101')
    };
    paymentsDb.set('pay-inv-1', successPayment);

    const pdfBuffer = await paymentsService.generateInvoicePdf('pay-inv-1', 'captain-1');
    expect(pdfBuffer).toBeDefined();
    expect(mockPdf.generateInvoicePdf).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'AERO HAWK',
        amount: 11800,
        gstAmount: 1800
      })
    );
  });
});

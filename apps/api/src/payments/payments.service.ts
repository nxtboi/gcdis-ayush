import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  BadGatewayException,
  ConflictException,
  Logger,
  Optional
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PdfGeneratorService } from '../certificates/pdf-generator.service';
import { AuditService } from '../audit/audit.service';
import { SecurityAlertService } from '../security/security-alert.service';
import { Prisma, PaymentStatus, RegistrationStatus } from '@prisma/client';
import { CreatePaymentOrderInput, canTransitionRegistration, UserRole } from '@gcdis/shared';

let RedisClass: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  RedisClass = require('ioredis');
} catch {
  // Graceful fallback when ioredis is not present in runtime environment
}

/** Razorpay webhook events that prove the money was captured. */
const PAYMENT_SUCCESS_EVENTS = new Set(['payment.captured', 'order.paid']);
/** Razorpay webhook events that report a failed payment attempt. */
const PAYMENT_FAILURE_EVENTS = new Set(['payment.failed']);
/** Upper bound of stale payments examined per reconciliation run. */
const RECONCILIATION_BATCH_SIZE = 100;

type AuditEntry = Parameters<AuditService['logAction']>[0];

/** Registration states in which a newly captured payment can no longer be applied (refund manually). */
export const INACTIVE_REGISTRATION_STATUSES: readonly string[] = [
  RegistrationStatus.WITHDRAWN,
  RegistrationStatus.CANCELLED,
  RegistrationStatus.REJECTED
];

/** refundStatus value that claims a payment while its gateway refund is in flight. */
export const REFUND_IN_PROGRESS = 'PENDING';
/** refundStatus value recorded when the gateway refund call failed (the refund may be retried). */
export const REFUND_FAILED = 'FAILED';

/**
 * The only webhook fields kept in processedWebhookEvent.payloadSnapshot: identifiers, amount, currency
 * and status. Payer email, phone, VPA, card and bank details are never stored.
 */
export function minimalWebhookSnapshot(
  gatewayEventId: string,
  eventType: string,
  paymentEntity: any,
  orderEntity: any
): Record<string, string | number | null> {
  const str = (v: unknown) => (typeof v === 'string' && v.length <= 200 ? v : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    eventId: str(gatewayEventId),
    eventType: str(eventType),
    orderId: str(orderEntity?.id) ?? str(paymentEntity?.order_id),
    paymentId: str(paymentEntity?.id),
    amount: num(paymentEntity?.amount) ?? num(orderEntity?.amount),
    currency: str(paymentEntity?.currency) ?? str(orderEntity?.currency),
    status: str(paymentEntity?.status) ?? str(orderEntity?.status)
  };
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private redisClient: any = null;
  private isRedisConnected = false;
  private inMemoryLocks = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private prisma: PrismaService,
    private pdfGeneratorService: PdfGeneratorService,
    private auditService: AuditService,
    @Optional() private securityAlerts?: SecurityAlertService
  ) {
    this.initRedis();
  }

  // NOTE: The partial unique index "one PENDING payment per registration"
  // (idx_payments_one_pending_per_registration) must be created by a Prisma
  // migration, not by runtime DDL from the application.

  private initRedis() {
    try {
      const RedisConstructor = RedisClass?.default || RedisClass;
      if (!RedisConstructor) {
        this.isRedisConnected = false;
        return;
      }
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      this.redisClient = new RedisConstructor(redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: 1000,
        lazyConnect: true
      });

      this.redisClient.connect().then(() => {
        this.isRedisConnected = true;
      }).catch(() => {
        this.isRedisConnected = false;
      });

      this.redisClient.on('error', () => {
        this.isRedisConnected = false;
      });

      this.redisClient.on('connect', () => {
        this.isRedisConnected = true;
      });
    } catch {
      this.isRedisConnected = false;
    }
  }

  /**
   * Acquire a lock. Returns an ownership token on success, or null if the lock is held.
   * The token must be passed to releaseRedisLock so that an instance never releases
   * a lock that expired and was re-acquired by another instance.
   */
  private async acquireRedisLock(key: string, ttlSeconds: number = 60): Promise<string | null> {
    const token = crypto.randomBytes(16).toString('hex');
    if (this.redisClient && this.isRedisConnected) {
      try {
        const res = await this.redisClient.set(key, token, 'EX', ttlSeconds, 'NX');
        return res === 'OK' ? token : null;
      } catch {
        // Fallback to in-memory lock
      }
    }
    const now = Date.now();
    this.pruneExpiredInMemoryLocks(now);
    const existing = this.inMemoryLocks.get(key);
    if (existing && existing.expiresAt > now) {
      return null;
    }
    this.inMemoryLocks.set(key, { token, expiresAt: now + ttlSeconds * 1000 });
    return token;
  }

  private async releaseRedisLock(key: string, token: string): Promise<void> {
    if (this.redisClient && this.isRedisConnected) {
      try {
        // Compare-and-delete: only release the lock if we still own it
        await this.redisClient.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          key,
          token
        );
      } catch {
        // Fallback to in-memory lock
      }
    }
    const existing = this.inMemoryLocks.get(key);
    if (existing && existing.token === token) {
      this.inMemoryLocks.delete(key);
    }
  }

  /** Drop expired in-memory locks so the fallback map cannot grow without bound. */
  private pruneExpiredInMemoryLocks(now: number = Date.now()): void {
    for (const [lockKey, lock] of this.inMemoryLocks) {
      if (lock.expiresAt <= now) {
        this.inMemoryLocks.delete(lockKey);
      }
    }
  }

  /**
   * Write an audit row through the given transaction client so that it commits or
   * rolls back atomically with the state change it describes.
   */
  private async logAuditInTx(tx: Prisma.TransactionClient, entry: AuditEntry) {
    const client = tx as any;
    if (typeof client?.auditLog?.create !== 'function') {
      // Client without an auditLog delegate (e.g. unit-test doubles): use the audit service
      return this.auditService.logAction(entry);
    }
    return new AuditService(client).logAction(entry);
  }

  /**
   * A capture for a registration that already has another SUCCESS payment, or that was withdrawn,
   * cancelled or rejected, cannot be applied: the payment row still records the capture (the money
   * was taken), the registration is left unchanged, and staff are alerted to refund it manually.
   * Never throws: alerting must not block recording a captured payment.
   */
  private async flagCaptureNeedingRefund(
    tx: Prisma.TransactionClient,
    payment: { id: string; orderId: string; amount: number; currency?: string; registrationId?: string; registration?: any },
    gatewayPaymentId: string | undefined,
    source: string
  ): Promise<string | null> {
    try {
      const registration = payment.registration;
      const registrationId = payment.registrationId ?? registration?.id;
      let reason: string | null = null;
      if (registration && INACTIVE_REGISTRATION_STATUSES.includes(registration.status)) {
        reason = `REGISTRATION_${registration.status}`;
      } else if (registrationId) {
        const other = await tx.payment.findFirst({
          where: { registrationId, status: PaymentStatus.SUCCESS, id: { not: payment.id } },
          select: { id: true }
        });
        if (other && other.id !== payment.id) reason = 'DUPLICATE_PAYMENT';
      }
      if (!reason) return null;

      this.logger.warn(
        `[Payment] Capture ${gatewayPaymentId || 'unknown'} for order ${payment.orderId} needs a manual refund (${reason}).`
      );
      if (this.securityAlerts) {
        void this.securityAlerts
          .alert('PAYMENT_REQUIRES_MANUAL_REFUND', payment.orderId, {
            reason,
            paymentRecordId: payment.id,
            gatewayPaymentId,
            registrationId,
            registrationStatus: registration?.status,
            amount: payment.amount,
            currency: payment.currency,
            source
          })
          .catch(() => undefined);
      }
      return reason;
    } catch (err: any) {
      this.logger.error(`[Payment] Could not check capture ${payment.orderId} for a needed refund: ${err?.message || err}`);
      return null;
    }
  }

  /**
   * Fail closed: Retrieve and validate Razorpay credentials.
   * Throws 502 Bad Gateway if missing or containing placeholder.
   */
  private getRazorpayCredentials() {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret || keyId.includes('placeholder') || keySecret.includes('placeholder')) {
      throw new BadGatewayException(
        'Payment gateway misconfigured: Razorpay key or secret is missing or contains placeholder values'
      );
    }

    return { keyId, keySecret };
  }

  /**
   * Helper to perform authenticated Razorpay HTTP calls.
   * Returns 502 Bad Gateway on any failure.
   */
  private async callRazorpay(endpoint: string, options: RequestInit = {}): Promise<any> {
    const { keyId, keySecret } = this.getRazorpayCredentials();
    const authHeader = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');

    const headers: Record<string, string> = {
      Authorization: authHeader,
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string>) || {})
    };

    try {
      const res = await fetch(`https://api.razorpay.com/v1${endpoint}`, {
        ...options,
        headers
      });

      if (!res.ok) {
        // The gateway's error body is logged server-side only: it can contain gateway internals,
        // account details or payer data and is never echoed to the client.
        let errText = '';
        try {
          errText = await res.text();
        } catch {
          // ignore unreadable bodies
        }
        this.logger.error(`[Razorpay HTTP Error] ${endpoint.split('?')[0]} ${res.status}: ${errText.slice(0, 2000)}`);
        throw new BadGatewayException(
          `The payment gateway could not complete the request (status ${res.status}). Please try again later.`
        );
      }

      return await res.json();
    } catch (err: any) {
      if (err instanceof BadGatewayException) {
        throw err;
      }
      this.logger.error(`[Razorpay Connection Error] ${err?.message || err}`);
      throw new BadGatewayException('The payment gateway is unreachable at the moment. Please try again later.');
    }
  }

  /**
   * 1. Safe Order Creation:
   * - Fee only from Category.entryFee (no 12000 fallback; if unset return clear error)
   * - Requires Registration to be in PAYMENT_PENDING status
   * - GST rate stored on payment row and used by invoices
   * - Integer paise precision
   * - Razorpay call OUTSIDE the DB transaction
   * - Safe idempotency: returns existing order on double-clicks / tab refreshes within 15m
   */
  async createOrder(input: { registrationId: string; gateway?: any }, captainUserId?: string) {
    // 1. Verify Registration
    const registration = await this.prisma.registration.findUnique({
      where: { id: input.registrationId },
      include: {
        category: true,
        team: true
      }
    });

    if (!registration) {
      throw new NotFoundException(`Registration '${input.registrationId}' not found`);
    }

    // 2. Ownership Check
    if (captainUserId && registration.team.captainId !== captainUserId) {
      throw new ForbiddenException('Unauthorized: You can only create payment orders for your own team');
    }

    // 3. Status Check: Must be in PAYMENT_PENDING
    if (registration.status !== RegistrationStatus.PAYMENT_PENDING) {
      throw new BadRequestException(
        `Cannot create payment order: Registration must be in PAYMENT_PENDING status. Current status: '${registration.status}'`
      );
    }

    // 3b. A category closed by the Secretariat accepts no new payment orders
    if ((registration.category as any)?.isActive === false) {
      throw new BadRequestException('This competition category is not open for registration; no payment can be taken for it.');
    }

    // 4. Category Entry Fee Check: Delete 12000 fallback; require explicit configured entry fee
    if (
      registration.category.entryFee === null ||
      registration.category.entryFee === undefined ||
      registration.category.entryFee <= 0
    ) {
      throw new BadRequestException(
        'Entry fee is not configured for this category (Needs input). Contact event administrator.'
      );
    }

    // 5. Check if already successfully paid
    const existingSuccess = await this.prisma.payment.findFirst({
      where: {
        registrationId: registration.id,
        status: PaymentStatus.SUCCESS
      }
    });
    if (existingSuccess) {
      throw new BadRequestException('Registration fee has already been paid and verified for this team');
    }

    const { keyId } = this.getRazorpayCredentials();

    // 6. Check for active PENDING order (< 15 mins) for double-click / refresh protection
    const existingPending = await this.prisma.payment.findFirst({
      where: {
        registrationId: registration.id,
        status: PaymentStatus.PENDING
      },
      orderBy: { createdAt: 'desc' }
    });

    if (existingPending) {
      const ageMinutes = (Date.now() - existingPending.createdAt.getTime()) / (1000 * 60);
      if (ageMinutes < 15) {
        this.logger.log(
          `[Payment] Returning existing active order ${existingPending.orderId} for registration ${registration.id} (Age: ${ageMinutes.toFixed(1)}m)`
        );
        return {
          payment: existingPending,
          keyId,
          amountInPaise: Math.round(existingPending.amount * 100),
          currency: existingPending.currency,
          teamName: registration.team.name,
          isExistingOrder: true
        };
      }
    }

    // 7. The category entry fee is GST-inclusive: the team pays exactly entryFee, and the taxable value
    // and GST portion are derived from it and stored on the payment row for the invoice.
    const totalAmount = Number(registration.category.entryFee.toFixed(2));
    const gstSetting = await this.prisma.siteSetting.findUnique({ where: { key: 'gst_percentage' } });
    const gstRate = typeof gstSetting?.value === 'number' ? gstSetting.value : 18;
    const baseEntryFee = Number((totalAmount / (1 + gstRate / 100)).toFixed(2));
    const gstAmount = Number((totalAmount - baseEntryFee).toFixed(2));
    const amountInPaise = Math.round(totalAmount * 100);

    // 8. Razorpay call OUTSIDE the DB transaction
    // If Razorpay call fails, it throws 502 Bad Gateway and creates NOTHING in DB
    const rzpOrder = await this.callRazorpay('/orders', {
      method: 'POST',
      body: JSON.stringify({
        amount: amountInPaise,
        currency: 'INR',
        receipt: `rcpt_${registration.registrationCode}`,
        notes: {
          registrationId: registration.id,
          teamCode: registration.team.code,
          category: registration.category.name
        }
      })
    });

    // 9. Persist payment row inside DB transaction with concurrent double-click safeguard
    let payment;
    try {
      payment = await this.prisma.$transaction(async (tx) => {
        // Re-check for concurrent race condition
        const concurrentPending = await tx.payment.findFirst({
          where: {
            registrationId: registration.id,
            status: PaymentStatus.PENDING
          }
        });
        if (concurrentPending) {
          return concurrentPending;
        }

        return tx.payment.create({
          data: {
            registrationId: registration.id,
            orderId: rzpOrder.id,
            amount: totalAmount,
            baseAmount: baseEntryFee,
            gstRate,
            gstAmount,
            currency: 'INR',
            status: PaymentStatus.PENDING,
            gateway: 'RAZORPAY'
          }
        });
      });
    } catch (err) {
      // A concurrent request won the race against the one-PENDING-per-registration unique index
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        payment = await this.prisma.payment.findFirst({
          where: { registrationId: registration.id, status: PaymentStatus.PENDING },
          orderBy: { createdAt: 'desc' }
        });
      }
      if (!payment) {
        throw err;
      }
    }

    // If a concurrent request created the order first, return ITS order details, not ours
    const isExistingOrder = payment.orderId !== rzpOrder.id;

    return {
      payment,
      keyId,
      amountInPaise: isExistingOrder ? Math.round(payment.amount * 100) : amountInPaise,
      currency: isExistingOrder ? payment.currency : 'INR',
      teamName: registration.team.name,
      isExistingOrder
    };
  }

  /**
   * 2. verify-signature:
   * - Confirm payment belongs to the caller
   * - Verify HMAC signature with timingSafeEqual and length checks
   * - Fetch payment from Razorpay to confirm status and amount
   */
  async verifyPaymentSignature(
    body: {
      razorpayOrderId: string;
      razorpayPaymentId: string;
      razorpaySignature: string;
    },
    captainUserId?: string
  ) {
    const payment = await this.prisma.payment.findUnique({
      where: { orderId: body.razorpayOrderId },
      include: {
        registration: {
          include: { team: true }
        }
      }
    });

    if (!payment) {
      throw new NotFoundException(`Order '${body.razorpayOrderId}' not found in database`);
    }

    // Ownership check: confirm payment belongs to caller
    if (captainUserId && payment.registration?.team?.captainId !== captainUserId) {
      throw new ForbiddenException('Forbidden: You can only verify payments for your own team');
    }

    const { keySecret } = this.getRazorpayCredentials();

    // Verify cryptographic signature
    const payload = `${body.razorpayOrderId}|${body.razorpayPaymentId}`;
    const expectedSignature = crypto.createHmac('sha256', keySecret).update(payload).digest('hex');

    const sigBuf = Buffer.from(body.razorpaySignature);
    const expBuf = Buffer.from(expectedSignature);

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      throw new BadRequestException('Invalid cryptographic signature from payment gateway');
    }

    // Fetch from Razorpay API to confirm captured status and amount
    const rzpPayment = await this.callRazorpay(`/payments/${body.razorpayPaymentId}`);

    // Only 'captured' means the money was actually collected; 'authorized' can still be voided
    if (rzpPayment.status !== 'captured') {
      throw new BadRequestException(
        `Payment is not successfully captured on Razorpay (status: ${rzpPayment.status})`
      );
    }

    if (rzpPayment.order_id !== body.razorpayOrderId) {
      throw new BadRequestException('Razorpay payment is not associated with this order ID');
    }

    const expectedPaise = Math.round(payment.amount * 100);
    if (rzpPayment.amount !== expectedPaise) {
      throw new BadRequestException(
        `Payment amount mismatch: expected ${expectedPaise} paise but Razorpay reported ${rzpPayment.amount}`
      );
    }

    return this.processPaymentSuccess(
      payment.orderId,
      body.razorpayPaymentId,
      body.razorpaySignature,
      `sig_${body.razorpayPaymentId}`
    );
  }

  /**
   * 3. Idempotent Webhook Handler:
   * - Verify HMAC on RAW body
   * - Check lengths before timingSafeEqual (returns 400, never 500)
   * - Validate amount, currency, order against our row
   * - Record event and apply payment in ONE transaction (failure stays retryable)
   * - Handles duplicate, out-of-order, and concurrent webhooks
   */
  async handleWebhook(rawBody: string | Buffer, signature: string, eventIdHeader?: string, ipAddress?: string) {
    if (!rawBody || (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody))) {
      throw new BadRequestException('Missing raw webhook body');
    }

    const rawBodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf-8');

    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret || webhookSecret.includes('placeholder')) {
      throw new BadGatewayException('Webhook secret is not configured or contains placeholder');
    }

    if (!signature || typeof signature !== 'string') {
      this.securityAlerts?.recordWebhookSignatureFailure(ipAddress);
      throw new BadRequestException('Missing webhook signature');
    }

    const secret = webhookSecret;
    const expectedSignature = crypto.createHmac('sha256', secret).update(rawBodyBuf).digest('hex');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSignature);

    // Strict length check before timingSafeEqual ensures 400 Bad Request, NEVER 500 TypeError
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      this.securityAlerts?.recordWebhookSignatureFailure(ipAddress);
      throw new BadRequestException('Invalid webhook signature');
    }

    let event: any;
    try {
      event = JSON.parse(rawBodyBuf.toString('utf-8'));
    } catch {
      throw new BadRequestException('Malformed webhook JSON payload');
    }

    const gatewayEventId = eventIdHeader || event.id;
    if (!gatewayEventId) {
      throw new BadRequestException('Missing gateway event ID');
    }

    const eventType: string = typeof event.event === 'string' ? event.event : 'unknown';
    const isSuccessEvent = PAYMENT_SUCCESS_EVENTS.has(eventType);
    const isFailureEvent = PAYMENT_FAILURE_EVENTS.has(eventType);

    const paymentEntity = event.payload?.payment?.entity;
    const orderEntity = event.payload?.order?.entity;
    const orderId = orderEntity?.id || paymentEntity?.order_id;
    const paymentId = paymentEntity?.id;
    const gatewayAmountPaise = paymentEntity?.amount ?? orderEntity?.amount;
    const gatewayCurrency = paymentEntity?.currency ?? orderEntity?.currency ?? 'INR';

    // Only the fields needed for reconciliation are stored: never the payer's email, phone, VPA,
    // card or bank details that Razorpay includes in the raw payload.
    const payloadSnapshot = minimalWebhookSnapshot(gatewayEventId, eventType, paymentEntity, orderEntity);

    // Atomically process webhook event and payment update in ONE transaction
    return this.prisma.$transaction(async (tx) => {
      const recordEvent = () =>
        tx.processedWebhookEvent.create({
          data: {
            gatewayEventId,
            eventType,
            payloadSnapshot
          }
        });

      // 1. Idempotency Check: if event already processed, return immediately
      const existingEvent = await tx.processedWebhookEvent.findUnique({
        where: { gatewayEventId }
      });

      if (existingEvent) {
        this.logger.log(`[Webhook] Duplicate gateway event ${gatewayEventId} already processed. Skipping.`);
        return { status: 'already_processed', gatewayEventId };
      }

      if (!orderId) {
        // Record non-order event to avoid duplicate reprocessing
        await recordEvent();
        return { status: 'ignored_unrelated_event', gatewayEventId };
      }

      // 2. Only payment.captured / order.paid may mark a payment paid and only payment.failed
      //    may mark it failed. Every other event (payment.authorized, refund.*, ...) is
      //    recorded for idempotency and acknowledged without changing state.
      if (!isSuccessEvent && !isFailureEvent) {
        await recordEvent();
        this.logger.log(`[Webhook] Event '${eventType}' (${gatewayEventId}) acknowledged without state change.`);
        return { status: 'ignored_event_type', gatewayEventId, eventType };
      }

      // 3. Fetch payment row
      const payment = await tx.payment.findUnique({
        where: { orderId },
        include: { registration: true }
      });

      if (!payment) {
        throw new NotFoundException(`Payment record for order '${orderId}' not found in database`);
      }

      // 4. Out-of-order webhook protection: Do not alter terminal states like REFUNDED
      if (payment.status === PaymentStatus.REFUNDED) {
        this.logger.warn(`[Webhook] Received webhook for already REFUNDED payment ${payment.id}. Ignoring status change.`);
        await recordEvent();
        return { status: 'ignored_terminal_state', gatewayEventId };
      }

      // If already SUCCESS: record event and return (a late payment.failed never regresses SUCCESS)
      if (payment.status === PaymentStatus.SUCCESS) {
        await recordEvent();
        return { status: 'already_success', gatewayEventId };
      }

      // 5. payment.failed: mark the attempt FAILED; registration stays as-is so the team can retry.
      //    A later payment.captured for the same order can still move it to SUCCESS.
      if (isFailureEvent) {
        if (payment.status === PaymentStatus.FAILED) {
          await recordEvent();
          return { status: 'already_failed', gatewayEventId };
        }

        const failedPayment = await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.FAILED,
            paymentId: paymentId || payment.paymentId
          }
        });

        await recordEvent();

        await this.logAuditInTx(tx, {
          action: 'PAYMENT_FAILED',
          entityType: 'Payment',
          entityId: payment.id,
          beforeState: { status: payment.status },
          afterState: {
            orderId,
            paymentId,
            status: PaymentStatus.FAILED,
            errorCode: paymentEntity?.error_code,
            errorDescription: paymentEntity?.error_description,
            gatewayEventId
          }
        });

        return { status: 'payment_failed', gatewayEventId, payment: failedPayment };
      }

      // 6. Validate amount and currency against our DB row
      const expectedPaise = Math.round(payment.amount * 100);
      if (gatewayAmountPaise !== undefined && gatewayAmountPaise !== expectedPaise) {
        throw new BadRequestException(
          `Payment amount mismatch: expected ${expectedPaise} paise, gateway reported ${gatewayAmountPaise}`
        );
      }

      if (gatewayCurrency && gatewayCurrency.toUpperCase() !== payment.currency.toUpperCase()) {
        throw new BadRequestException(
          `Payment currency mismatch: expected ${payment.currency}, gateway reported ${gatewayCurrency}`
        );
      }

      // 6b. Money captured for a registration that is already paid or no longer active: record the
      //     capture, leave the registration untouched and alert staff to refund it manually.
      await this.flagCaptureNeedingRefund(tx, payment, paymentId, `webhook:${gatewayEventId}`);

      // 7. Update payment to SUCCESS
      const updatedPayment = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.SUCCESS,
          paymentId: paymentId || payment.paymentId,
          gatewaySignature: signature,
          paidAt: new Date()
        }
      });

      // 8. Record ProcessedWebhookEvent
      await recordEvent();

      // 9. Advance Registration state machine to PAYMENT_VERIFIED
      const currentReg = payment.registration;
      if (canTransitionRegistration(currentReg.status as any, RegistrationStatus.PAYMENT_VERIFIED as any)) {
        await tx.registration.update({
          where: { id: currentReg.id },
          data: { status: RegistrationStatus.PAYMENT_VERIFIED }
        });

        await this.logAuditInTx(tx, {
          action: 'REGISTRATION_STATUS_TRANSITION',
          entityType: 'Registration',
          entityId: currentReg.id,
          beforeState: { status: currentReg.status },
          afterState: {
            status: RegistrationStatus.PAYMENT_VERIFIED,
            trigger: 'WEBHOOK_PAYMENT_SUCCESS',
            gatewayEventId
          }
        });
      }

      // 10. Audit payment verified
      await this.logAuditInTx(tx, {
        action: 'PAYMENT_VERIFIED',
        entityType: 'Payment',
        entityId: payment.id,
        afterState: { orderId, paymentId, amount: payment.amount, status: 'SUCCESS', gatewayEventId }
      });

      return { status: 'ok', gatewayEventId, payment: updatedPayment };
    });
  }

  /**
   * Atomic Payment Success & Registration State Machine Transition
   */
  private async processPaymentSuccess(
    orderId: string,
    paymentId: string,
    signature: string,
    eventRef: string
  ) {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { orderId },
        include: { registration: true }
      });

      if (!payment) {
        throw new NotFoundException(`Order ${orderId} not found in database`);
      }

      if (payment.status === PaymentStatus.SUCCESS) {
        return payment;
      }

      // Defence in depth: a refunded payment is terminal; a late signature check or reconciliation
      // run must never turn it back into SUCCESS.
      if (payment.status === PaymentStatus.REFUNDED) {
        this.logger.warn(`[Payment] Ignoring success for already REFUNDED payment ${payment.id} (${eventRef}).`);
        return payment;
      }

      await this.flagCaptureNeedingRefund(tx, payment, paymentId, eventRef);

      const updatedPayment = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.SUCCESS,
          paymentId,
          gatewaySignature: signature,
          paidAt: new Date()
        }
      });

      const currentReg = payment.registration;
      if (canTransitionRegistration(currentReg.status as any, RegistrationStatus.PAYMENT_VERIFIED as any)) {
        await tx.registration.update({
          where: { id: currentReg.id },
          data: { status: RegistrationStatus.PAYMENT_VERIFIED }
        });

        await this.logAuditInTx(tx, {
          action: 'REGISTRATION_STATUS_TRANSITION',
          entityType: 'Registration',
          entityId: currentReg.id,
          beforeState: { status: currentReg.status },
          afterState: { status: RegistrationStatus.PAYMENT_VERIFIED, trigger: 'PAYMENT_SUCCESS', eventRef }
        });
      }

      await this.logAuditInTx(tx, {
        action: 'PAYMENT_VERIFIED',
        entityType: 'Payment',
        entityId: payment.id,
        afterState: { orderId, paymentId, amount: payment.amount, status: 'SUCCESS' }
      });

      return updatedPayment;
    });
  }

  /**
   * 4. Scheduled Reconciliation Job (with Redis Distributed Lock):
   * - Asks Razorpay about payments pending over 15 minutes
   * - NEVER marks failed without asking Razorpay
   */
  async reconcileStalePayments() {
    const lockToken = await this.acquireRedisLock('lock:reconcile:payments', 60);
    if (!lockToken) {
      this.logger.log('[Reconciliation] Another instance holds the reconciliation lock. Skipping.');
      return { skipped: true, reason: 'Reconciliation lock currently held' };
    }

    try {
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
      const stalePayments = await this.prisma.payment.findMany({
        where: {
          status: PaymentStatus.PENDING,
          createdAt: { lte: fifteenMinutesAgo }
        },
        include: { registration: true },
        orderBy: { createdAt: 'asc' },
        take: RECONCILIATION_BATCH_SIZE
      });

      this.logger.log(`[Reconciliation] Found ${stalePayments.length} pending payments older than 15 minutes.`);
      const results = { reconciled: 0, expired: 0, skipped: 0 };

      for (const payment of stalePayments) {
        try {
          // Ask Razorpay about payments for this order
          const rzpOrderData = await this.callRazorpay(`/orders/${payment.orderId}/payments`);
          const items: any[] = rzpOrderData.items || [];
          // Only 'captured' counts as paid; 'authorized' payments can still be voided / auto-refunded
          const successfulPayment = items.find((p) => p.status === 'captured');
          const expectedPaise = Math.round(payment.amount * 100);

          if (successfulPayment && successfulPayment.amount !== undefined && successfulPayment.amount !== expectedPaise) {
            this.logger.error(
              `[Reconciliation] Captured payment ${successfulPayment.id} for order ${payment.orderId} has amount ${successfulPayment.amount} paise, expected ${expectedPaise}. Skipping for manual review.`
            );
            results.skipped++;
          } else if (successfulPayment) {
            // Found captured payment on gateway -> Reconcile as SUCCESS
            this.logger.log(`[Reconciliation] Reconciling captured payment ${successfulPayment.id} for order ${payment.orderId}`);
            await this.processPaymentSuccess(
              payment.orderId,
              successfulPayment.id,
              'RECONCILIATION_VERIFIED',
              `recon_${successfulPayment.id}`
            );
            results.reconciled++;
          } else if (items.length === 0 || items.every((p) => p.status === 'failed')) {
            // Confirmed with Razorpay that no successful payment exists -> mark as FAILED
            // Conditional update: never overwrite a payment a concurrent webhook just marked SUCCESS
            const { count } = await this.prisma.payment.updateMany({
              where: { id: payment.id, status: PaymentStatus.PENDING },
              data: { status: PaymentStatus.FAILED }
            });
            if (count === 0) {
              results.skipped++;
              continue;
            }
            results.expired++;

            await this.auditService.logAction({
              action: 'PAYMENT_ORDER_EXPIRED',
              entityType: 'Payment',
              entityId: payment.id,
              afterState: {
                status: PaymentStatus.FAILED,
                reason: 'Verified timeout > 15m with no gateway capture'
              }
            });
          } else {
            // Payment might still be in progress on gateway, do not mark failed
            results.skipped++;
          }
        } catch (err: any) {
          // NEVER mark failed if Razorpay query fails
          this.logger.warn(`[Reconciliation] Could not query Razorpay for order ${payment.orderId}: ${err.message}. Skipping.`);
          results.skipped++;
        }
      }

      return results;
    } finally {
      await this.releaseRedisLock('lock:reconcile:payments', lockToken);
    }
  }

  /**
   * 5. Dynamic Invoice PDF Generation:
   * - Uses stored gstRate, baseAmount, gstAmount from payment row (no hard-coded 1.18)
   */
  async generateInvoicePdf(invoiceId: string, userId?: string, userRole?: string): Promise<Buffer> {
    const payment = await this.prisma.payment.findFirst({
      where: {
        OR: [{ id: invoiceId }, { orderId: invoiceId }]
      },
      include: {
        registration: {
          include: {
            team: {
              include: { captain: true }
            },
            category: true
          }
        }
      }
    });

    if (!payment) {
      throw new NotFoundException(`Invoice or payment '${invoiceId}' not found in database`);
    }

    if (userId && userRole) {
      const isOwner = payment.registration?.team?.captainId === userId;
      const isAdmin = userRole === UserRole.SUPER_ADMIN || userRole === UserRole.EVENT_ADMIN;
      if (!isOwner && !isAdmin) {
        throw new ForbiddenException('Forbidden: You can only download invoices for your own team');
      }
    }

    // A tax invoice marked "PAID" must never be issued (and cached) for an unpaid order
    if (payment.status !== PaymentStatus.SUCCESS && payment.status !== PaymentStatus.REFUNDED) {
      throw new BadRequestException(`Invoice is only available for paid orders (current status: ${payment.status})`);
    }

    const totalAmount = payment.amount;
    const gstRate = payment.gstRate ?? 18;
    const baseAmount = payment.baseAmount ?? Number((totalAmount / (1 + gstRate / 100)).toFixed(2));
    const gstAmount = payment.gstAmount ?? Number((totalAmount - baseAmount).toFixed(2));
    const issuedDate = payment.paidAt
      ? payment.paidAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    return this.pdfGeneratorService.generateInvoicePdf({
      invoiceNumber: payment.orderId,
      // The status is part of the PDF cache key: a refund invalidates the cached "PAID" copy
      paymentStatus: payment.status,
      gstRate,
      teamName: payment.registration.team.name,
      teamId: payment.registration.team.code,
      institution: payment.registration.team.institutionName,
      captainName: payment.registration.team.captain.fullName,
      captainEmail: payment.registration.team.captain.email,
      category: payment.registration.category.name,
      amount: totalAmount,
      baseAmount,
      gstAmount,
      paymentRef: payment.paymentId || 'PENDING',
      issuedDate
    });
  }

  /**
   * 6. Refunds:
   * - Call Razorpay refund API
   * - Store refund id, status, reason
   * - Update registration to CANCELLED
   * - Idempotent
   */
  async processRefund(paymentId: string, reason: string, adminUserId?: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { registration: true }
    });

    if (!payment) throw new NotFoundException('Payment not found');

    // Idempotency: return existing refund if already refunded
    if (payment.status === PaymentStatus.REFUNDED) {
      return {
        payment,
        refundId: payment.refundId,
        status: 'already_refunded',
        message: 'Payment has already been refunded'
      };
    }

    if (payment.status !== PaymentStatus.SUCCESS) {
      throw new BadRequestException('Only completed payments can be refunded');
    }

    if (!payment.paymentId) {
      throw new BadRequestException('Payment does not have a gateway payment ID to refund');
    }

    // Atomically claim the payment for this refund before calling the gateway: SUCCESS with no refund
    // in flight -> refundStatus PENDING. A concurrent (double-click / second admin) request finds the
    // claim taken (count 0) and gets 409, so the gateway is never asked to refund twice.
    const claim = await this.prisma.payment.updateMany({
      where: {
        id: payment.id,
        status: PaymentStatus.SUCCESS,
        OR: [{ refundStatus: null }, { refundStatus: REFUND_FAILED }]
      },
      data: { refundStatus: REFUND_IN_PROGRESS, refundReason: reason }
    });
    if (!claim || claim.count === 0) {
      throw new ConflictException('A refund for this payment is already in progress or has been completed.');
    }

    // Call Razorpay Refund API with a stable idempotency key per payment row: a retried request after a
    // timeout is recognised by the gateway instead of creating a second refund.
    const idempotencyKey = `refund_${payment.id}`;
    let rzpRefund: any;
    try {
      rzpRefund = await this.callRazorpay(`/payments/${payment.paymentId}/refund`, {
        method: 'POST',
        headers: { 'X-Idempotency-Key': idempotencyKey },
        body: JSON.stringify({
          amount: Math.round(payment.amount * 100),
          // Razorpay's refund receipt (max 40 characters) doubles as the merchant-side idempotency reference
          receipt: idempotencyKey.slice(0, 40),
          notes: {
            reason,
            adminUserId: adminUserId || 'SUPER_ADMIN'
          }
        })
      });
    } catch (err) {
      // Release the claim so the refund can be retried; the payment stays SUCCESS
      try {
        await this.prisma.payment.updateMany({
          where: { id: payment.id, status: PaymentStatus.SUCCESS, refundStatus: REFUND_IN_PROGRESS },
          data: { refundStatus: REFUND_FAILED }
        });
      } catch (releaseErr: any) {
        this.logger.error(`[Refund] Could not release the refund claim on ${payment.id}: ${releaseErr?.message || releaseErr}`);
      }
      throw err;
    }

    // Update in atomic database transaction
    return this.prisma.$transaction(async (tx) => {
      const updatedPayment = await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.REFUNDED,
          refundId: rzpRefund.id,
          refundStatus: rzpRefund.status || 'processed',
          refundReason: reason,
          refundedAt: new Date()
        }
      });

      // Update registration status to CANCELLED
      await tx.registration.update({
        where: { id: payment.registrationId },
        data: { status: RegistrationStatus.CANCELLED }
      });

      await this.logAuditInTx(tx, {
        actorId: adminUserId,
        actorRole: 'SUPER_ADMIN',
        action: 'PROCESS_PAYMENT_REFUND',
        entityType: 'Payment',
        entityId: paymentId,
        afterState: {
          status: 'REFUNDED',
          refundId: rzpRefund.id,
          amount: payment.amount,
          reason
        }
      });

      return updatedPayment;
    });
  }

  async findByRegistrationId(registrationId: string, userId?: string, userRole?: string) {
    const reg = await this.prisma.registration.findUnique({
      where: { id: registrationId },
      include: { team: true }
    });
    if (!reg) {
      throw new NotFoundException(`Registration '${registrationId}' not found`);
    }

    if (userId && userRole) {
      const isOwner = reg.team.captainId === userId;
      const isAdmin = userRole === UserRole.SUPER_ADMIN || userRole === UserRole.EVENT_ADMIN;
      if (!isOwner && !isAdmin) {
        throw new ForbiddenException('Forbidden: You can only view payments for your own registration');
      }
    }

    return this.prisma.payment.findMany({
      where: { registrationId },
      orderBy: { createdAt: 'desc' },
      take: 100
    });
  }

  async findAllPayments(query?: { limit?: number; offset?: number }) {
    const take = query?.limit ? Math.min(Number(query.limit), 100) : 25;
    const skip = query?.offset ? Number(query.offset) : 0;

    const [total, payments] = await Promise.all([
      this.prisma.payment.count(),
      this.prisma.payment.findMany({
        take,
        skip,
        include: {
          registration: {
            include: {
              team: true,
              category: true
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      })
    ]);

    return { total, payments };
  }
}

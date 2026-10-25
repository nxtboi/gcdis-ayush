import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  Res,
  Request,
  Headers,
  BadRequestException,
  ParseUUIDPipe
} from '@nestjs/common';
import { Response } from 'express';
import { PaymentsService } from './payments.service';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Public } from '../common/decorators/public.decorator';
import { UserRole } from '@gcdis/shared';
import { CreatePaymentOrderDto, VerifyPaymentSignatureDto } from './dto/create-payment-order.dto';
import { RefundPaymentDto } from './dto/refund-payment.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { AllowAudienceRoles, AudienceRolesGuard } from '../auth/audience-roles.guard';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import { StepUpGuard } from '../auth/step-up.guard';
import { AccountIpRateLimiterGuard, RateLimit, SkipDefaultRateLimit } from '../common/guards/rate-limiter.guard';

/** PDF downloads (invoice, member pass): rendering is CPU-heavy, so 10 per minute per user and 30 per IP. */
export const PDF_DOWNLOAD_RATE_LIMIT = Object.freeze({
  points: 10,
  duration: 60,
  ipPoints: 30,
  message: 'Too many PDF downloads. Please wait {wait} before trying again.'
});

/** Payment order creation: 10 per 10 minutes per captain, 30 per IP (each call may reach Razorpay). */
export const CREATE_ORDER_RATE_LIMIT = Object.freeze({
  points: 10,
  duration: 600,
  ipPoints: 30,
  message: 'Too many payment attempts. Please wait {wait} before trying again.'
});

/** Checkout signature verification: 20 per 10 minutes per captain, 60 per IP. */
export const VERIFY_SIGNATURE_RATE_LIMIT = Object.freeze({
  points: 20,
  duration: 600,
  ipPoints: 60,
  message: 'Too many payment verification attempts. Please wait {wait} before trying again.'
});

/** Captains on a portal session, or payment staff on an admin session. */
const CAPTAIN_OR_PAYMENT_STAFF = {
  public: [UserRole.TEAM_CAPTAIN],
  admin: [UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN]
};

@Controller('payments')
export class PaymentsController {
  constructor(private paymentsService: PaymentsService) {}

  @UseGuards(AuthGuard('jwt'), AudienceRolesGuard, AccountIpRateLimiterGuard)
  @AllowAudienceRoles(CAPTAIN_OR_PAYMENT_STAFF)
  @RateLimit({ ...PDF_DOWNLOAD_RATE_LIMIT })
  @Get('invoice/:invoiceId/pdf')
  async downloadInvoicePdf(
    @Request() req: any,
    @Param('invoiceId') invoiceId: string,
    @Res() res: Response
  ) {
    const pdfBuffer = await this.paymentsService.generateInvoicePdf(
      invoiceId,
      req.user.id,
      req.user.role
    );
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="GCDIS-Invoice-${invoiceId}.pdf"`,
      'Content-Length': pdfBuffer.length
    });
    res.end(pdfBuffer);
  }

  // Captain-only action: admin sessions are rejected by RolesGuard (audience separation).
  // A confirmed email is required; EmailVerifiedGuard is listed first because stacked @UseGuards run bottom-up.
  @UseGuards(EmailVerifiedGuard)
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, AccountIpRateLimiterGuard)
  @Roles(UserRole.TEAM_CAPTAIN)
  @RateLimit({ ...CREATE_ORDER_RATE_LIMIT })
  @Post('create-order')
  async createOrder(@Request() req: any, @Body() input: CreatePaymentOrderDto) {
    return this.paymentsService.createOrder(input, req.user.id);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, AccountIpRateLimiterGuard)
  @Roles(UserRole.TEAM_CAPTAIN)
  @RateLimit({ ...VERIFY_SIGNATURE_RATE_LIMIT })
  @Post('verify-signature')
  async verifyPaymentSignature(
    @Request() req: any,
    @Body() body: VerifyPaymentSignatureDto
  ) {
    return this.paymentsService.verifyPaymentSignature(body, req.user.id);
  }

  // No CsrfGuard: Razorpay authenticates with an HMAC signature, not browser cookies
  // Never throttled: Razorpay retries failed deliveries and every retry must be accepted (HMAC-authenticated)
  @Public()
  @SkipDefaultRateLimit()
  @Post('webhook')
  async handleWebhook(
    @Request() req: any,
    @Headers('x-razorpay-signature') signature: string,
    @Headers('x-razorpay-event-id') eventId: string
  ) {
    // HMAC must be computed over the exact bytes Razorpay sent. Re-serialising the parsed
    // JSON changes key order/whitespace and breaks verification, so never fall back to it.
    const rawBody: Buffer | undefined = Buffer.isBuffer(req.rawBody)
      ? req.rawBody
      : Buffer.isBuffer(req.body)
        ? req.body
        : undefined;
    if (!rawBody || rawBody.length === 0) {
      throw new BadRequestException('Missing raw webhook body');
    }
    return this.paymentsService.handleWebhook(rawBody, signature, eventId, req.ip);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Post('reconcile')
  async runReconciliation() {
    return this.paymentsService.reconcileStalePayments();
  }

  // Moves money: requires a recent step-up re-authentication on the staff session (403 STEP_UP_REQUIRED)
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, StepUpGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Post(':id/refund')
  async refundPayment(
    @Request() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RefundPaymentDto
  ) {
    return this.paymentsService.processRefund(id, body?.reason || 'Directorate refund', req.user.id);
  }

  @UseGuards(AuthGuard('jwt'), AudienceRolesGuard)
  @AllowAudienceRoles(CAPTAIN_OR_PAYMENT_STAFF)
  @Get('registration/:registrationId')
  async getByRegistration(
    @Request() req: any,
    @Param('registrationId', new ParseUUIDPipe()) registrationId: string
  ) {
    return this.paymentsService.findByRegistrationId(
      registrationId,
      req.user.id,
      req.user.role
    );
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Get()
  async getAllPayments(@Query() query: PaginationQueryDto) {
    return this.paymentsService.findAllPayments(query);
  }
}

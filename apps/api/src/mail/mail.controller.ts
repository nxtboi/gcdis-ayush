import { Controller, Get, Headers, HttpCode, HttpStatus, Ip, Optional, Post, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@gcdis/shared';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { AccountIpRateLimiterGuard, RateLimit } from '../common/guards/rate-limiter.guard';
import { AuditService } from '../audit/audit.service';
import { MailService } from './mail.service';

/**
 * Outgoing email diagnostics for the staff console (Super Administrator, administrative session).
 * Nothing here returns or logs SMTP credentials.
 */
@Controller('mail')
export class MailController {
  constructor(
    private mail: MailService,
    @Optional() private audit?: AuditService
  ) {}

  /** GET /mail/status: delivery mode and a secret-free summary of the SMTP settings. */
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Get('status')
  status() {
    return this.mail.describeConfig();
  }

  /**
   * POST /mail/test: sends a test message to the signed-in staff member's own address and reports
   * the outcome (200 with ok=false and the provider's error on failure). 5 per 15 minutes.
   */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, AccountIpRateLimiterGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @RateLimit({
    points: 5,
    duration: 900,
    isStrictAuth: false,
    message: 'Several test emails have been sent recently. Please wait {wait} before sending another.'
  })
  @HttpCode(HttpStatus.OK)
  @Post('test')
  async sendTest(@Request() req: any, @Ip() ip: string, @Headers('user-agent') userAgent: string) {
    const to = String(req.user?.email || '').trim();
    const result = await this.mail.sendTest(to, to);
    try {
      await this.audit?.logAction({
        actorId: req.user?.id,
        actorEmail: req.user?.email ?? undefined,
        actorRole: req.user?.role ?? undefined,
        action: 'MAIL_TEST_SENT',
        entityType: 'Mail',
        afterState: {
          ok: result.ok,
          mode: result.mode,
          recipient: to,
          ...(result.error ? { errorCode: result.error.code, responseCode: result.error.responseCode } : {})
        },
        ipAddress: ip,
        userAgent
      });
    } catch {
      // Non-fatal
    }
    return result;
  }
}

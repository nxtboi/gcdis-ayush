import {
  Controller,
  Get,
  Query,
  UseGuards,
  Request,
  Response,
  Ip,
  Headers
} from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '@gcdis/shared';
import { toPrismaPagination, MAX_PAGE_SIZE } from '../common/dto/pagination-query.dto';
import { StepUpGuard } from '../auth/step-up.guard';
import { AccountIpRateLimiterGuard, RateLimit } from '../common/guards/rate-limiter.guard';

@Controller('audit')
export class AuditController {
  constructor(private auditService: AuditService) {}

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Get()
  async getAuditLogs(
    @Query('actorId') actorId?: string,
    @Query('actorRole') actorRole?: string,
    @Query('action') action?: string,
    @Query('entityType') entityType?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string
  ) {
    // Page size is clamped to MAX_PAGE_SIZE; non-numeric values fall back to defaults
    const { take, skip } = toPrismaPagination({ limit, offset }, 50, MAX_PAGE_SIZE);
    return this.auditService.findAllLogs({
      actorId,
      actorRole,
      action,
      entityType,
      startDate,
      endDate,
      search,
      limit: take,
      offset: skip
    });
  }

  /** Bulk export of the audit trail (personal data of every actor): requires a recent step-up. */
  @UseGuards(AuthGuard('jwt'), RolesGuard, StepUpGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Get('export')
  async exportCsv(@Response() res: any, @Query() query: any) {
    const filters = {
      actorId: typeof query?.actorId === 'string' ? query.actorId : undefined,
      actorRole: typeof query?.actorRole === 'string' ? query.actorRole : undefined,
      action: typeof query?.action === 'string' ? query.action : undefined,
      entityType: typeof query?.entityType === 'string' ? query.entityType : undefined,
      entityId: typeof query?.entityId === 'string' ? query.entityId : undefined,
      startDate: typeof query?.startDate === 'string' ? query.startDate : undefined,
      endDate: typeof query?.endDate === 'string' ? query.endDate : undefined,
      search: typeof query?.search === 'string' ? query.search : undefined
    };
    const csv = await this.auditService.exportLogsCsv(filters);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=gcdis-audit-${Date.now()}.csv`);
    return res.send(csv);
  }

  /**
   * Verifies the tamper-evidence hash chain of the audit log and reports the first broken link
   * (Super Administrator; 5 per minute). The verification is itself audited.
   */
  @UseGuards(AuthGuard('jwt'), RolesGuard, AccountIpRateLimiterGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @RateLimit({ points: 5, duration: 60, isStrictAuth: false, message: 'The audit chain was verified recently. Please wait {wait}.' })
  @Get('verify-chain')
  async verifyChain(@Request() req: any, @Ip() ip: string, @Headers('user-agent') userAgent?: string) {
    return this.auditService.verifyChain(req.user, ip, userAgent);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Get('security-alerts')
  async getSecurityAlerts() {
    return this.auditService.getSecurityAlerts();
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('my-activity')
  async getMyActivity(@Request() req: any) {
    return this.auditService.findCaptainActivity(req.user.id);
  }
}

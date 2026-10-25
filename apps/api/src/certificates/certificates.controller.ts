import { Controller, Get, Post, Param, Body, Query, UseGuards, Res, Request, ParseUUIDPipe } from '@nestjs/common';
import { Response } from 'express';
import { CertificatesService } from './certificates.service';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Public } from '../common/decorators/public.decorator';
import { UserRole } from '@gcdis/shared';
import { GenerateCertificateDto } from './dto/generate-certificate.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { AllowAudienceRoles, AudienceRolesGuard } from '../auth/audience-roles.guard';
import { AccountIpRateLimiterGuard, RateLimit } from '../common/guards/rate-limiter.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { PDF_DOWNLOAD_RATE_LIMIT } from '../payments/payments.controller';

/** Public certificate verification: 30 lookups per minute per client IP (blocks code enumeration). */
export const CERTIFICATE_VERIFY_RATE_LIMIT = Object.freeze({
  points: 30,
  duration: 60,
  ipPoints: 30,
  message: 'Too many verification requests. Please wait {wait} before trying again.'
});

@Controller('certificates')
export class CertificatesController {
  constructor(private certificatesService: CertificatesService) {}

  @UseGuards(AuthGuard('jwt'), AudienceRolesGuard, AccountIpRateLimiterGuard)
  @AllowAudienceRoles({ public: [UserRole.TEAM_CAPTAIN], admin: [UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN, UserRole.INSPECTOR] })
  @RateLimit({ ...PDF_DOWNLOAD_RATE_LIMIT })
  @Get('pass/:memberId/pdf')
  async downloadPassPdf(
    @Request() req: any,
    @Param('memberId', new ParseUUIDPipe()) memberId: string,
    @Res() res: Response
  ) {
    const pdfBuffer = await this.certificatesService.generateMemberPassPdf(
      memberId,
      req.user.id,
      req.user.role
    );
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="Pass-${memberId}.pdf"`,
      'Content-Length': pdfBuffer.length
    });
    res.end(pdfBuffer);
  }

  @Public()
  @UseGuards(AccountIpRateLimiterGuard)
  @RateLimit({ ...CERTIFICATE_VERIFY_RATE_LIMIT })
  @Get('verify/:code')
  async verifyCode(@Param('code') code: string) {
    return this.certificatesService.verifyCode(code);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Get()
  async getAllCertificates(@Query() query: PaginationQueryDto) {
    return this.certificatesService.findAll(query);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Post('generate')
  async generateCertificate(
    @Body() body: GenerateCertificateDto
  ) {
    return this.certificatesService.generateCertificate(body);
  }
}

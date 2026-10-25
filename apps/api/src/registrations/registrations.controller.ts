import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  Request, ParseUUIDPipe } from '@nestjs/common';
import { RegistrationsService } from './registrations.service';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '@gcdis/shared';
import { CreateRegistrationDto } from './dto/create-registration.dto';
import { TransitionStatusDto } from './dto/transition-status.dto';
import { AddDocumentDto } from './dto/add-document.dto';
import { VerifyDocumentDto } from './dto/verify-document.dto';
import { RegistrationQueryDto } from './dto/registration-query.dto';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import { AllowAudienceRoles, AudienceRolesGuard } from '../auth/audience-roles.guard';
import { AccountIpRateLimiterGuard, RateLimit } from '../common/guards/rate-limiter.guard';

/** Registration creation: 10 per 10 minutes per captain, 30 per IP. */
export const REGISTRATION_CREATE_RATE_LIMIT = Object.freeze({
  points: 10,
  duration: 600,
  ipPoints: 30,
  message: 'Too many registration attempts. Please wait {wait} before trying again.'
});

/** Document linking by captains: 30 per 10 minutes per captain, 90 per IP. */
export const REGISTRATION_DOCUMENT_RATE_LIMIT = Object.freeze({
  points: 30,
  duration: 600,
  ipPoints: 90,
  message: 'Too many document submissions. Please wait {wait} before trying again.'
});

/**
 * Status transitions and document reviews (mostly staff working through a queue): 120 per 10 minutes per
 * user on each route, 300 per IP. Generous for a review session, but caps scripted abuse of a stolen session.
 */
export const REGISTRATION_REVIEW_RATE_LIMIT = Object.freeze({
  points: 120,
  duration: 600,
  ipPoints: 300,
  message: 'Too many registration updates. Please wait {wait} before trying again.'
});

/**
 * Who may read registrations: a team captain on a portal session (filtered to their own team by the
 * service) or administrative / technical-inspection staff on an admin session. JUDGE (and any other
 * role) is deliberately excluded: judges handle scoring only and have no reason to read the personal
 * data of every registered team. INSPECTOR is included because the scrutineering workflow lists the
 * registrations awaiting technical inspection.
 */
const REGISTRATION_READERS = {
  public: [UserRole.TEAM_CAPTAIN],
  admin: [UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN, UserRole.INSPECTOR]
};

@Controller('registrations')
export class RegistrationsController {
  constructor(private registrationsService: RegistrationsService) {}

  @UseGuards(AuthGuard('jwt'), AudienceRolesGuard)
  @AllowAudienceRoles(REGISTRATION_READERS)
  @Get()
  async getAllRegistrations(
    @Request() req: any,
    @Query() query: RegistrationQueryDto
  ) {
    return this.registrationsService.findAll(query, req.user.id, req.user.role);
  }

  @UseGuards(AuthGuard('jwt'), AudienceRolesGuard)
  @AllowAudienceRoles(REGISTRATION_READERS)
  @Get(':id')
  async getRegistrationById(
    @Request() req: any,
    @Param('id') id: string
  ) {
    return this.registrationsService.findDetailById(id, req.user.id, req.user.role);
  }

  /** Captain-only: register the caller's own team in its own category. Requires a confirmed email. */
  // Listed above the session guards on purpose: stacked @UseGuards run bottom-up, so this runs after them.
  @UseGuards(EmailVerifiedGuard)
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, AccountIpRateLimiterGuard)
  @Roles(UserRole.TEAM_CAPTAIN)
  @RateLimit({ ...REGISTRATION_CREATE_RATE_LIMIT })
  @Post()
  async createRegistration(
    @Request() req: any,
    @Body() body: CreateRegistrationDto
  ) {
    return this.registrationsService.createRegistration(
      body.teamId,
      body.categoryId,
      req.user.id,
      req.user.role,
      req.user.email,
      req.ip,
      req.headers?.['user-agent']
    );
  }

  // The state machine also limits each role to its own transitions (isRoleAuthorizedForTransition)
  @UseGuards(AuthGuard('jwt'), AudienceRolesGuard, CsrfGuard, AccountIpRateLimiterGuard)
  @AllowAudienceRoles(REGISTRATION_READERS)
  @RateLimit({ ...REGISTRATION_REVIEW_RATE_LIMIT })
  @Patch(':id/status')
  async transitionStatus(
    @Request() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: TransitionStatusDto
  ) {
    return this.registrationsService.transitionStatus(
      id,
      body.targetStatus,
      req.user.role,
      req.user.id,
      req.user.email,
      body.reason,
      req.ip,
      req.headers?.['user-agent']
    );
  }

  /** Captain-only: link a file the captain uploaded to their own registration. */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, AccountIpRateLimiterGuard)
  @Roles(UserRole.TEAM_CAPTAIN)
  @RateLimit({ ...REGISTRATION_DOCUMENT_RATE_LIMIT })
  @Post(':id/documents')
  async addDocument(
    @Request() req: any,
    @Param('id') id: string,
    @Body() body: AddDocumentDto
  ) {
    return this.registrationsService.addDocument(
      id,
      body.type,
      body.assetId,
      req.user.id,
      req.user.role,
      req.user.email,
      body.fileName,
      req.ip,
      req.headers?.['user-agent']
    );
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, AccountIpRateLimiterGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @RateLimit({ ...REGISTRATION_REVIEW_RATE_LIMIT })
  @Patch(':id/documents/:docId')
  async verifyDocument(
    @Request() req: any,
    @Param('id') id: string,
    @Param('docId') docId: string,
    @Body() body: VerifyDocumentDto
  ) {
    return this.registrationsService.verifyDocument(
      id,
      docId,
      body.status,
      req.user.id,
      req.user.role,
      req.user.email,
      body.feedback,
      req.ip,
      req.headers?.['user-agent']
    );
  }
}

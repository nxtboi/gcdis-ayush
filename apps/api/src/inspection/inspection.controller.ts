import { Controller, Get, Post, Param, Body, Query, UseGuards, Request, ParseUUIDPipe } from '@nestjs/common';
import { InspectionService } from './inspection.service';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '@gcdis/shared';
import { SubmitInspectionDto } from './dto/submit-inspection.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { AllowAudienceRoles, AudienceRolesGuard } from '../auth/audience-roles.guard';

@Controller('inspections')
export class InspectionController {
  constructor(private inspectionService: InspectionService) {}

  @UseGuards(AuthGuard('jwt'), AudienceRolesGuard)
  @AllowAudienceRoles({ public: [UserRole.TEAM_CAPTAIN], admin: [UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN, UserRole.INSPECTOR] })
  @Get('registration/:registrationId')
  async getByRegistration(@Request() req: any, @Param('registrationId', new ParseUUIDPipe()) registrationId: string) {
    return this.inspectionService.findByRegistrationId(registrationId, req.user.id, req.user.role);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN, UserRole.INSPECTOR)
  @Get()
  async getAllInspections(@Query() query: PaginationQueryDto) {
    return this.inspectionService.findAllInspections(query);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN, UserRole.INSPECTOR)
  @Post()
  async recordInspection(@Request() req: any, @Body() input: SubmitInspectionDto) {
    return this.inspectionService.recordInspection(
      req.user.id,
      req.user.fullName || 'Technical Inspector',
      input,
      req.user.role,
      req.user.email
    );
  }
}

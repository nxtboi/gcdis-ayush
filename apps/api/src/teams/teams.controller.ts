import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  Param,
  Body,
  UseGuards,
  Request,
  Query
} from '@nestjs/common';
import { TeamsService } from './teams.service';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Public } from '../common/decorators/public.decorator';
import { UserRole } from '@gcdis/shared';
import { CreateTeamDto, TeamMemberDto, UpdateTeamMemberDto } from './dto/create-team.dto';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { PaginationQueryDto, toPrismaPagination } from '../common/dto/pagination-query.dto';
import { AccountIpRateLimiterGuard, RateLimit } from '../common/guards/rate-limiter.guard';

/** Team / roster mutations: 30 per 10 minutes per captain on each route, 90 per IP. */
export const TEAM_MUTATION_RATE_LIMIT = Object.freeze({
  points: 30,
  duration: 600,
  ipPoints: 90,
  message: 'Too many team changes. Please wait {wait} before trying again.'
});

@Controller('teams')
export class TeamsController {
  constructor(private teamsService: TeamsService) {}

  @Public()
  @Get('public')
  async getPublicTeams(@Query() pagination: PaginationQueryDto) {
    return this.teamsService.findPublicTeams(toPrismaPagination(pagination, 100));
  }

  /** Captain-only: the caller's own team (null when none has been created yet). */
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.TEAM_CAPTAIN)
  @Get('my-team')
  async getMyTeam(@Request() req: any) {
    return this.teamsService.findCaptainTeam(req.user.id);
  }

  @Public()
  @Get('category/:categoryId')
  async getTeamsByCategory(
    @Param('categoryId') categoryId: string,
    @Query() pagination: PaginationQueryDto
  ) {
    return this.teamsService.findTeamsByCategory(categoryId, toPrismaPagination(pagination, 100));
  }

  /** Public detail of approved teams; the owning captain and staff get the full record. */
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':id')
  async getTeamById(@Param('id') id: string, @Request() req: any) {
    return this.teamsService.findById(id, req.user || null);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Get()
  async getAllTeams(@Query() pagination: PaginationQueryDto) {
    return this.teamsService.findAllTeams(toPrismaPagination(pagination, 100));
  }

  /** Captain-only: create the caller's team. Members are optional; the captain is added automatically. */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, AccountIpRateLimiterGuard)
  @Roles(UserRole.TEAM_CAPTAIN)
  @RateLimit({ ...TEAM_MUTATION_RATE_LIMIT })
  @Post()
  async createTeam(@Request() req: any, @Body() input: CreateTeamDto) {
    return this.teamsService.createTeam(req.user.id, input);
  }

  /** Captain-only: add a member to the caller's own team (at most 7 members, 3 coaches). */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, AccountIpRateLimiterGuard)
  @Roles(UserRole.TEAM_CAPTAIN)
  @RateLimit({ ...TEAM_MUTATION_RATE_LIMIT })
  @Post(':id/members')
  async addMember(@Request() req: any, @Param('id') id: string, @Body() input: TeamMemberDto) {
    return this.teamsService.addMember(req.user.id, id, input);
  }

  /** Captain-only: edit a member of the caller's own team. */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, AccountIpRateLimiterGuard)
  @Roles(UserRole.TEAM_CAPTAIN)
  @RateLimit({ ...TEAM_MUTATION_RATE_LIMIT })
  @Patch(':id/members/:memberId')
  async updateMember(
    @Request() req: any,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Body() input: UpdateTeamMemberDto
  ) {
    return this.teamsService.updateMember(req.user.id, id, memberId, input);
  }

  /**
   * Captain-only: remove a member from the caller's own team. The captain's own row cannot be removed,
   * and the roster is final once the registration has been approved (409).
   */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, AccountIpRateLimiterGuard)
  @Roles(UserRole.TEAM_CAPTAIN)
  @RateLimit({ ...TEAM_MUTATION_RATE_LIMIT })
  @Delete(':id/members/:memberId')
  @HttpCode(HttpStatus.OK)
  async removeMember(
    @Request() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('memberId', new ParseUUIDPipe()) memberId: string
  ) {
    return this.teamsService.removeMember(
      { id: req.user.id, email: req.user.email, role: req.user.role },
      id,
      memberId,
      { ip: req.ip, userAgent: req.headers?.['user-agent'] }
    );
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Post(':id/approve-public')
  async approveForPublic(@Param('id') id: string) {
    return this.teamsService.approveForPublic(id);
  }
}

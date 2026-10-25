import { Controller, Get, Post, Patch, Param, Body, UseGuards, Request, Res, ParseUUIDPipe } from '@nestjs/common';
import { z } from 'zod';
import { CompetitionService } from './competition.service';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Public } from '../common/decorators/public.decorator';
import { UserRole, MatchStatus, MatchEventType, MatchEventLogInput } from '@gcdis/shared';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { parseBody } from '../common/utils/validate-body.util';

/** Score events are whole numbers; a single correction may not exceed ten goals either way. */
const scoreDelta = z.number().int().min(-10).max(10).default(1);

/** Body of POST /competition/fixtures/:id/event (the fixture comes from the URL). */
export const FixtureEventSchema = z.object({
  teamId: z.string().uuid(),
  eventType: z.nativeEnum(MatchEventType),
  scoreDelta,
  notes: z.string().trim().max(500).optional()
});

/** Body of POST /competition/fixtures/log-event (legacy route: the fixture is in the body). */
export const LogEventSchema = FixtureEventSchema.extend({ fixtureId: z.string().uuid() });

export const MatchStatusSchema = z.object({ targetStatus: z.nativeEnum(MatchStatus) });

@Controller('competition')
export class CompetitionController {
  constructor(private competitionService: CompetitionService) {}

  @Public()
  @Get('arenas')
  async getArenas() {
    return this.competitionService.findAllArenas();
  }

  @Public()
  @Get('fixtures')
  async getAllFixtures() {
    return this.competitionService.findAllFixtures();
  }

  @Public()
  @Get('fixtures/category/:categoryId')
  async getFixturesByCategory(@Param('categoryId', new ParseUUIDPipe()) categoryId: string) {
    return this.competitionService.findFixturesByCategory(categoryId);
  }

  @Public()
  @Get('fixtures/:id')
  async getFixtureById(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.competitionService.findFixtureById(id);
  }

  /**
   * High-Reliability Live Scoring Polling Fallback (For firewalls blocking WebSockets)
   */
  @Public()
  @Get('fixtures/:id/live-polling')
  async getFixtureLivePolling(@Param('id', new ParseUUIDPipe()) id: string, @Res({ passthrough: true }) res: any) {
    res.setHeader('Cache-Control', 'public, max-age=2, stale-while-revalidate=1');
    const fixture = await this.competitionService.findFixtureById(id);
    return {
      fixture,
      polledAt: new Date().toISOString(),
      pollingIntervalMs: 3000
    };
  }

  @Public()
  @Get('rankings/category/:categoryId')
  async getRankings(@Param('categoryId', new ParseUUIDPipe()) categoryId: string) {
    return this.competitionService.getRankingsByCategory(categoryId);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN, UserRole.JUDGE)
  @Patch('fixtures/:id/status')
  async transitionStatus(@Param('id', new ParseUUIDPipe()) id: string, @Body() rawBody: unknown) {
    const { targetStatus } = parseBody(MatchStatusSchema, rawBody) as { targetStatus: MatchStatus };
    return this.competitionService.transitionMatchStatus(id, targetStatus);
  }

  /** Records a score event for the fixture in the URL (used by the staff console). */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN, UserRole.JUDGE)
  @Post('fixtures/:id/event')
  async recordFixtureEvent(
    @Request() req: any,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() rawBody: unknown
  ) {
    const input = parseBody(FixtureEventSchema, rawBody);
    return this.competitionService.logMatchEvent({ ...input, fixtureId: id } as MatchEventLogInput, req.user.fullName || 'Authorised Judge');
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN, UserRole.JUDGE)
  @Post('fixtures/log-event')
  async logMatchEvent(@Request() req: any, @Body() rawBody: unknown) {
    const input = parseBody(LogEventSchema, rawBody);
    return this.competitionService.logMatchEvent(input as MatchEventLogInput, req.user.fullName || 'Authorised Judge');
  }
}

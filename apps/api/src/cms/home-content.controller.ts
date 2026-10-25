import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Request, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@gcdis/shared';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { StepUpGuard, hasRecentStepUp } from '../auth/step-up.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { Public } from '../common/decorators/public.decorator';
import { ContentActor } from './site-content.service';
import { HomeContentService } from './home-content.service';

const PUBLIC_CACHE = 'public, max-age=30, s-maxage=60, stale-while-revalidate=60';

function actorOf(req: any): ContentActor {
  return {
    id: req?.user?.id,
    email: req?.user?.email,
    role: req?.user?.role,
    ipAddress: req?.ip,
    userAgent: typeof req?.headers?.['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 500) : undefined
  };
}

/**
 * Home page sections (enable flag, order and content of every section of the public home page).
 * Guarded exactly like the site-content admin routes: staff session (admin audience enforced by
 * RolesGuard), SUPER_ADMIN / EVENT_ADMIN, CSRF guard on writes, audit entry for every write, StepUpGuard on
 * the destructive reset; the global rate limit applies. Bodies are validated with strict zod schemas.
 */
@Controller('cms')
export class HomeContentController {
  constructor(private homeContent: HomeContentService) {}

  // ---------------------------------------------------------------- Public

  /** Enabled sections in page order; sample entries are removed in production. */
  @Public()
  @Get('public/home')
  async getPublicHome(@Res({ passthrough: true }) res: any) {
    res?.setHeader?.('Cache-Control', PUBLIC_CACHE);
    return this.homeContent.getPublicHome();
  }

  // ---------------------------------------------------------------- Admin

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Get('admin/home/sections')
  async listSections() {
    return this.homeContent.listSections();
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Put('admin/home/sections/order')
  async reorderSections(@Body() body: unknown, @Request() req: any) {
    return this.homeContent.reorderSections(body, actorOf(req));
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Get('admin/home/sections/:key')
  async getSection(@Param('key') key: string) {
    return this.homeContent.getSection(key);
  }

  /**
   * { enabled?: boolean, content?: object }: toggles the section and / or replaces its content. Replacing or
   * removing a video the section already shows needs a recent step-up (answered with STEP_UP_REQUIRED otherwise).
   */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Patch('admin/home/sections/:key')
  async updateSection(@Param('key') key: string, @Body() body: unknown, @Request() req: any) {
    return this.homeContent.updateSection(key, body, actorOf(req), hasRecentStepUp(req?.user));
  }

  /** Restores the default content of one section (step-up confirmation required). */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, StepUpGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('admin/home/sections/:key/reset')
  async resetSection(@Param('key') key: string, @Request() req: any) {
    return this.homeContent.resetSection(key, actorOf(req));
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Request,
  Res,
  UseGuards
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@gcdis/shared';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { StepUpGuard, hasRecentStepUp } from '../auth/step-up.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { Public } from '../common/decorators/public.decorator';
import { ContentActor } from './site-content.service';
import { ChampionshipMediaService } from './championship-media.service';

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
 * Championship page media: hero background video, poster image and the drone / arena photo gallery.
 * Guarded exactly like the site-content admin routes: staff session (admin audience enforced by RolesGuard),
 * SUPER_ADMIN / EVENT_ADMIN, CSRF guard on writes, audit entry for every write. Deleting a photo and removing the
 * video or poster require a step-up (StepUpGuard); replacing an existing video or poster through PUT .../hero
 * requires one too (checked in the service, same STEP_UP_REQUIRED answer). Bodies are validated with strict zod
 * schemas (dto/championship-media.schema.ts).
 */
@Controller('cms')
export class ChampionshipMediaController {
  constructor(private media: ChampionshipMediaService) {}

  // ---------------------------------------------------------------- Public

  /**
   * { heroVideoUrl, heroPosterUrl, gallery: published photos in staff order, sections: section / item media };
   * nulls, [] and {} when nothing is set.
   */
  @Public()
  @Get('public/championship-media')
  async getPublicChampionshipMedia(@Res({ passthrough: true }) res: any) {
    res?.setHeader?.('Cache-Control', PUBLIC_CACHE);
    return this.media.getPublic();
  }

  // ---------------------------------------------------------------- Admin

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Get('admin/championship-media')
  async getChampionshipMedia() {
    return this.media.getAdmin();
  }

  /** { heroVideoUrl?, heroPosterUrl? }: sets either; replacing or removing an existing one needs a step-up. */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Put('admin/championship-media/hero')
  async updateChampionshipHero(@Body() body: unknown, @Request() req: any) {
    return this.media.updateHero(body, actorOf(req), hasRecentStepUp(req?.user));
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, StepUpGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Delete('admin/championship-media/hero/video')
  async removeChampionshipHeroVideo(@Request() req: any) {
    return this.media.clearHero('video', actorOf(req));
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, StepUpGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Delete('admin/championship-media/hero/poster')
  async removeChampionshipHeroPoster(@Request() req: any) {
    return this.media.clearHero('poster', actorOf(req));
  }

  // ---------------------------------------------------------------- Section and item media
  // :key, :item and :field are checked against whitelists in the service (unknown values are a 404).

  /** { imageUrl?, videoUrl?, imageAlt? } for a section; replacing or removing an existing file needs a step-up. */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Put('admin/championship-media/sections/:key')
  async updateChampionshipSectionMedia(@Param('key') key: string, @Body() body: unknown, @Request() req: any) {
    return this.media.updateSectionMedia(key, null, body, actorOf(req), hasRecentStepUp(req?.user));
  }

  /** { imageUrl?, videoUrl?, imageAlt? } for an item of a section (e.g. categories / d20, programme / day1). */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Put('admin/championship-media/sections/:key/items/:item')
  async updateChampionshipSectionItemMedia(
    @Param('key') key: string,
    @Param('item') item: string,
    @Body() body: unknown,
    @Request() req: any
  ) {
    return this.media.updateSectionMedia(key, item, body, actorOf(req), hasRecentStepUp(req?.user));
  }

  /** :field is image or video. */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, StepUpGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Delete('admin/championship-media/sections/:key/:field')
  async removeChampionshipSectionMedia(@Param('key') key: string, @Param('field') field: string, @Request() req: any) {
    return this.media.clearSectionMedia(key, null, field, actorOf(req));
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, StepUpGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Delete('admin/championship-media/sections/:key/items/:item/:field')
  async removeChampionshipSectionItemMedia(
    @Param('key') key: string,
    @Param('item') item: string,
    @Param('field') field: string,
    @Request() req: any
  ) {
    return this.media.clearSectionMedia(key, item, field, actorOf(req));
  }

  // ---------------------------------------------------------------- Gallery

  /** { imageUrl, kind, caption?, published? }: adds one photo at the end of the gallery. */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Post('admin/championship-media/gallery')
  async addChampionshipGalleryItem(@Body() body: unknown, @Request() req: any) {
    return this.media.addGalleryItem(body, actorOf(req));
  }

  /** { ids }: listed photos first, in the given order; the rest keep their relative order. */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Put('admin/championship-media/gallery/order')
  async reorderChampionshipGallery(@Body() body: unknown, @Request() req: any) {
    return this.media.reorderGallery(body, actorOf(req));
  }

  /** { caption?, kind?, published? } */
  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Patch('admin/championship-media/gallery/:id')
  async updateChampionshipGalleryItem(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @Request() req: any
  ) {
    return this.media.updateGalleryItem(id, body, actorOf(req));
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, StepUpGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Delete('admin/championship-media/gallery/:id')
  async deleteChampionshipGalleryItem(@Param('id', new ParseUUIDPipe()) id: string, @Request() req: any) {
    return this.media.deleteGalleryItem(id, actorOf(req));
  }
}

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
  Query,
  Request,
  Res,
  UseGuards
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@gcdis/shared';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { StepUpGuard } from '../auth/step-up.guard';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { Public } from '../common/decorators/public.decorator';
import { ContentActor, SiteContentService } from './site-content.service';
import {
  CreateGalleryImageDto,
  CreateSponsorDto,
  GallerySectionDto,
  ReorderDto,
  SiteInfoDto,
  SponsorsSectionDto,
  UpdateGalleryImageDto,
  UpdateSponsorDto
} from './dto/site-content.dto';

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
 * Sponsors, gallery and site information.
 * Admin routes: staff session (admin audience enforced by RolesGuard), SUPER_ADMIN / EVENT_ADMIN,
 * CSRF guard on writes, audit entry for every write, StepUpGuard on destructive / sensitive writes.
 */
@Controller('cms')
export class SiteContentController {
  constructor(private siteContent: SiteContentService) {}

  // ---------------------------------------------------------------- Public

  @Public()
  @Get('public/site')
  async getPublicSite(@Res({ passthrough: true }) res: any) {
    res?.setHeader?.('Cache-Control', PUBLIC_CACHE);
    return this.siteContent.getPublicSite();
  }

  /** Active sponsors; ?placement=HOME|EVENT|FOOTER limits to one placement. */
  @Public()
  @Get('sponsors')
  async getSponsors(@Query('placement') placement: string | undefined, @Res({ passthrough: true }) res: any) {
    res?.setHeader?.('Cache-Control', 'public, max-age=60, s-maxage=120, stale-while-revalidate=120');
    return this.siteContent.getPublicSponsors(typeof placement === 'string' ? placement : undefined);
  }

  @Public()
  @Get('gallery')
  async getGallery(@Res({ passthrough: true }) res: any) {
    res?.setHeader?.('Cache-Control', PUBLIC_CACHE);
    return this.siteContent.getPublicGallery();
  }

  // ---------------------------------------------------------------- Admin: settings

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Get('admin/settings/site-info')
  async getSiteInfo() {
    return this.siteContent.getSiteInfo();
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, StepUpGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Put('admin/settings/site-info')
  async saveSiteInfo(@Body() dto: SiteInfoDto, @Request() req: any) {
    return this.siteContent.saveSiteInfo(dto, actorOf(req));
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Get('admin/settings/sponsors-section')
  async getSponsorsSection() {
    return this.siteContent.getSponsorsSection();
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Put('admin/settings/sponsors-section')
  async saveSponsorsSection(@Body() dto: SponsorsSectionDto, @Request() req: any) {
    return this.siteContent.saveSponsorsSection(dto, actorOf(req));
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Get('admin/settings/gallery-section')
  async getGallerySection() {
    return this.siteContent.getGallerySection();
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Put('admin/settings/gallery-section')
  async saveGallerySection(@Body() dto: GallerySectionDto, @Request() req: any) {
    return this.siteContent.saveGallerySection(dto, actorOf(req));
  }

  // ---------------------------------------------------------------- Admin: sponsors

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Get('admin/sponsors')
  async listSponsors() {
    return this.siteContent.listSponsors();
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Post('admin/sponsors')
  async createSponsor(@Body() dto: CreateSponsorDto, @Request() req: any) {
    return this.siteContent.createSponsor(dto, actorOf(req));
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Put('admin/sponsors/order')
  async reorderSponsors(@Body() dto: ReorderDto, @Request() req: any) {
    return this.siteContent.reorderSponsors(dto.ids, actorOf(req));
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Patch('admin/sponsors/:id')
  async updateSponsor(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSponsorDto,
    @Request() req: any
  ) {
    return this.siteContent.updateSponsor(id, dto, actorOf(req));
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, StepUpGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Delete('admin/sponsors/:id')
  async deleteSponsor(@Param('id', new ParseUUIDPipe()) id: string, @Request() req: any) {
    return this.siteContent.deleteSponsor(id, actorOf(req));
  }

  // ---------------------------------------------------------------- Admin: gallery

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Get('admin/gallery')
  async listGallery() {
    return this.siteContent.listGallery();
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Post('admin/gallery')
  async createGalleryImage(@Body() dto: CreateGalleryImageDto, @Request() req: any) {
    return this.siteContent.createGalleryImage(dto, actorOf(req));
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Put('admin/gallery/order')
  async reorderGallery(@Body() dto: ReorderDto, @Request() req: any) {
    return this.siteContent.reorderGallery(dto.ids, actorOf(req));
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Patch('admin/gallery/:id')
  async updateGalleryImage(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateGalleryImageDto,
    @Request() req: any
  ) {
    return this.siteContent.updateGalleryImage(id, dto, actorOf(req));
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard, StepUpGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Delete('admin/gallery/:id')
  async deleteGalleryImage(@Param('id', new ParseUUIDPipe()) id: string, @Request() req: any) {
    return this.siteContent.deleteGalleryImage(id, actorOf(req));
  }
}

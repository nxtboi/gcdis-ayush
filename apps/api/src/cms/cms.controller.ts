import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  Request,
  Res,
  Query,
  ParseUUIDPipe
} from '@nestjs/common';
import { z } from 'zod';
import { CMSService } from './cms.service';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '@gcdis/shared';
import { Public } from '../common/decorators/public.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { parseBody } from '../common/utils/validate-body.util';
import { PaginationQueryDto, toPrismaPagination } from '../common/dto/pagination-query.dto';

const SECTION_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const SaveDraftSchema = z.object({
  title: z.string().trim().min(1, 'title is required').max(300),
  subtitle: z.string().max(500).optional(),
  data: z.record(z.any())
});

const PublishSchema = z.object({
  changeNote: z.string().max(500).optional()
});

const MediaAssetSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileUrl: z.string().min(1).max(2048),
  mimeType: z.string().min(1).max(100),
  sizeBytes: z.number().int().nonnegative(),
  altText: z.string().max(500)
});

function assertSectionKey(key: string): void {
  if (typeof key !== 'string' || !SECTION_KEY.test(key)) {
    throw new BadRequestException('Invalid section key');
  }
}

@Controller('cms')
export class CMSController {
  constructor(private cmsService: CMSService) {}

  // --- Public Read Surface with CDN & Edge Short-TTL Caching ---

  @Public()
  @Get('section/:key')
  async getPublicSection(
    @Param('key') key: string,
    @Res({ passthrough: true }) res: any
  ) {
    if (res?.setHeader) {
      res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=120, stale-while-revalidate=60');
    }
    assertSectionKey(key);
    return this.cmsService.getPublicSection(key);
  }

  @Public()
  @Get('prizes')
  async getPrizes(@Res({ passthrough: true }) res: any) {
    if (res?.setHeader) {
      res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=120, stale-while-revalidate=60');
    }
    return this.cmsService.getPrizes();
  }

  // GET /cms/sponsors, /cms/gallery and /cms/public/site are served by SiteContentController

  // --- Admin CMS Surface (Guarded) ---

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Get('admin/sections')
  async getAllSections() {
    return this.cmsService.getAllSections();
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Post('admin/section/:key/draft')
  async saveDraft(
    @Param('key') key: string,
    @Body() rawBody: unknown,
    @Request() req: any
  ) {
    assertSectionKey(key);
    const body = parseBody(SaveDraftSchema, rawBody);
    return this.cmsService.saveSectionDraft(
      key,
      body.data,
      body.title,
      body.subtitle,
      req.user.id,
      req.user.email,
      req.user.role
    );
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Post('admin/section/:key/publish')
  async publishSection(
    @Param('key') key: string,
    @Body() rawBody: unknown,
    @Request() req: any
  ) {
    assertSectionKey(key);
    const body = parseBody(PublishSchema, rawBody);
    return this.cmsService.publishSection(key, body.changeNote, req.user.id, req.user.email, req.user.role);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Post('admin/section/:key/rollback/:version')
  async rollbackSection(
    @Param('key') key: string,
    @Param('version') version: string,
    @Request() req: any
  ) {
    assertSectionKey(key);
    if (!/^\d{1,9}$/.test(version)) {
      throw new BadRequestException('Version must be a positive integer');
    }
    return this.cmsService.rollbackSection(key, Number(version), req.user.id, req.user.email, req.user.role);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Get('admin/section/:key/versions')
  async getVersions(@Param('key') key: string) {
    return this.cmsService.getSectionVersions(key);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Patch('admin/prize/:id')
  async updatePrize(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @Request() req: any
  ) {
    // Field whitelist + type checks happen in CMSService.validatePrizeUpdate
    return this.cmsService.updatePrize(id, body as Parameters<CMSService['updatePrize']>[1], req.user.id, req.user.email, req.user.role);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Get('admin/checklist')
  async getOperationalChecklist() {
    return this.cmsService.getOperationalChecklist();
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard, CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Post('admin/media')
  async uploadMedia(
    @Body() rawBody: unknown,
    @Request() req: any
  ) {
    const body = parseBody(MediaAssetSchema, rawBody) as {
      fileName: string;
      fileUrl: string;
      mimeType: string;
      sizeBytes: number;
      altText: string;
    };
    return this.cmsService.createMediaAsset(body, req.user.id, req.user.role);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Get('admin/media')
  async getMediaAssets(@Query() pagination: PaginationQueryDto) {
    return this.cmsService.getAllMediaAssets(toPrismaPagination(pagination, 100));
  }
}

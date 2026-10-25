import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { EventsService } from './events.service';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '@gcdis/shared';
import { Public } from '../common/decorators/public.decorator';
import { CsrfGuard } from '../common/guards/csrf.guard';
import { parseBody } from '../common/utils/validate-body.util';
import { sanitizeRichText, sanitizeUrl } from '../common/utils/cms-sanitizer.util';

const isoDate = z
  .string()
  .min(1)
  .refine((v) => !Number.isNaN(new Date(v).getTime()), 'must be a valid date');

const CreateEventSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase letters, digits and dashes').max(100),
    title: z.string().trim().min(2).max(200),
    subtitle: z.string().max(300).optional(),
    description: z.string().max(10000).optional(),
    bannerUrl: z.string().max(2048).optional(),
    startDate: isoDate,
    endDate: isoDate,
    venueName: z.string().trim().min(1).max(200),
    venueAddress: z.string().max(500).optional()
  })
  .refine((e) => new Date(e.endDate).getTime() >= new Date(e.startDate).getTime(), {
    message: 'endDate must not be before startDate',
    path: ['endDate']
  });

@Controller('events')
export class EventsController {
  constructor(private eventsService: EventsService) {}

  @Public()
  @Get()
  async getAllEvents() {
    return this.eventsService.findAllEvents();
  }

  @Public()
  @Get(':slug')
  async getEventBySlug(@Param('slug') slug: string) {
    return this.eventsService.findEventBySlug(slug);
  }

  @Public()
  @Get(':eventSlug/categories/:categorySlug')
  async getCategory(
    @Param('eventSlug') eventSlug: string,
    @Param('categorySlug') categorySlug: string
  ) {
    return this.eventsService.findCategoryBySlug(eventSlug, categorySlug);
  }

  @UseGuards(CsrfGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.EVENT_ADMIN)
  @Post()
  async createEvent(@Body() rawBody: unknown) {
    const body: any = parseBody(CreateEventSchema, rawBody);
    return this.eventsService.createEvent({
      ...body,
      title: sanitizeRichText(body.title),
      subtitle: body.subtitle !== undefined ? sanitizeRichText(body.subtitle) : undefined,
      description: body.description !== undefined ? sanitizeRichText(body.description) : undefined,
      bannerUrl: body.bannerUrl ? sanitizeUrl(body.bannerUrl) : undefined,
      venueName: sanitizeRichText(body.venueName),
      venueAddress: body.venueAddress !== undefined ? sanitizeRichText(body.venueAddress) : undefined
    });
  }
}

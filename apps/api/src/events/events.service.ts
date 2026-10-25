import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class EventsService {
  constructor(private prisma: PrismaService) {}

  async findAllEvents() {
    return this.prisma.event.findMany({
      include: {
        categories: true,
        arenas: true
      },
      orderBy: { createdAt: 'desc' },
      take: 100
    });
  }

  async findEventBySlug(slug: string) {
    const event = await this.prisma.event.findUnique({
      where: { slug },
      include: {
        categories: true,
        arenas: true,
        sponsors: true
      }
    });

    if (!event) {
      throw new NotFoundException(`Event with slug '${slug}' not found`);
    }

    return event;
  }

  async findCategoryBySlug(eventSlug: string, categorySlug: string) {
    const event = await this.findEventBySlug(eventSlug);
    const category = await this.prisma.category.findFirst({
      where: {
        eventId: event.id,
        slug: categorySlug
      }
    });

    if (!category) {
      throw new NotFoundException(`Category '${categorySlug}' not found under event '${eventSlug}'`);
    }

    return category;
  }

  async getCategoriesByEventId(eventId: string) {
    return this.prisma.category.findMany({
      where: { eventId, isActive: true },
      orderBy: { name: 'asc' }
    });
  }

  async createEvent(eventData: {
    slug: string;
    title: string;
    subtitle?: string;
    description?: string;
    bannerUrl?: string;
    startDate: string;
    endDate: string;
    venueName: string;
    venueAddress?: string;
  }) {
    return this.prisma.event.create({
      data: {
        slug: eventData.slug,
        title: eventData.title,
        subtitle: eventData.subtitle,
        description: eventData.description,
        bannerUrl: eventData.bannerUrl,
        startDate: new Date(eventData.startDate),
        endDate: new Date(eventData.endDate),
        venueName: eventData.venueName,
        venueAddress: eventData.venueAddress,
        status: 'UPCOMING'
      },
      include: {
        categories: true
      }
    });
  }
}

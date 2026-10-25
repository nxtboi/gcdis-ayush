import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  public isConnected = false;

  constructor() {
    const rawUrl = process.env.DATABASE_URL || '';
    // Enforce fixed connection pool size (15 per instance) & PgBouncer readiness
    const tunedUrl = rawUrl.includes('connection_limit')
      ? rawUrl
      : `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}connection_limit=15&pool_timeout=10`;

    super({
      datasources: {
        db: {
          url: tunedUrl
        }
      },
      log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error']
    });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      this.isConnected = true;
      this.logger.log('Prisma ORM connected to PostgreSQL with tuned connection pool (pool size: 15).');
    } catch (error: any) {
      this.isConnected = false;
      this.logger.warn(`Prisma connection warning: ${error.message}`);
    }
  }

  async onModuleDestroy() {
    if (this.isConnected) {
      await this.$disconnect();
    }
  }
}

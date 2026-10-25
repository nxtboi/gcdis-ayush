import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { EventsModule } from './events/events.module';
import { TeamsModule } from './teams/teams.module';
import { RegistrationsModule } from './registrations/registrations.module';
import { InspectionModule } from './inspection/inspection.module';
import { PaymentsModule } from './payments/payments.module';
import { CompetitionModule } from './competition/competition.module';
import { ScoringModule } from './scoring/scoring.module';
import { CertificatesModule } from './certificates/certificates.module';
import { CMSModule } from './cms/cms.module';
import { AuditModule } from './audit/audit.module';
import { UploadsModule } from './uploads/uploads.module';
import { PrismaModule } from './prisma/prisma.module';
import { MailModule } from './mail/mail.module';
import { SecurityModule } from './security/security.module';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { DefaultApiRateLimitGuard } from './common/guards/rate-limiter.guard';

@Module({
  imports: [
    PrismaModule,
    MailModule,
    SecurityModule,
    AuthModule,
    EventsModule,
    TeamsModule,
    RegistrationsModule,
    InspectionModule,
    PaymentsModule,
    CompetitionModule,
    ScoringModule,
    CertificatesModule,
    CMSModule,
    AuditModule,
    UploadsModule
  ],
  controllers: [AppController],
  providers: [
    // App-wide default rate limit (API_DEFAULT_RATE_LIMIT_PER_MIN per client IP) for every route without its
    // own @RateLimit. Registered first so floods are rejected before token verification and session lookups.
    {
      provide: APP_GUARD,
      useClass: DefaultApiRateLimitGuard
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard
    }
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Express 5 / path-to-regexp v8 needs a named wildcard; '{*splat}' also matches the bare prefix
    consumer.apply(RequestIdMiddleware).forRoutes('{*splat}');
  }
}

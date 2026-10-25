import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { SecurityAlertService } from './security-alert.service';
import { ClamAvService } from './clamav.service';
import { CspReportController } from './csp-report.controller';
import { NoStoreForAuthenticatedInterceptor } from './no-store.interceptor';

@Global()
@Module({
  controllers: [CspReportController],
  providers: [
    SecurityAlertService,
    ClamAvService,
    // Cache-Control: no-store on every authenticated API response (personal data)
    { provide: APP_INTERCEPTOR, useClass: NoStoreForAuthenticatedInterceptor }
  ],
  exports: [SecurityAlertService, ClamAvService]
})
export class SecurityModule {}

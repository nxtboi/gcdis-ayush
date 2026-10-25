import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { RegistrationsModule } from '../registrations/registrations.module';
import { CertificatesModule } from '../certificates/certificates.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [RegistrationsModule, CertificatesModule, AuditModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService]
})
export class PaymentsModule {}

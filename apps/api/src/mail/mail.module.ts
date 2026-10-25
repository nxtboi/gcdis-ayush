import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MailService } from './mail.service';
import { MailController } from './mail.controller';

@Global()
@Module({
  imports: [AuditModule],
  controllers: [MailController],
  providers: [MailService],
  exports: [MailService]
})
export class MailModule {}

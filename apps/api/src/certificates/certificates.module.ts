import { Module } from '@nestjs/common';
import { CertificatesService } from './certificates.service';
import { CertificatesController } from './certificates.controller';
import { PdfGeneratorService } from './pdf-generator.service';

@Module({
  controllers: [CertificatesController],
  providers: [CertificatesService, PdfGeneratorService],
  exports: [CertificatesService, PdfGeneratorService]
})
export class CertificatesModule {}

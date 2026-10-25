import { Module } from '@nestjs/common';
import { InspectionService } from './inspection.service';
import { InspectionController } from './inspection.controller';
import { RegistrationsModule } from '../registrations/registrations.module';

@Module({
  imports: [RegistrationsModule],
  controllers: [InspectionController],
  providers: [InspectionService],
  exports: [InspectionService]
})
export class InspectionModule {}

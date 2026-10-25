import { Module } from '@nestjs/common';
import { ScoringGateway } from './scoring.gateway';
import { CompetitionModule } from '../competition/competition.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [CompetitionModule, AuthModule],
  providers: [ScoringGateway],
  exports: [ScoringGateway]
})
export class ScoringModule {}

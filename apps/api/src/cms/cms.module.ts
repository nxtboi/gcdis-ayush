import { Module } from '@nestjs/common';
import { CMSService } from './cms.service';
import { CMSController } from './cms.controller';
import { AuditModule } from '../audit/audit.module';
import { UploadsModule } from '../uploads/uploads.module';
import { SiteContentController } from './site-content.controller';
import { SiteContentService } from './site-content.service';
import { HomeContentController } from './home-content.controller';
import { HomeContentService } from './home-content.service';
import { ChampionshipMediaController } from './championship-media.controller';
import { ChampionshipMediaService } from './championship-media.service';

@Module({
  imports: [AuditModule, UploadsModule],
  controllers: [CMSController, SiteContentController, HomeContentController, ChampionshipMediaController],
  providers: [CMSService, SiteContentService, HomeContentService, ChampionshipMediaService],
  exports: [CMSService, SiteContentService, HomeContentService, ChampionshipMediaService]
})
export class CMSModule {}

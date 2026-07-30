import { Global, Module } from '@nestjs/common';

import { VideosModule } from '../videos/videos.module';
import { SubtitlesController } from './subtitles.controller';
import { SubtitlesService } from './subtitles.service';

/** Global because reconcile binds sidecars and needs this without owning it. */
@Global()
@Module({
  imports: [VideosModule],
  controllers: [SubtitlesController],
  providers: [SubtitlesService],
  exports: [SubtitlesService],
})
export class SubtitlesModule {}

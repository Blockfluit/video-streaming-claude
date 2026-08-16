import { Global, Module } from '@nestjs/common';

import { VideosModule } from '../videos/videos.module';
import { OpenSubtitlesClient } from './providers/opensubtitles.client';
import { SUBTITLE_PROVIDER } from './providers/provider';
import { SubtitleSearchService } from './subtitle-search.service';
import { SubtitlesController } from './subtitles.controller';
import { SubtitlesService } from './subtitles.service';

/** Global because reconcile binds sidecars and needs this without owning it. */
@Global()
@Module({
  imports: [VideosModule],
  controllers: [SubtitlesController],
  providers: [
    SubtitlesService,
    SubtitleSearchService,
    // The one place that decides which provider the app talks to. Swapping it
    // is a line here, which is the whole reason the interface exists.
    { provide: SUBTITLE_PROVIDER, useClass: OpenSubtitlesClient },
  ],
  exports: [SubtitlesService],
})
export class SubtitlesModule {}

import { Module } from '@nestjs/common';

import { WatchModule } from '../watch/watch.module';
import { WatchlistModule } from '../watchlist/watchlist.module';

import { ListsController } from './lists.controller';
import { ListsService } from './lists.service';

/**
 * The two personal sources are delegated rather than reimplemented: a Continue
 * Watching row is `WatchService.history` and a My List row is
 * `WatchlistService.list`, both of which already resolve the awkward parts —
 * visibility on the nested video, and which episode a saved show would play.
 */
@Module({
  imports: [WatchModule, WatchlistModule],
  controllers: [ListsController],
  providers: [ListsService],
  exports: [ListsService],
})
export class ListsModule {}

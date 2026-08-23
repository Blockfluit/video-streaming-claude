import { Global, Module } from '@nestjs/common';

import { SEARCH_ENGINE } from './engine';
import { NoSearchEngine } from './none.engine';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

/**
 * Global, because the catalogue needs it without owning it — the same
 * arrangement `SubtitlesModule` makes for reconcile.
 */
@Global()
@Module({
  controllers: [SearchController],
  providers: [
    SearchService,
    // The one place that decides what answers a search. Swapping it is a line
    // here, which is the whole reason the interface exists.
    { provide: SEARCH_ENGINE, useClass: NoSearchEngine },
  ],
  exports: [SearchService],
})
export class SearchModule {}

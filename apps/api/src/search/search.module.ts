import { Global, Module, type OnApplicationBootstrap } from '@nestjs/common';

import { SEARCH_ENGINE } from './engine';
import { IndexerService } from './indexer.service';
import { MeilisearchClient } from './meilisearch.client';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

/**
 * Global, because the catalogue and reconcile both need this without owning it —
 * the same arrangement `SubtitlesModule` makes.
 *
 * `MeilisearchClient` is bound whether or not it is configured, and answers
 * `isConfigured: false` when `MEILI_URL` is unset. That is what makes an
 * unconfigured server a fully working server rather than a degraded one: no
 * conditional wiring, no second module, and the Postgres path is what every test
 * tier and every un-opted-in checkout actually runs.
 */
@Global()
@Module({
  controllers: [SearchController],
  providers: [
    SearchService,
    IndexerService,
    MeilisearchClient,
    // The one place that decides what answers a search.
    { provide: SEARCH_ENGINE, useExisting: MeilisearchClient },
  ],
  exports: [SearchService, IndexerService],
})
export class SearchModule implements OnApplicationBootstrap {
  constructor(private readonly indexer: IndexerService) {}

  /**
   * Build the index once the app is up.
   *
   * `onApplicationBootstrap` rather than `onModuleInit`, and not awaited: an
   * engine that is slow or down must not hold up the server, because the server
   * works without it. A fresh volume, a changed setting and a first-ever start
   * are all the same case here — read the library, write the documents.
   */
  onApplicationBootstrap(): void {
    void this.indexer.rebuild();
  }
}

import { Controller, Get, HttpCode, Post } from '@nestjs/common';

import { Roles } from '../auth/decorators';
import { ThrottleExpensive } from '../common/throttling';

import { IndexerService } from './indexer.service';
import { SearchService } from './search.service';

/** What an admin needs to know about the engine, and the one button it needs. */
interface SearchStatus {
  engine: string;
  configured: boolean;
  /** The engine is configured *and* currently being asked. */
  healthy: boolean;
  /** When the index was last built, or null if it never has been this boot. */
  indexedAt: string | null;
}

@Controller()
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly indexer: IndexerService,
  ) {}

  /**
   * Whether search is running on an engine, and whether that engine is answering.
   *
   * ADMIN-only, and deliberately **not a 503** when nothing is configured — the
   * same call `/subtitles/search/status` and `/admin/metadata/status` make, for
   * the same reason: a screen asks this so it can say what is switched on, and
   * one that has to catch an error to draw itself flickers. Not throttled either,
   * for the same reason those are not.
   *
   * `healthy` is the field that earns its place. `configured` says an operator
   * meant to run an engine; `healthy` says it is actually being asked. Search
   * keeps working when an engine stops answering — that is what the fallback is
   * for — so without this the fast path can be off for a week with nothing
   * anywhere saying so.
   *
   * The master key is never reported, and neither is the URL.
   */
  @Get('search/status')
  @Roles('ADMIN')
  status(): SearchStatus {
    return {
      engine: this.search.engineName,
      configured: this.search.isConfigured,
      healthy: this.search.isHealthy,
      indexedAt: this.indexer.builtAt?.toISOString() ?? null,
    };
  }

  /**
   * Rebuild the index now.
   *
   * The escape hatch for the one thing the rebuild-on-change rule cannot cover:
   * an engine that was down while the library moved. Awaited, unlike every other
   * rebuild, because an admin pressed a button and wants to know it happened.
   *
   * `@ThrottleExpensive` for the reason every other library-wide job carries it —
   * this reads every row of three tables.
   */
  @Post('admin/search/reindex')
  @Roles('ADMIN')
  @ThrottleExpensive()
  @HttpCode(200)
  async reindex(): Promise<SearchStatus> {
    await this.indexer.rebuild();

    return this.status();
  }
}

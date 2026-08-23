import { Controller, Get } from '@nestjs/common';

import { Roles } from '../auth/decorators';

import { SearchService } from './search.service';

/**
 * Whether search is running on an engine, and whether that engine is answering.
 *
 * ADMIN-only, and deliberately **not a 503** when nothing is configured — the
 * same call `/subtitles/search/status` and `/admin/metadata/status` make, for
 * the same reason: a screen asks this so it can say what is switched on, and one
 * that has to catch an error to draw itself flickers. Not throttled either, for
 * the same reason those are not.
 *
 * `healthy` is the interesting field. `configured` says an operator meant to run
 * an engine; `healthy` says it is actually answering, which is the difference
 * between "we are not using one" and "we thought we were". Without it a failing
 * engine is invisible: search keeps working, because that is what the fallback is
 * for, and nothing anywhere says the fast path has been off for a week.
 */
@Controller()
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get('search/status')
  @Roles('ADMIN')
  status(): { engine: string; configured: boolean; healthy: boolean } {
    return {
      engine: this.search.engineName,
      configured: this.search.isConfigured,
      healthy: this.search.isHealthy,
    };
  }
}

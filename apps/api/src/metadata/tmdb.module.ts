import { Global, Module } from '@nestjs/common';

import { PersonLinksService } from './person-links.service';
import { TmdbClient } from './tmdb.client';

/**
 * The provider half of the metadata feature, kept apart from the routes.
 *
 * Global for the same reason `MediaModule` is: `PeopleService` fills in IMDb ids
 * behind its own reads, and `MetadataModule` already imports `PeopleModule` to
 * create people — so putting these in `MetadataModule` would make the two
 * import each other.
 */
@Global()
@Module({
  providers: [TmdbClient, PersonLinksService],
  exports: [TmdbClient, PersonLinksService],
})
export class TmdbModule {}

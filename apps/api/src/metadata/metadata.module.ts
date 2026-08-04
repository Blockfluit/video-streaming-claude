import { Module } from '@nestjs/common';

import { MetadataController } from './metadata.controller';
import { MetadataService } from './metadata.service';
import { PeopleModule } from '../people/people.module';

/**
 * `PeopleModule` for `resolveMany` — an import creates people, and doing that
 * here would put a second set of rules for naming and slugging them in the
 * codebase.
 *
 * `TmdbClient` comes from the global `TmdbModule`, and `MediaModule` is global
 * too, so the artwork services need no import either.
 */
@Module({
  imports: [PeopleModule],
  controllers: [MetadataController],
  providers: [MetadataService],
})
export class MetadataModule {}

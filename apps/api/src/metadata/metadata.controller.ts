import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  applyMetadataSchema,
  previewMetadataSchema,
  searchMetadataSchema,
  type ApplyMetadataInput,
  type Page,
  type PreviewMetadataQuery,
  type SearchMetadataQuery,
} from '@video/shared';

import { MetadataService, targetFor, type MetadataPreview } from './metadata.service';
import { PersonLinksService } from './person-links.service';
import { TmdbClient } from './tmdb.client';
import { Roles } from '../auth/decorators';
import { ThrottleExpensive } from '../common/throttling';
import { validate } from '../common/zod-validation.pipe';

/**
 * Importing metadata, from an admin's hands only.
 *
 * `@ThrottleExpensive()` for the same reason the ffmpeg routes carry it: every
 * route that reaches off the machine has it, and this is a courtesy to a free
 * API as much as a protection for us. It is a method decorator, so it goes on
 * each one rather than on the class — and `status` deliberately does without.
 */
@Controller('admin/metadata')
@Roles('ADMIN')
export class MetadataController {
  constructor(
    private readonly metadata: MetadataService,
    private readonly tmdb: TmdbClient,
    private readonly personLinks: PersonLinksService,
  ) {}

  /**
   * Whether the feature can work at all.
   *
   * Deliberately not throttled and deliberately not a 503: the admin screens ask
   * this so they can *hide* a button that cannot work, and a screen that has to
   * catch an error to draw itself is a screen that flickers.
   */
  @Get('status')
  status(): { configured: boolean } {
    return { configured: this.tmdb.isConfigured };
  }

  @ThrottleExpensive()
  @Get('search')
  search(@Query(validate(searchMetadataSchema)) query: SearchMetadataQuery): Promise<Page<unknown>> {
    return this.metadata.search(query);
  }

  @ThrottleExpensive()
  @Get('collections/:id/preview')
  previewCollection(
    @Param('id') id: string,
    @Query(validate(previewMetadataSchema)) query: PreviewMetadataQuery,
  ): Promise<MetadataPreview> {
    return this.metadata.preview(targetFor('collection', id), query.tmdbId, query.type);
  }

  @ThrottleExpensive()
  @Get('videos/:id/preview')
  previewVideo(
    @Param('id') id: string,
    @Query(validate(previewMetadataSchema)) query: PreviewMetadataQuery,
  ): Promise<MetadataPreview> {
    return this.metadata.preview(targetFor('video', id), query.tmdbId, query.type);
  }

  @ThrottleExpensive()
  @Post('collections/:id/apply')
  applyCollection(
    @Param('id') id: string,
    @Body(validate(applyMetadataSchema)) dto: ApplyMetadataInput,
  ): Promise<MetadataPreview> {
    return this.metadata.apply(targetFor('collection', id), dto);
  }

  @ThrottleExpensive()
  @Post('videos/:id/apply')
  applyVideo(
    @Param('id') id: string,
    @Body(validate(applyMetadataSchema)) dto: ApplyMetadataInput,
  ): Promise<MetadataPreview> {
    return this.metadata.apply(targetFor('video', id), dto);
  }

  /**
   * Forgets the match, keeping everything that was imported from it.
   *
   * Not throttled: it reaches nothing off the machine, and an admin trying to
   * free up a title they matched to the wrong thing should not meet a limit.
   */
  @Delete('collections/:id/match')
  @HttpCode(HttpStatus.NO_CONTENT)
  unmatchCollection(@Param('id') id: string): Promise<void> {
    return this.metadata.unmatch(targetFor('collection', id));
  }

  @Delete('videos/:id/match')
  @HttpCode(HttpStatus.NO_CONTENT)
  unmatchVideo(@Param('id') id: string): Promise<void> {
    return this.metadata.unmatch(targetFor('video', id));
  }

  /**
   * Works through the people still waiting for an IMDb id.
   *
   * The queue fills these in behind whoever gets looked at, which is fine for a
   * library being browsed and slow for one that has just had a hundred films
   * imported. This is the "do it now" button.
   */
  @ThrottleExpensive()
  @Post('people/resolve-links')
  resolvePersonLinks(): Promise<{ resolved: number; checked: number }> {
    return this.personLinks.resolveAll();
  }
}

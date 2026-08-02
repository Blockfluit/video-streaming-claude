import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  addCollectionVideoSchema,
  createCollectionSchema,
  deleteWithFilesSchema,
  listCollectionsSchema,
  publishCollectionSchema,
  resolveQuerySchema,
  reorderCollectionVideosSchema,
  updateCollectionSchema,
  type AddCollectionVideoInput,
  type CreateCollectionInput,
  type DeleteWithFilesQuery,
  type ListCollectionsQuery,
  type PublishCollectionQuery,
  type ResolveQuery,
  type ReorderCollectionVideosInput,
  type UpdateCollectionInput,
} from '@video/shared';

import type { Response } from 'express';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { validate } from '../common/zod-validation.pipe';
import { ImagesService } from '../common/images.service';
import { CollectionsService } from './collections.service';
import { ResolveService, type ResolveResult } from './resolve.service';
import { SkipThrottle } from '@nestjs/throttler';

/**
 * Reads are open to any signed-in user and filtered by role in the service —
 * never in the UI. Writes are ADMIN-only, marked per route rather than on the
 * class so the reads stay reachable.
 */
@Controller('collections')
export class CollectionsController {
  constructor(
    private readonly collections: CollectionsService,
    private readonly resolver: ResolveService,
    private readonly images: ImagesService,
  ) {}

  /**
   * The shelf artwork.
   *
   * Keyed by **id**, not slug, unlike the pages around it: a card already holds
   * the id it is rendering, and the plan's API surface names it that way.
   *
   * Route order does not matter here, unlike `:slug/resolve` — this pattern is
   * two segments and `:slug` is one, so Express cannot confuse them. Checked
   * rather than assumed: moving it below `:slug` fails nothing.
   */
  /** Not throttled, for the same reason as video thumbnails: one per card. */
  @SkipThrottle()
  @Get(':id/poster')
  poster(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res() response: Response,
  ): Promise<void> {
    return this.images.collectionPoster(id, user.role, response);
  }

  @Get()
  list(
    @Query(validate(listCollectionsSchema)) query: ListCollectionsQuery,
    @CurrentUser() user: AuthUser,
  ) {
    return this.collections.list(query, user.role);
  }

  @Post()
  @Roles('ADMIN')
  create(@Body(validate(createCollectionSchema)) dto: CreateCollectionInput) {
    return this.collections.create(dto);
  }

  /**
   * Declared before `:slug` — Express matches in order, so a literal segment
   * has to come first or `resolve` would be read as a collection slug.
   */
  @Get(':slug/resolve')
  resolve(
    @Param('slug') slug: string,
    @Query(validate(resolveQuerySchema)) query: ResolveQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<ResolveResult> {
    return this.resolver.resolve(slug, query.path, user.role);
  }

  /**
   * The caller's own progress through this collection — which video to offer
   * next, and how far they got in each. Two segments, so like `:id/poster` its
   * position relative to `:slug` does not matter; kept adjacent for reading.
   */
  @Get(':slug/progress')
  progress(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.collections.progress(slug, user.id, user.role);
  }

  @Get(':slug')
  findOne(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.collections.findBySlug(slug, user.role);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(
    @Param('id') id: string,
    @Body(validate(updateCollectionSchema)) dto: UpdateCollectionInput,
  ) {
    return this.collections.update(id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id') id: string,
    @Query(validate(deleteWithFilesSchema)) query: DeleteWithFilesQuery,
  ): Promise<void> {
    return this.collections.remove(id, query.deleteFiles);
  }

  /**
   * Which season a set of videos sits in, and their order within it.
   *
   * Declared before `:id/publish` only for readability — both are literal
   * suffixes and cannot shadow each other.
   */
  @Patch(':id/videos/order')
  @Roles('ADMIN')
  reorderVideos(
    @Param('id') id: string,
    @Body(validate(reorderCollectionVideosSchema)) dto: ReorderCollectionVideosInput,
  ) {
    return this.collections.reorderVideos(id, dto);
  }

  /**
   * Puts a video in this collection, or takes it out again.
   *
   * Declared before `:id/videos/:videoId` would matter if there were a conflict;
   * `videos/order` above is a literal and cannot be read as a video id.
   *
   * Removing acts on the **membership**. The video keeps existing, along with
   * every comment and progress row attached to it, and stays in whichever other
   * collections hold it — deleting the video instead is a different operation
   * with no undo.
   */
  @Post(':id/videos')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.CREATED)
  addVideo(
    @Param('id') id: string,
    @Body(validate(addCollectionVideoSchema)) dto: AddCollectionVideoInput,
  ) {
    return this.collections.addVideo(id, dto.videoId, dto.seasonId ?? null);
  }

  @Delete(':id/videos/:videoId')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  removeVideo(@Param('id') id: string, @Param('videoId') videoId: string) {
    return this.collections.removeVideo(id, videoId);
  }

  @Post(':id/publish')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  publish(
    @Param('id') id: string,
    @Query(validate(publishCollectionSchema)) query: PublishCollectionQuery,
  ) {
    return this.collections.publish(id, query.cascade);
  }

  @Post(':id/archive')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  archive(@Param('id') id: string) {
    return this.collections.archive(id);
  }
}

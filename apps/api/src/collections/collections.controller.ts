import {
  BadRequestException,
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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  MAX_BANNER_BYTES,
  createCollectionSchema,
  deleteWithFilesSchema,
  listCollectionsSchema,
  publishCollectionSchema,
  resolveQuerySchema,
  reorderCollectionVideosSchema,
  updateCollectionSchema,
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
import { imageFileFilter, MIME_TO_EXTENSION } from '../common/image-uploads';
import { ThrottleExpensive } from '../common/throttling';
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

  /** Same rules as the poster: keyed by id, two segments, never throttled. */
  @SkipThrottle()
  @Get(':id/banner')
  banner(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res() response: Response,
  ): Promise<void> {
    return this.images.collectionBanner(id, user.role, response);
  }

  /**
   * Uploads the collection's wide backdrop.
   *
   * The first upload endpoint on the collection side — the poster still comes
   * from the folder on disk and has none. Upload only, with no capture twin: a
   * collection has no file of its own to grab a frame from.
   */
  @ThrottleExpensive()
  @Post(':id/banner')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_BANNER_BYTES, files: 1 },
      fileFilter: imageFileFilter,
    }),
  )
  async uploadBanner(
    @Param('id') id: string,
    @UploadedFile() file: { buffer: Buffer; mimetype: string } | undefined,
  ) {
    if (!file) throw new BadRequestException('No image uploaded');

    const key = await this.collections.setBanner(id, file.buffer, MIME_TO_EXTENSION[file.mimetype]);
    return { bannerKey: key };
  }

  @Delete(':id/banner')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  clearBanner(@Param('id') id: string): Promise<void> {
    return this.collections.clearBanner(id);
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

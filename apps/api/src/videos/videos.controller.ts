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
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  MAX_THUMBNAIL_BYTES,
  captureThumbnailSchema,
  listVideosSchema,
  updateMarkersSchema,
  updateVideoSchema,
  type CaptureThumbnailInput,
  type ListVideosQuery,
  type UpdateMarkersInput,
  type UpdateVideoInput,
} from '@video/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { ImagesService } from '../common/images.service';
import { validate } from '../common/zod-validation.pipe';
import type { ArtworkShape } from '../media/artwork';
import { MediaService } from '../media/media.service';
import { JobsService } from '../transcode/jobs.service';
import { StreamingService } from './streaming.service';
import { VideosService } from './videos.service';
import { ThrottleExpensive } from '../common/throttling';

/**
 * Shared by both upload routes.
 *
 * Declared above the class because a decorator argument is evaluated when the
 * class is defined, not when the route runs — below it, this is still in its
 * temporal dead zone.
 *
 * The client's filename is metadata and never a path component: the extension
 * comes from the mime type, which is the one thing here the server chose.
 */
const IMAGE_UPLOAD = {
  limits: { fileSize: MAX_THUMBNAIL_BYTES, files: 1 },
  fileFilter: (
    _request: unknown,
    file: { mimetype: string },
    callback: (error: Error | null, acceptFile: boolean) => void,
  ) => {
    const extension = MIME_TO_EXTENSION[file.mimetype];
    callback(
      extension ? null : new BadRequestException('Unsupported image type'),
      Boolean(extension),
    );
  },
};

@Controller('videos')
export class VideosController {
  constructor(
    private readonly videos: VideosService,
    private readonly streaming: StreamingService,
    private readonly media: MediaService,
    private readonly jobs: JobsService,
    private readonly images: ImagesService,
  ) {}

  @Get()
  list(
    @Query(validate(listVideosSchema)) query: ListVideosQuery,
    @CurrentUser() user: AuthUser,
  ) {
    return this.videos.list(query, user.role);
  }

  /**
   * The canonical page's lookup.
   *
   * Declared **before** `:id` — Express matches in order, so the other way
   * round reads `by-slug` as a video id and 404s every canonical URL.
   */
  @Get('by-slug/:slug')
  findBySlug(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    return this.videos.findBySlug(slug, user.role);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.videos.findOne(id, user.role);
  }

  /**
   * Byte-range playback. Takes the raw response because the body is a stream
   * with hand-set status and headers — `Content-Range` and a `206` are what
   * make seeking work, and Nest's serialisation has no way to express them.
   *
   * Authenticated by the session cookie: a `<video>` element cannot attach an
   * `Authorization` header to its own range requests, which is the reason this
   * app uses cookies at all.
   */
  /*
   * Never throttled. A single <video> element issues a range request per seek
   * and several more while buffering — scrubbing through a film is dozens in a
   * few seconds, and that is one person watching one thing. A limit here does
   * not protect anything; it breaks playback.
   */
  @SkipThrottle()
  @Get(':id/stream')
  stream(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.streaming.stream(id, user.role, request, response);
  }

  /**
   * The two shapes of artwork: a 2:3 poster and a 16:9 banner.
   *
   * Both revalidate with an ETag rather than carrying a lifetime — the storage
   * key is stable across replacements, so any cached copy outlives the picture
   * it shows and an admin who has just fixed a poster keeps seeing the old one.
   *
   * Never throttled. Every card on every shelf asks for one, so a single home
   * page is dozens of requests before anyone has clicked anything; they are
   * cheap static reads behind an ETag, and a limit here would break the shelves
   * without protecting anything.
   *
   * Neither 404s. Artwork falls back — to the stock image at worst — because a
   * card that asks and gets nothing has already paid for the round trip.
   */
  @SkipThrottle()
  @Get(':id/poster')
  poster(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res() response: Response,
  ): Promise<void> {
    return this.images.videoArtwork(id, 'poster', user.role, response);
  }

  @SkipThrottle()
  @Get(':id/banner')
  banner(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res() response: Response,
  ): Promise<void> {
    return this.images.videoArtwork(id, 'banner', user.role, response);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(@Param('id') id: string, @Body(validate(updateVideoSchema)) dto: UpdateVideoInput) {
    return this.videos.update(id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string): Promise<void> {
    return this.videos.remove(id);
  }

  @Post(':id/publish')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  publish(@Param('id') id: string) {
    return this.videos.publish(id);
  }

  @Post(':id/archive')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  archive(@Param('id') id: string) {
    return this.videos.archive(id);
  }

  /**
   * Sets the skip-intro and skip-outro markers.
   *
   * Separate from `PATCH /videos/:id` because the scrub editor saves a single
   * marker at a time as you click, and because these are validated against each
   * other and the duration rather than independently.
   */
  @Patch(':id/markers')
  @Roles('ADMIN')
  updateMarkers(
    @Param('id') id: string,
    @Body(validate(updateMarkersSchema)) dto: UpdateMarkersInput,
  ) {
    return this.videos.updateMarkers(id, dto);
  }

  /**
   * Re-runs ffprobe and waits for it — the admin clicked a button and expects
   * an answer, not a promise that something will happen eventually.
   */
  /** Spawns ffprobe and waits for it, so a loop spawns processes. */
  @ThrottleExpensive()
  @Post(':id/reprobe')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  async reprobe(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    await this.media.reprobe(id);
    return this.videos.findOne(id, user.role);
  }

  /**
   * Uploads an image for one shape. Marked MANUAL, so no later probe overwrites
   * it — and only that shape, so a hand-picked poster survives a banner being
   * replaced.
   */
  @ThrottleExpensive()
  @Post(':id/poster')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', IMAGE_UPLOAD))
  uploadPoster(
    @Param('id') id: string,
    @UploadedFile() file: { buffer: Buffer; mimetype: string } | undefined,
  ) {
    return this.storeArtwork(id, file, 'poster');
  }

  @ThrottleExpensive()
  @Post(':id/banner')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', IMAGE_UPLOAD))
  uploadBanner(
    @Param('id') id: string,
    @UploadedFile() file: { buffer: Buffer; mimetype: string } | undefined,
  ) {
    return this.storeArtwork(id, file, 'banner');
  }

  /**
   * Grabs a frame at a chosen moment. Also MANUAL — someone picked it.
   *
   * One ffmpeg invocation per call, hence the expensive-throttle. The poster is
   * cropped from the frame and the banner is the whole of it, so capturing the
   * same timestamp twice gives two different pictures rather than one repeated.
   */
  @ThrottleExpensive()
  @Post(':id/poster/capture')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  async capturePoster(
    @Param('id') id: string,
    @Body(validate(captureThumbnailSchema)) dto: CaptureThumbnailInput,
  ) {
    const key = await this.media.captureArtwork(id, dto.atSeconds, 'poster');
    return { posterKey: key, posterSource: 'MANUAL' };
  }

  @ThrottleExpensive()
  @Post(':id/banner/capture')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  async captureBanner(
    @Param('id') id: string,
    @Body(validate(captureThumbnailSchema)) dto: CaptureThumbnailInput,
  ) {
    const key = await this.media.captureArtwork(id, dto.atSeconds, 'banner');
    return { bannerKey: key, bannerSource: 'MANUAL' };
  }

  /**
   * Queues a conversion. Returns the job rather than waiting — a transcode
   * takes minutes, and the UI polls `/admin/jobs` for progress.
   *
   * Nothing converts on its own: a 200-file drop flags what needs converting
   * and stops, so it cannot silently peg the CPU for a day.
   */
  @ThrottleExpensive()
  @Post(':id/convert')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.ACCEPTED)
  convert(@Param('id') id: string, @CurrentUser() admin: AuthUser) {
    return this.jobs.enqueue(id, 'TRANSCODE', admin.id);
  }

  /** Pulls embedded text subtitle tracks out into servable VTT sidecars. */
  @ThrottleExpensive()
  @Post(':id/extract-subtitles')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.ACCEPTED)
  extractSubtitles(@Param('id') id: string, @CurrentUser() admin: AuthUser) {
    return this.jobs.enqueue(id, 'SUBTITLE_EXTRACT', admin.id);
  }

  /**
   * Deletes the archival source once a conversion has replaced it.
   *
   * The row keeps `sourceDeletedAt` and its `playbackKey`, which is what
   * exempts it from the missing-file sweep.
   */
  @Delete(':id/source')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  reclaimSource(@Param('id') id: string): Promise<void> {
    return this.jobs.reclaimSource(id);
  }

  /** Drops one shape and returns it to AUTO; the next probe regenerates it. */
  @Delete(':id/poster')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  clearPoster(@Param('id') id: string): Promise<void> {
    return this.media.clearArtwork(id, 'poster');
  }

  @Delete(':id/banner')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  clearBanner(@Param('id') id: string): Promise<void> {
    return this.media.clearArtwork(id, 'banner');
  }

  /** The half of an upload that is the same whichever shape it is for. */
  private async storeArtwork(
    id: string,
    file: { buffer: Buffer; mimetype: string } | undefined,
    shape: ArtworkShape,
  ) {
    if (!file) throw new BadRequestException('No image uploaded');

    const key = await this.media.setArtwork(
      id,
      file.buffer,
      MIME_TO_EXTENSION[file.mimetype],
      shape,
    );

    return shape === 'poster'
      ? { posterKey: key, posterSource: 'MANUAL' }
      : { bannerKey: key, bannerSource: 'MANUAL' };
  }
}

/** Extension taken from the mime type, never from the client's filename. */
const MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

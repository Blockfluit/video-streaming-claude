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
import { MediaService } from '../media/media.service';
import { JobsService } from '../transcode/jobs.service';
import { StreamingService } from './streaming.service';
import { VideosService } from './videos.service';
import { ThrottleExpensive } from '../common/throttling';

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
   * The poster frame. Every card in the app asks for one of these, which is
   * why it revalidates with an ETag rather than carrying a lifetime: the
   * storage key is stable across replacements, so a cached copy would outlive
   * the picture it shows.
   */
  /*
   * Never throttled either. Every card on every shelf asks for one of these, so
   * a single home page is dozens of requests before anyone has clicked
   * anything. They are cheap static reads behind an ETag.
   */
  @SkipThrottle()
  @Get(':id/thumbnail')
  thumbnail(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res() response: Response,
  ): Promise<void> {
    return this.images.videoThumbnail(id, user.role, response);
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

  /** Uploads a poster image. Marked MANUAL, so no later probe overwrites it. */
  @ThrottleExpensive()
  @Post(':id/thumbnail')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_THUMBNAIL_BYTES, files: 1 },
      fileFilter: (_request, file, callback) => {
        // The client's filename is metadata, never a path component — the
        // extension is taken from the mime type instead.
        const extension = MIME_TO_EXTENSION[file.mimetype];
        callback(extension ? null : new BadRequestException('Unsupported image type'), Boolean(extension));
      },
    }),
  )
  async uploadThumbnail(
    @Param('id') id: string,
    @UploadedFile() file: { buffer: Buffer; mimetype: string } | undefined,
  ) {
    if (!file) throw new BadRequestException('No image uploaded');

    const key = await this.media.setThumbnail(id, file.buffer, MIME_TO_EXTENSION[file.mimetype]);
    return { thumbnailKey: key, thumbnailSource: 'MANUAL' };
  }

  /** Grabs a frame at a chosen moment. Also MANUAL — someone picked it. */
  /** One ffmpeg invocation per call. */
  @ThrottleExpensive()
  @Post(':id/thumbnail/capture')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  async captureThumbnail(
    @Param('id') id: string,
    @Body(validate(captureThumbnailSchema)) dto: CaptureThumbnailInput,
  ) {
    const key = await this.media.captureThumbnail(id, dto.atSeconds);
    return { thumbnailKey: key, thumbnailSource: 'MANUAL' };
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

  /** Drops the poster and returns the video to AUTO; the next probe regenerates one. */
  @Delete(':id/thumbnail')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  clearThumbnail(@Param('id') id: string): Promise<void> {
    return this.media.clearThumbnail(id);
  }
}

/** Extension taken from the mime type, never from the client's filename. */
const MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

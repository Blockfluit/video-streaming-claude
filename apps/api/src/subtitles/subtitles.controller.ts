import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  MAX_SUBTITLE_BYTES,
  setDefaultSubtitleSchema,
  updateSubtitleSchema,
  uploadSubtitleSchema,
  type SetDefaultSubtitleInput,
  type UpdateSubtitleInput,
  type UploadSubtitleInput,
} from '@video/shared';
import type { Response } from 'express';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { validate } from '../common/zod-validation.pipe';
import { VideosService } from '../videos/videos.service';
import { SubtitlesService } from './subtitles.service';
import { SkipThrottle } from '@nestjs/throttler';
import { ThrottleExpensive } from '../common/throttling';

@Controller()
export class SubtitlesController {
  constructor(
    private readonly subtitles: SubtitlesService,
    private readonly videos: VideosService,
  ) {}

  /**
   * The tracks for a video.
   *
   * Goes through `VideosService.findOne` first so the caller's visibility is
   * checked exactly once and in the same place as everywhere else — a `USER`
   * must not learn what subtitles a draft has.
   */
  @Get('videos/:videoId/subtitles')
  async list(@Param('videoId') videoId: string, @CurrentUser() user: AuthUser) {
    await this.videos.findOne(videoId, user.role);
    return this.subtitles.list(videoId);
  }

  /**
   * The WebVTT itself, at a `.vtt` URL because that is what a `<track src>`
   * points at.
   *
   * Served same-origin through the Nuxt proxy: a cross-origin `<track>` fails
   * **silently**, showing a track the viewer can select that never displays.
   */
  /*
   * Not throttled: the browser fetches every <track> it is offered as soon as
   * the player mounts, and a film with eight subtitle languages would spend a
   * chunk of any limit before playback starts.
   */
  @SkipThrottle()
  @Get('videos/:videoId/subtitles/:subtitleId.vtt')
  @Header('Content-Type', 'text/vtt; charset=utf-8')
  // Private media behind a session cookie, like the video itself.
  @Header('Cache-Control', 'private, no-store')
  async serve(
    @Param('videoId') videoId: string,
    @Param('subtitleId') subtitleId: string,
    @CurrentUser() user: AuthUser,
    @Res() response: Response,
  ): Promise<void> {
    await this.videos.findOne(videoId, user.role);
    const body = await this.subtitles.read(videoId, subtitleId);

    response.send(body);
  }

  /** Uploads a file, sniffs its charset and converts it. */
  @ThrottleExpensive()
  @Post('videos/:videoId/subtitles')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SUBTITLE_BYTES, files: 1 } }))
  async upload(
    @Param('videoId') videoId: string,
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @Body(validate(uploadSubtitleSchema)) dto: UploadSubtitleInput,
  ) {
    if (!file) throw new BadRequestException('No subtitle uploaded');

    return this.subtitles.upload(videoId, file.buffer, dto);
  }

  /**
   * Which track carries `default` — or that the choice is automatic again.
   *
   * On the **video**, not on a track: "no default at all" is a real choice with
   * no track to carry it, and AUTO has to be expressible or a hand-picked
   * default could never be handed back to the English rule.
   *
   * Returns the refreshed list, so the screen re-renders from what the server
   * decided rather than from what it hoped would happen.
   */
  @Put('videos/:videoId/subtitles/default')
  @Roles('ADMIN')
  setDefault(
    @Param('videoId') videoId: string,
    @Body(validate(setDefaultSubtitleSchema)) dto: SetDefaultSubtitleInput,
  ) {
    return this.subtitles.setDefaultTrack(videoId, dto);
  }

  @Patch('subtitles/:id')
  @Roles('ADMIN')
  update(
    @Param('id') id: string,
    @Body(validate(updateSubtitleSchema)) dto: UpdateSubtitleInput,
  ) {
    return this.subtitles.update(id, dto);
  }

  @Delete('subtitles/:id')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string): Promise<void> {
    return this.subtitles.remove(id);
  }
}

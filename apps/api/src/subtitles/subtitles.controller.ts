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
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  MAX_SUBTITLE_BYTES,
  fetchSubtitleSchema,
  setDefaultSubtitleSchema,
  subtitleSearchSchema,
  toPage,
  updateSubtitleSchema,
  uploadSubtitleSchema,
  type FetchSubtitleInput,
  type SetDefaultSubtitleInput,
  type SubtitleSearchInput,
  type UpdateSubtitleInput,
  type UploadSubtitleInput,
} from '@video/shared';
import type { Response } from 'express';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { listLanguages } from '../common/language';
import { validate } from '../common/zod-validation.pipe';
import type { SubtitleQuota } from './providers/provider';
import { VideosService } from '../videos/videos.service';
import { SubtitleSearchService } from './subtitle-search.service';
import { SubtitlesService } from './subtitles.service';
import { SkipThrottle } from '@nestjs/throttler';
import { ThrottleExpensive } from '../common/throttling';

@Controller()
export class SubtitlesController {
  constructor(
    private readonly subtitles: SubtitlesService,
    private readonly search: SubtitleSearchService,
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
   * Whether subtitle search is switched on at all.
   *
   * Deliberately not a 503, for the reason the metadata one gives: the editor
   * asks this so it can *hide* a button that cannot work, and a screen that has
   * to catch an error to draw itself is a screen that flickers.
   */
  @Get('subtitles/search/status')
  @Roles('ADMIN')
  searchStatus(): { configured: boolean } {
    return { configured: this.search.isConfigured };
  }

  /**
   * How many downloads today's allowance has left.
   *
   * Throttled like the other outbound calls — it is a request to another server,
   * however cheap, and a screen that polled it would spend somebody else's
   * budget.
   *
   * Wrapped in an object rather than returned bare, because a handler returning
   * `null` sends an empty 200 body: the caller then cannot tell "this server has
   * no such number" from "something ate the response". A server configured to
   * search but not to download is the former.
   */
  @ThrottleExpensive()
  @Get('subtitles/search/quota')
  @Roles('ADMIN')
  async searchQuota(): Promise<{ quota: SubtitleQuota | null }> {
    return { quota: await this.search.quota() };
  }

  /**
   * The languages a subtitle can be in.
   *
   * Served rather than shipped to the browser: the list comes from the `langs`
   * package, and bundling a copy of ISO 639 into a page that needs it once is
   * paying for it on every page. Declared before `subtitles/:id` — there is no
   * `GET subtitles/:id` today, but Express matches in order and the next person
   * to add one should not have to discover this.
   */
  @Get('subtitles/languages')
  languages() {
    const languages = listLanguages();
    return toPage(languages, languages.length, { limit: languages.length, offset: 0 });
  }

  /**
   * What an external provider has for this video.
   *
   * A GET that makes an outbound call is unusual, but it is a read: nothing
   * changes here, and an admin re-running a search after typing a better title
   * is the expected way to use it.
   */
  @ThrottleExpensive()
  @Get('videos/:videoId/subtitle-candidates')
  @Roles('ADMIN')
  findCandidates(
    @Param('videoId') videoId: string,
    @Query(validate(subtitleSearchSchema)) dto: SubtitleSearchInput,
  ) {
    return this.search.search(videoId, dto);
  }

  /**
   * Installs one of them.
   *
   * Declared before nothing in particular — `subtitles/fetch` cannot collide
   * with `subtitles/:subtitleId.vtt`, which is a GET and carries an extension.
   */
  @ThrottleExpensive()
  @Post('videos/:videoId/subtitles/fetch')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.CREATED)
  fetch(
    @Param('videoId') videoId: string,
    @Body(validate(fetchSubtitleSchema)) dto: FetchSubtitleInput,
  ) {
    return this.search.install(videoId, dto);
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

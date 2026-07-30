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
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  listVideosSchema,
  updateVideoSchema,
  type ListVideosQuery,
  type UpdateVideoInput,
} from '@video/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { validate } from '../common/zod-validation.pipe';
import { StreamingService } from './streaming.service';
import { VideosService } from './videos.service';

@Controller('videos')
export class VideosController {
  constructor(
    private readonly videos: VideosService,
    private readonly streaming: StreamingService,
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
  @Get(':id/stream')
  stream(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    return this.streaming.stream(id, user.role, request, response);
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
}

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
} from '@nestjs/common';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { ListVideosDto, UpdateVideoDto } from './dto/video.dto';
import { VideosService } from './videos.service';

@Controller('videos')
export class VideosController {
  constructor(private readonly videos: VideosService) {}

  @Get()
  list(@Query() query: ListVideosDto, @CurrentUser() user: AuthUser) {
    return this.videos.list(query, user.role);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.videos.findOne(id, user.role);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdateVideoDto) {
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

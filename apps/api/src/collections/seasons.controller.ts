import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseBoolPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { Roles } from '../auth/decorators';
import { CreateSeasonDto, UpdateSeasonDto } from './dto/season.dto';
import { SeasonsService } from './seasons.service';

/** Seasons are only ever reached through their collection, so there is no list or detail route here. */
@Controller('seasons')
@Roles('ADMIN')
export class SeasonsController {
  constructor(private readonly seasons: SeasonsService) {}

  @Post()
  create(@Body() dto: CreateSeasonDto) {
    return this.seasons.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSeasonDto) {
    return this.seasons.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id') id: string,
    @Query('deleteFiles', new DefaultValuePipe(false), ParseBoolPipe) deleteFiles: boolean,
  ): Promise<void> {
    return this.seasons.remove(id, deleteFiles);
  }
}

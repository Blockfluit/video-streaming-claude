import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  createSeasonSchema,
  deleteWithFilesSchema,
  updateSeasonSchema,
  type CreateSeasonInput,
  type DeleteWithFilesQuery,
  type UpdateSeasonInput,
} from '@video/shared';

import { Roles } from '../auth/decorators';
import { validate } from '../common/zod-validation.pipe';
import { SeasonsService } from './seasons.service';

/** Seasons are only ever reached through their collection, so there is no list or detail route here. */
@Controller('seasons')
@Roles('ADMIN')
export class SeasonsController {
  constructor(private readonly seasons: SeasonsService) {}

  @Post()
  create(@Body(validate(createSeasonSchema)) dto: CreateSeasonInput) {
    return this.seasons.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body(validate(updateSeasonSchema)) dto: UpdateSeasonInput) {
    return this.seasons.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id') id: string,
    @Query(validate(deleteWithFilesSchema)) query: DeleteWithFilesQuery,
  ): Promise<void> {
    return this.seasons.remove(id, query.deleteFiles);
  }
}

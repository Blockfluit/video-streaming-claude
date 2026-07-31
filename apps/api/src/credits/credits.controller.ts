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
} from '@nestjs/common';
import {
  createCreditSchema,
  reorderCreditsSchema,
  updateCreditSchema,
  type CreateCreditInput,
  type ReorderCreditsInput,
  type UpdateCreditInput,
} from '@video/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { validate } from '../common/zod-validation.pipe';
import { CreditsService } from './credits.service';

@Controller()
export class CreditsController {
  constructor(private readonly credits: CreditsService) {}

  @Get('collections/:id/credits')
  forCollection(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.credits.listForCollection(id, user.role);
  }

  /** The show's cast and crew merged with this episode's — what the panel shows. */
  @Get('videos/:id/credits')
  forVideo(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.credits.listForVideo(id, user.role);
  }

  @Post('collections/:id/credits')
  @Roles('ADMIN')
  addToCollection(
    @Param('id') id: string,
    @Body(validate(createCreditSchema)) dto: CreateCreditInput,
  ) {
    return this.credits.createForCollection(id, dto);
  }

  @Post('videos/:id/credits')
  @Roles('ADMIN')
  addToVideo(@Param('id') id: string, @Body(validate(createCreditSchema)) dto: CreateCreditInput) {
    return this.credits.createForVideo(id, dto);
  }

  /**
   * Declared **before** `credits/:id` — Express matches in order, so the other
   * way round makes `reorder` a credit id and the endpoint unreachable.
   */
  @Patch('credits/reorder')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  reorder(@Body(validate(reorderCreditsSchema)) dto: ReorderCreditsInput) {
    return this.credits.reorder(dto);
  }

  @Patch('credits/:id')
  @Roles('ADMIN')
  update(@Param('id') id: string, @Body(validate(updateCreditSchema)) dto: UpdateCreditInput) {
    return this.credits.update(id, dto);
  }

  @Delete('credits/:id')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string): Promise<void> {
    return this.credits.remove(id);
  }
}

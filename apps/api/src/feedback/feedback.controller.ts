import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  createFeedbackSchema,
  listFeedbackSchema,
  type CreateFeedbackInput,
  type ListFeedbackQuery,
} from '@video/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { ThrottleAuthoring } from '../common/throttling';
import { validate } from '../common/zod-validation.pipe';
import { FeedbackService } from './feedback.service';

@Controller()
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  /** Any signed-in user — no `@Roles`, the session guard alone is enough. */
  @ThrottleAuthoring()
  @Post('feedback')
  create(
    @CurrentUser() user: AuthUser,
    @Body(validate(createFeedbackSchema)) dto: CreateFeedbackInput,
  ) {
    return this.feedback.create(user, dto);
  }

  @Get('admin/feedback')
  @Roles('ADMIN')
  list(@Query(validate(listFeedbackSchema)) query: ListFeedbackQuery) {
    return this.feedback.listForAdmin(query);
  }

  @Get('admin/feedback/:id/screenshot')
  @Roles('ADMIN')
  screenshot(@Param('id') id: string, @Res() response: Response) {
    return this.feedback.sendScreenshot(id, response);
  }

  @Delete('admin/feedback/:id')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string): Promise<void> {
    return this.feedback.remove(id);
  }
}

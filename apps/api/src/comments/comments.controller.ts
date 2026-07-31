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
import {
  createCommentSchema,
  listCommentsSchema,
  updateCommentSchema,
  type CreateCommentInput,
  type ListCommentsQuery,
  type UpdateCommentInput,
} from '@video/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { validate } from '../common/zod-validation.pipe';
import { CommentsService } from './comments.service';

@Controller()
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get('videos/:id/comments')
  list(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Query(validate(listCommentsSchema)) query: ListCommentsQuery,
  ) {
    return this.comments.list(id, user.role, query);
  }

  /** Rate limiting is `@nestjs/throttler` in step 18. */
  @Post('videos/:id/comments')
  create(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body(validate(createCommentSchema)) dto: CreateCommentInput,
  ) {
    return this.comments.create(id, user, dto);
  }

  /** The author's alone — an admin moderating removes a comment, it does not rewrite one. */
  @Patch('comments/:id')
  update(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body(validate(updateCommentSchema)) dto: UpdateCommentInput,
  ) {
    return this.comments.update(id, user, dto);
  }

  /** Soft delete. The author's own, or anyone's for an admin. */
  @Delete('comments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<void> {
    return this.comments.remove(id, user);
  }
}

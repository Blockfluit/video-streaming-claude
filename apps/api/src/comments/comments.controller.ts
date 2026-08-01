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
  moderateCommentsSchema,
  updateCommentSchema,
  type CreateCommentInput,
  type ListCommentsQuery,
  type ModerateCommentsQuery,
  type UpdateCommentInput,
} from '@video/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { validate } from '../common/zod-validation.pipe';
import { CommentsService } from './comments.service';
import { ThrottleAuthoring } from '../common/throttling';

@Controller()
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  /**
   * The moderation queue: every comment in the library, across every video.
   *
   * ADMIN-only. Sits under `admin/` alongside `admin/jobs` rather than being a
   * flag on the per-video listing, because it answers a different question and
   * carries a different visibility rule — a moderator can reach comments on
   * drafts, which the thread endpoint deliberately cannot.
   */
  @Get('admin/comments')
  @Roles('ADMIN')
  moderate(@Query(validate(moderateCommentsSchema)) query: ModerateCommentsQuery) {
    return this.comments.listForModeration(query);
  }

  @Get('videos/:id/comments')
  list(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Query(validate(listCommentsSchema)) query: ListCommentsQuery,
  ) {
    return this.comments.list(id, user.role, query);
  }

  /** Spam control. Fast enough never to notice, slow enough to be pointless. */
  @ThrottleAuthoring()
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

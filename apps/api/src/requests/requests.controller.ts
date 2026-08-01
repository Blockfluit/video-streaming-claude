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
  createRequestSchema,
  listRequestsSchema,
  updateRequestStatusSchema,
  type CreateRequestInput,
  type ListRequestsQuery,
  type UpdateRequestStatusInput,
} from '@video/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { ThrottleAuthoring } from '../common/throttling';
import { validate } from '../common/zod-validation.pipe';
import { RequestsService } from './requests.service';

/**
 * Requests for things the library does not have.
 *
 * One set of routes for both audiences rather than a viewer listing and an
 * `/admin` twin. The moderation queue for comments is a separate route because
 * it answers a different question over a different set of rows — a moderator
 * can reach comments on drafts. Here every caller sees the same rows in the same
 * order, and only the *detail* differs, so splitting the route would be two
 * spellings of one query with one serializer between them.
 */
@Controller('requests')
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(validate(listRequestsSchema)) query: ListRequestsQuery,
  ) {
    return this.requests.list(user, query);
  }

  /** Spam control, the same bucket comments use. */
  @ThrottleAuthoring()
  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(validate(createRequestSchema)) dto: CreateRequestInput,
  ) {
    return this.requests.create(user, dto);
  }

  /**
   * ADMIN-only, which is the whole of "the status can only be altered by
   * admins" — the guard, not the UI, is what enforces it.
   */
  @Patch(':id/status')
  @Roles('ADMIN')
  setStatus(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body(validate(updateRequestStatusSchema)) dto: UpdateRequestStatusInput,
  ) {
    return this.requests.setStatus(id, user, dto);
  }

  /** Withdrawing one: the author's own, or anyone's for an admin. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<void> {
    return this.requests.remove(id, user);
  }
}

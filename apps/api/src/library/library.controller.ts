import { Controller, Get, Query } from '@nestjs/common';
import {
  listLibrarySchema,
  pageQuerySchema,
  type ListLibraryQuery,
  type PageQuery,
} from '@video/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { validate } from '../common/zod-validation.pipe';

import { LibraryService } from './library.service';

/**
 * The catalogue as one list — what `/browse` reads.
 *
 * Reads only, open to any signed-in user and filtered by role in the service,
 * never in the UI. There is nothing to write here: a collection and a video are
 * each edited through their own endpoints, and this is a view over both.
 */
@Controller('library')
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  /**
   * Declared before the list route, and before any `:param` route this
   * controller ever grows. Express matches in order, so a literal segment added
   * below a parameter is read as a value for it — the trap `:slug/resolve`
   * carries on the collections controller.
   */
  @Get('genres')
  genres(@Query(validate(pageQuerySchema)) query: PageQuery, @CurrentUser() user: AuthUser) {
    return this.library.genres(query, user.role);
  }

  @Get()
  list(
    @Query(validate(listLibrarySchema)) query: ListLibraryQuery,
    @CurrentUser() user: AuthUser,
  ) {
    return this.library.list(query, user.role);
  }
}

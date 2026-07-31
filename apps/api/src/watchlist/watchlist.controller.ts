import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import {
  listWatchlistSchema,
  watchlistRefSchema,
  type ListWatchlistQuery,
  type WatchlistRefInput,
} from '@video/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { validate } from '../common/zod-validation.pipe';
import { WatchlistService } from './watchlist.service';

@Controller('me/watchlist')
export class WatchlistController {
  constructor(private readonly watchlist: WatchlistService) {}

  /** Saved collections come back with the episode they would play next. */
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(validate(listWatchlistSchema)) query: ListWatchlistQuery,
  ) {
    return this.watchlist.list(user.id, user.role, query);
  }

  /** Idempotent — a double-click must not produce two entries. */
  @Post()
  @HttpCode(HttpStatus.OK)
  add(
    @CurrentUser() user: AuthUser,
    @Body(validate(watchlistRefSchema)) ref: WatchlistRefInput,
  ) {
    return this.watchlist.add(user.id, user.role, ref);
  }

  /**
   * Takes the same body as the add, rather than an item id: the client is
   * toggling a heart next to a title and knows what it is looking at, not which
   * row happens to hold it.
   */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthUser,
    @Body(validate(watchlistRefSchema)) ref: WatchlistRefInput,
  ): Promise<void> {
    return this.watchlist.remove(user.id, ref);
  }
}

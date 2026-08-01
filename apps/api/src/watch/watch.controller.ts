import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
  heartbeatSchema,
  listHistorySchema,
  type HeartbeatInput,
  type ListHistoryQuery,
} from '@video/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { validate } from '../common/zod-validation.pipe';
import { WatchService } from './watch.service';
import { ThrottleHeartbeat } from '../common/throttling';

@Controller()
export class WatchController {
  constructor(private readonly watch: WatchService) {}

  /**
   * One beat from a playing video: every 10s, plus on pause, end and tab hide.
   *
   * 200 rather than 201 — a beat updates a rollup that already conceptually
   * exists, and the player wants the rollup back to keep its own state honest.
   */
  /*
   * The limit `watch/progress.ts` was written expecting. Capping `deltaSec` at
   * 30s stops one bad number rewriting a total, but explicitly is not a rate
   * limit — a client beating in a loop still accumulates real seconds. This is.
   *
   * 40/min leaves room for the player's 10s beat plus the sendBeacon on pause,
   * tab-hide and unload, across a couple of tabs.
   */
  @ThrottleHeartbeat()
  @Post('videos/:id/heartbeat')
  @HttpCode(HttpStatus.OK)
  heartbeat(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body(validate(heartbeatSchema)) beat: HeartbeatInput,
  ) {
    return this.watch.heartbeat(id, user.id, user.role, beat);
  }

  /** Continue watching. `?completed=false` is the row a home page renders. */
  @Get('me/history')
  history(
    @CurrentUser() user: AuthUser,
    @Query(validate(listHistorySchema)) query: ListHistoryQuery,
  ) {
    return this.watch.history(user.id, user.role, query);
  }

  /** The caller's own progress, plus aggregate figures when the caller is an admin. */
  @Get('videos/:id/stats')
  videoStats(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.watch.videoStats(id, user.id, user.role);
  }

  /** Rolled up over a show. Aggregate only, so admin-only. */
  @Get('collections/:id/stats')
  @Roles('ADMIN')
  collectionStats(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.watch.collectionStats(id, user.role);
  }
}

import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { trailerSearchSchema, type TrailerSearchQuery } from '@video/shared';

import { Roles } from '../auth/decorators';
import { validate } from '../common/zod-validation.pipe';
import { TrailersService } from './trailers.service';

@Controller('trailers')
export class TrailersController {
  constructor(private readonly trailers: TrailersService) {}

  /**
   * Searches YouTube for a trailer to attach.
   *
   * Throttled **tighter than `@ThrottleExpensive()`**, which allows 20 a
   * minute. The cost here is not CPU but metered third-party quota: a
   * `search.list` call spends 100 units of a 10,000/day default, so twenty a
   * minute would empty the whole install's daily allowance in five minutes.
   * Ten is still far more than a person clicking Search.
   *
   * For the same reason the picker searches on submit and never as a
   * type-ahead — a debounced field would spend the day's quota in one editing
   * session.
   */
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Roles('ADMIN')
  @Get('search')
  search(@Query(validate(trailerSearchSchema)) query: TrailerSearchQuery) {
    return this.trailers.search(query);
  }
}

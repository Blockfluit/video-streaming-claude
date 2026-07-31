import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { json } from 'express';

import { WatchController } from './watch.controller';
import { WatchService } from './watch.service';

@Module({
  controllers: [WatchController],
  providers: [WatchService],
  exports: [WatchService],
})
export class WatchModule implements NestModule {
  /**
   * The final beat of a page load goes out through `navigator.sendBeacon`,
   * because a normal `fetch` is killed mid-flight while the page tears down.
   *
   * A beacon sent as a string arrives as `text/plain`, which the global JSON
   * body parser ignores — the handler then sees an empty body and rejects the
   * one beat carrying where the viewer actually stopped. Parsing `text/plain`
   * as JSON is scoped to this route rather than applied globally: everywhere
   * else, a `text/plain` body is a client mistake worth surfacing.
   *
   * The frontend could instead send a `Blob` typed `application/json`, and
   * being same-origin that would not even trigger a preflight — but this is
   * five lines and does not depend on remembering.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(json({ type: ['application/json', 'text/plain'] }))
      .forRoutes({ path: 'videos/:id/heartbeat', method: RequestMethod.POST });
  }
}

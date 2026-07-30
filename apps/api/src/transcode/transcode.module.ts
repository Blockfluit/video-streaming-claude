import { Global, Module } from '@nestjs/common';

import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { Transcoder } from './transcoder';

/** Global so the videos controller can queue a conversion without owning the queue. */
@Global()
@Module({
  controllers: [JobsController],
  providers: [JobsService, Transcoder],
  exports: [JobsService],
})
export class TranscodeModule {}

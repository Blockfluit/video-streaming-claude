import { Module } from '@nestjs/common';

import { IngestController } from './ingest.controller';
import { ReconcileService } from './reconcile.service';
import { WatcherService } from './watcher.service';

@Module({
  controllers: [IngestController],
  providers: [ReconcileService, WatcherService],
  exports: [ReconcileService],
})
export class IngestModule {}

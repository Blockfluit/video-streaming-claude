import { Module } from '@nestjs/common';

import { IngestController } from './ingest.controller';
import { MediaBrowserService } from './media-browser.service';
import { ReconcileService } from './reconcile.service';
import { WatcherService } from './watcher.service';

@Module({
  controllers: [IngestController],
  providers: [ReconcileService, WatcherService, MediaBrowserService],
  exports: [ReconcileService],
})
export class IngestModule {}

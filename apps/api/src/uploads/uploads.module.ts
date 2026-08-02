import { Module } from '@nestjs/common';

import { IngestModule } from '../ingest/ingest.module';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

/**
 * Upload places files; ingest is what turns them into rows, so this depends on
 * ingest rather than duplicating the half of it that creates videos.
 */
@Module({
  imports: [IngestModule],
  controllers: [UploadsController],
  providers: [UploadsService],
})
export class UploadsModule {}

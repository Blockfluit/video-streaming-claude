import { Global, Module } from '@nestjs/common';

import { FfmpegService } from './ffmpeg.service';
import { CollectionArtworkService, MediaService } from './media.service';

/**
 * Global because ingest queues probes and videos serves thumbnails — both need
 * this without either owning it.
 */
@Global()
@Module({
  providers: [FfmpegService, MediaService, CollectionArtworkService],
  exports: [FfmpegService, MediaService, CollectionArtworkService],
})
export class MediaModule {}

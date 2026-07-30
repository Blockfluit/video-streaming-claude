import { Module } from '@nestjs/common';

import { StreamingService } from './streaming.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  controllers: [VideosController],
  providers: [VideosService, StreamingService],
  exports: [VideosService],
})
export class VideosModule {}

import { Module } from '@nestjs/common';

import { TrailersController } from './trailers.controller';
import { TrailersService } from './trailers.service';

@Module({
  controllers: [TrailersController],
  providers: [TrailersService],
})
export class TrailersModule {}

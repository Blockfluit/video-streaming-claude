import { Module } from '@nestjs/common';

import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';
import { ResolveService } from './resolve.service';
import { SeasonsController } from './seasons.controller';
import { SeasonsService } from './seasons.service';

@Module({
  controllers: [CollectionsController, SeasonsController],
  providers: [CollectionsService, SeasonsService, ResolveService],
  exports: [CollectionsService, SeasonsService],
})
export class CollectionsModule {}

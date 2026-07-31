import { Module } from '@nestjs/common';

import { CreditsController } from './credits.controller';
import { CreditsService } from './credits.service';

@Module({
  controllers: [CreditsController],
  providers: [CreditsService],
  exports: [CreditsService],
})
export class CreditsModule {}

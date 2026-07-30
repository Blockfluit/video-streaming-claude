import { Global, Module } from '@nestjs/common';

import { StorageService } from './storage.service';

/**
 * Global so every feature module gets `StorageService` without re-importing it.
 * Nothing outside this service should join a path itself.
 */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class CommonModule {}

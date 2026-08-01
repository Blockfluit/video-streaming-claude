import { Global, Module } from '@nestjs/common';

import { ImagesService } from './images.service';
import { StorageService } from './storage.service';

/**
 * Global so every feature module gets `StorageService` without re-importing it.
 * Nothing outside this service should join a path itself.
 *
 * `ImagesService` lives here for the same reason: thumbnails hang off videos and
 * posters off collections, so neither feature module owns it.
 */
@Global()
@Module({
  providers: [StorageService, ImagesService],
  exports: [StorageService, ImagesService],
})
export class CommonModule {}

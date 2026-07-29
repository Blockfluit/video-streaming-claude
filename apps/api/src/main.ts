import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // No global prefix: the Nuxt dev proxy already strips `/api`, mapping
  // `/api/**` on :3000 straight onto `/**` here on :4000.
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);

  Logger.log(`API listening on http://localhost:${port}`, 'Bootstrap');
}

void bootstrap().catch((error: unknown) => {
  // Without this, a failed boot (an unreachable database, most often) surfaces as
  // an unhandled rejection and Node prints the offending line of minified vendor
  // source — kilobytes of noise around a one-line cause.
  Logger.error(error instanceof Error ? error.message : String(error), 'Bootstrap');
  if (error instanceof Error && error.stack) {
    Logger.error(error.stack, 'Bootstrap');
  }
  process.exit(1);
});

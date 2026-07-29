import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { SessionStoreService } from './auth/session-store.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Must be registered before routes, which Nest maps during listen().
  app.use(app.get(SessionStoreService).createMiddleware());

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip properties without a decorator: a client cannot smuggle extra
      // fields into a DTO and have them reach Prisma.
      whitelist: true,
      transform: true,
    }),
  );

  // Lets onModuleDestroy run, so the pg pools close on SIGTERM/SIGINT.
  app.enableShutdownHooks();

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

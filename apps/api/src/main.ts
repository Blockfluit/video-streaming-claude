import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { SessionStoreService } from './auth/session-store.service';
import { bigIntReplacer } from './common/json';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // `Video.sizeBytes` is a BigInt, and JSON.stringify throws on those. Express
  // hands this replacer to every res.json(), so it is handled once at the real
  // response boundary rather than remembered at each call site.
  app.set('json replacer', bigIntReplacer);

  // Must be registered before routes, which Nest maps during listen().
  app.use(app.get(SessionStoreService).createMiddleware());

  // No global validation pipe: validation is per parameter, against a schema
  // from `@video/shared`, because the schema is what says *what* to validate.
  // Zod objects strip unknown keys by default, so a client still cannot smuggle
  // extra fields through to Prisma.

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

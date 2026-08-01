import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { SessionStoreService } from './auth/session-store.service';
import { bigIntReplacer } from './common/json';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // `Video.sizeBytes` is a BigInt, and JSON.stringify throws on those. Express
  // hands this replacer to every res.json(), so it is handled once at the real
  // response boundary rather than remembered at each call site.
  app.set('json replacer', bigIntReplacer);

  /*
   * Security headers.
   *
   * The API serves JSON and media to a same-origin Nuxt app; it renders no HTML
   * of its own, so the interesting defaults are the ones that would get in the
   * way rather than the ones that help.
   *
   * `contentSecurityPolicy` is off here deliberately. A CSP describes what a
   * *document* may load, and nothing this server returns is a document — the
   * page comes from Nuxt, which is where a CSP belongs. Setting one here would
   * be a header nobody enforces, which is worse than none because it reads like
   * protection.
   *
   * `crossOriginResourcePolicy` is relaxed to same-site rather than left at
   * same-origin: in development the browser is on :3000 and this is :4000, so
   * the strict default blocks every poster and the video itself. Same-site
   * still refuses a genuinely foreign origin.
   */
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      // Range requests and <video> do not mix with an embedder policy.
      crossOriginEmbedderPolicy: false,
    }),
  );

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

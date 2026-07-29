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

void bootstrap();

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/client';
import { describeError } from '../common/errors';

/**
 * Prisma 7 talks to Postgres through a driver adapter rather than its own query
 * engine, so the connection string is handed to `PrismaPg` here instead of being
 * read from the schema's datasource block.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set — copy apps/api/.env.example to apps/api/.env');
    }

    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit(): Promise<void> {
    // $connect() is lazy behind a driver adapter — it resolves happily with no
    // database listening. Issue a real query so an unreachable or misconfigured
    // Postgres fails at boot with a message that says what to do, instead of
    // surfacing as a confusing 500 on the first request that touches it.
    try {
      await this.$queryRaw`SELECT 1`;
    } catch (cause) {
      this.logger.error(
        `Cannot reach Postgres. Is it running? Try \`docker compose up -d\`. (${
          describeError(cause)
        })`,
      );
      throw cause;
    }

    this.logger.log('Connected to the database');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

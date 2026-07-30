import { execFileSync } from 'node:child_process';

import { Client } from 'pg';

/**
 * Prepares a dedicated `video_test` database for the `.db-spec.ts` suites.
 *
 * These tests truncate tables between cases, so they must never point at the
 * development database. A separate database — rather than a schema — keeps the
 * migration history honest: `prisma migrate deploy` runs here exactly as it
 * would against production.
 */

const MAINTENANCE_URL =
  process.env.TEST_MAINTENANCE_DATABASE_URL ?? 'postgresql://video:video@localhost:5432/postgres';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://video:video@localhost:5432/video_test?schema=public';

export default async function globalSetup(): Promise<void> {
  const databaseName = new URL(TEST_DATABASE_URL).pathname.slice(1);
  const admin = new Client({ connectionString: MAINTENANCE_URL });

  try {
    await admin.connect();
  } catch (cause) {
    // Failing loudly beats skipping: a suite that silently passes without a
    // database would report green while testing nothing.
    throw new Error(
      'These tests need the Postgres from docker-compose. Start it with `docker compose up -d`. ' +
        `(${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }

  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (existing.rowCount === 0) {
      // Identifier, so it cannot be parameterised — quoted instead. The name
      // comes from our own config, never from a request.
      await admin.query(`CREATE DATABASE "${databaseName}"`);
    }
  } finally {
    await admin.end();
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'inherit',
  });

  // Read by PrismaService in the test workers.
  process.env.DATABASE_URL = TEST_DATABASE_URL;
}

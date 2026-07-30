import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import { Pool } from 'pg';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Session storage, on its own pg pool.
 *
 * Deliberately not Prisma's pool: connect-pg-simple speaks raw SQL, and keeping
 * the two separate means session churn cannot exhaust the connections the
 * application queries need.
 */
@Injectable()
export class SessionStoreService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set — copy apps/api/.env.example to apps/api/.env');
    }

    this.pool = new Pool({ connectionString });
  }

  createMiddleware(): ReturnType<typeof session> {
    const secret = process.env.SESSION_SECRET;
    if (!secret) {
      throw new Error('SESSION_SECRET is not set — generate one with `openssl rand -base64 32`');
    }

    const PgStore = connectPgSimple(session);

    return session({
      store: new PgStore({
        pool: this.pool,
        // The `session` table is owned by the Prisma migration, so the store
        // must not try to create its own — its DDL differs from ours.
        tableName: 'session',
        createTableIfMissing: false,
      }),
      secret,
      name: 'vsc.sid',
      resave: false,
      saveUninitialized: false,
      rolling: true, // sliding expiry: an active viewer is never logged out mid-binge
      cookie: {
        httpOnly: true,
        // 'lax' is enough because everything is same-origin through the Nuxt
        // proxy. It is also what lets <video> and <track> send the cookie.
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: SEVEN_DAYS_MS,
        path: '/',
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

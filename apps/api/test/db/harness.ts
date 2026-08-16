import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger, type INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { SessionStoreService } from '../../src/auth/session-store.service';
import { bigIntReplacer } from '../../src/common/json';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * The scaffolding every `.db-spec.ts` needs, in one place.
 *
 * The `test/` directory held eleven and a half thousand lines and exactly one
 * shared file. Every one of the twenty database suites then re-declared the same
 * harness: an identical import block, the same `PASSWORD`, the same four `let`
 * declarations, a byte-identical `startApp`, and the same thirty-line
 * `beforeEach` — boot, truncate, close, delete the token file, boot again,
 * redeem the bootstrap token as `root`. Roughly 1,300 lines, which is more than
 * a tenth of the tier.
 *
 * The lines were never the real cost. The `TRUNCATE` list was hand-maintained
 * per file and had reached **eleven distinct variants**, each a different tail
 * on the same `InviteToken, User, session` prefix and each relying on `CASCADE`
 * to reach whatever it did not name. A table added to the schema needed auditing
 * across twenty files, and a suite that leaks rows between cases does not fail
 * where the leak is.
 *
 * So the list is not restated here either — it is **read from the database**.
 * Whatever is in `public` gets truncated, minus Prisma's own migrations table.
 * That cannot go stale, and it is a superset of every hand-written list it
 * replaces.
 *
 * **Two suites deliberately do not use this.** `redeem.db-spec` and
 * `users.db-spec` are about bootstrapping and redemption themselves — the first
 * boots the app "exactly as `npm start` would" to watch the token file appear,
 * the second redeems as several different admins to test the last-admin rule.
 * Handing them a harness that has already bootstrapped and redeemed would be
 * testing the mechanism with itself, so they keep their own setup.
 */

export const PASSWORD = 'correct horse battery staple';

export interface HarnessOptions {
  /**
   * Distinguishes this suite's bootstrap-token file and temp workspace.
   *
   * Must be unique across suites: the paths live in `/tmp` and two runs sharing
   * one would redeem each other's master token, which surfaces as
   * `/auth/redeem` answering "that invite token is not valid" in a suite whose
   * own code is fine.
   */
  name: string;

  /**
   * Give the suite its own `MEDIA_ROOT` and `DERIVED_ROOT` under a temp dir.
   *
   * Most suites want this. The few that touch nothing on disk — users, redeem —
   * do not, and skipping it saves a temp directory per test.
   */
  workspace?: boolean;

  /**
   * What to call the bootstrap admin. `root` unless a suite asserts on the name.
   *
   * Not cosmetic: several suites render the admin's `displayName` back and check
   * it, and the catalogue suite has always used `ada`.
   */
  admin?: string;

  /** Replace a provider before the app is built, for suites that stub an upstream. */
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

/**
 * One suite's app, database and signed-in admin.
 *
 * Created in `beforeEach` and closed in `afterEach`. The fields are assigned on
 * `start()` rather than in a constructor so a spec can hold the instance at
 * module scope and let each test see a fresh app behind the same handle.
 */
export class DbHarness {
  app!: INestApplication;
  prisma!: PrismaService;
  /** Signed in as `root`, the bootstrap admin. */
  admin!: request.Agent;
  /** The temp directory holding `media/` and `derived/`, when `workspace` is set. */
  workspace = '';

  private banner: jest.SpyInstance | null = null;
  private readonly tokenFile: string;

  constructor(private readonly options: HarnessOptions) {
    this.tokenFile = join(tmpdir(), `video-streaming-${options.name}-test.bootstrap-token`);
  }

  /**
   * Boots, empties the database, boots again, and signs in.
   *
   * The second boot is not belt and braces. The API mints a bootstrap token at
   * startup when no admin account exists; truncating removes the admin the first
   * boot may have found, so the token minted before the truncate is for a row
   * that no longer exists. Starting again mints one that works.
   */
  async start(): Promise<void> {
    // The startup banner is several lines per boot, and there are two boots per
    // test. Silenced rather than tolerated, so a real log line is visible.
    this.banner = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    process.env.SESSION_SECRET ??= 'db-spec-secret';
    process.env.BOOTSTRAP_TOKEN_FILE = this.tokenFile;
    process.env.INGEST_WATCHER_ENABLED = 'false';

    if (this.options.workspace) {
      this.workspace = await mkdtemp(join(tmpdir(), `${this.options.name}-`));
      process.env.MEDIA_ROOT = join(this.workspace, 'media');
      process.env.DERIVED_ROOT = join(this.workspace, 'derived');
    }

    await rm(this.tokenFile, { force: true });

    await this.boot();
    await this.truncate();
    await this.app.close();
    await rm(this.tokenFile, { force: true });

    await this.boot();

    this.admin = request.agent(this.app.getHttpServer());
    await this.admin
      .post('/auth/redeem')
      .send({
        token: (await readFile(this.tokenFile, 'utf8')).trim(),
        username: this.options.admin ?? 'root',
        password: PASSWORD,
      })
      .expect(201);
  }

  /**
   * Rebuilds the app around the current configuration, keeping the database.
   *
   * For a suite that swaps a stub mid-test — the subtitle-search one reconfigures
   * its provider and needs the container built around the new value. The session
   * does not survive the restart, so the admin signs in again; by password, since
   * the bootstrap token was spent on the first boot and is deliberately unusable
   * twice.
   *
   * Anything a spec fetched out of the old container (`app.get(StorageService)`)
   * points at the old app afterwards and has to be fetched again.
   */
  async restart(): Promise<void> {
    await this.app.close();
    await this.boot();

    this.admin = this.agent();
    await this.admin
      .post('/auth/login')
      .send({ username: this.options.admin ?? 'root', password: PASSWORD })
      .expect(200);
  }

  async stop(): Promise<void> {
    this.banner?.mockRestore();
    this.banner = null;

    await this.app?.close();
    await rm(this.tokenFile, { force: true });
    if (this.workspace) await rm(this.workspace, { recursive: true, force: true });
  }

  /** A fresh agent with no session — for testing what an anonymous caller sees. */
  agent(): request.Agent {
    return request.agent(this.app.getHttpServer());
  }

  /**
   * A second account, invited by the admin and signed in.
   *
   * Through the real invite-and-redeem flow rather than a direct insert: the
   * password hashing and the session are what most of these suites are about.
   */
  async invite(username: string, role: 'USER' | 'ADMIN' = 'USER'): Promise<request.Agent> {
    const minted = await this.admin.post('/admin/invites').send({ role }).expect(201);

    const agent = this.agent();
    await agent
      .post('/auth/redeem')
      .send({ token: minted.body.token, username, password: PASSWORD })
      .expect(201);

    return agent;
  }

  private async boot(): Promise<void> {
    const base = Test.createTestingModule({ imports: [AppModule] });
    const moduleRef = await (this.options.configure ? this.options.configure(base) : base).compile();

    this.app = moduleRef.createNestApplication();
    // Must match production: `BigInt` does not survive `JSON.stringify`, and a
    // test app without this replacer differs from the server it is testing.
    this.app.getHttpAdapter().getInstance().set('json replacer', bigIntReplacer);
    this.app.use(this.app.get(SessionStoreService).createMiddleware());
    await this.app.init();

    this.prisma = this.app.get(PrismaService);
  }

  /**
   * Empties every table there is, rather than a list somebody has to maintain.
   *
   * `session` is included and is not a Prisma model — it belongs to
   * `connect-pg-simple` — which is exactly the sort of thing a hand-written list
   * gets wrong. One statement so it is one transaction: truncating in pieces
   * would need the order to respect foreign keys.
   */
  private async truncate(): Promise<void> {
    const tables = await this.prisma.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
    );

    if (tables.length === 0) return;

    const quoted = tables.map((row) => `"${row.tablename}"`).join(', ');
    await this.prisma.$executeRawUnsafe(`TRUNCATE ${quoted} RESTART IDENTITY CASCADE`);
  }
}

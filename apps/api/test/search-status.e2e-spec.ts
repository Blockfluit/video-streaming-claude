import { Test } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { SearchController } from '../src/search/search.controller';
import { SearchService } from '../src/search/search.service';

/**
 * `GET /search/status`, and the two things about it that are decisions rather
 * than plumbing.
 *
 * It answers **200 with `configured: false`** rather than 503 when no engine is
 * set up. An admin screen asks this so it can say what is switched on, and one
 * that has to catch an error to draw itself flickers — the same call
 * `/subtitles/search/status` and `/admin/metadata/status` already make.
 *
 * And it reports `healthy` separately from `configured`, because a configured
 * engine that has stopped answering is otherwise invisible: search keeps working,
 * which is what the fallback is for, and nothing anywhere says the fast path has
 * been off for a week.
 *
 * The guards themselves — ADMIN-only — are global and covered by `auth.e2e-spec`;
 * what is asserted here is the shape of the answer.
 */
describe('Search status (stubbed)', () => {
  let app: INestApplication;

  async function boot(search: Partial<SearchService>): Promise<void> {
    const moduleRef = await Test.createTestingModule({
      controllers: [SearchController],
      providers: [{ provide: SearchService, useValue: search }],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  }

  afterEach(() => app?.close());

  it('answers rather than failing when no engine is configured', async () => {
    await boot({ engineName: 'postgres', isConfigured: false, isHealthy: false });

    const response = await request(app.getHttpServer()).get('/search/status').expect(200);

    expect(response.body).toEqual({ engine: 'postgres', configured: false, healthy: false });
  });

  it('separates "not using one" from "we thought we were"', async () => {
    await boot({ engineName: 'meilisearch', isConfigured: true, isHealthy: false });

    const response = await request(app.getHttpServer()).get('/search/status').expect(200);

    expect(response.body).toEqual({ engine: 'meilisearch', configured: true, healthy: false });
  });
});

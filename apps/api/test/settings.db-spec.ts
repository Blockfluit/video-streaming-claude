import { type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { DbHarness } from './db/harness';

/**
 * `/admin/settings` against a real Postgres.
 *
 * Worth a real database because the row is lazily created — the interesting
 * behaviour is what happens *before* it exists (a default, not a 404 or a
 * crash) and that a write actually persists across a fresh read, not just
 * that the endpoint accepts a body.
 */
describe('Admin settings (real database)', () => {
  const harness = new DbHarness({ name: 'settings' });

  let app: INestApplication;
  let admin: request.Agent;
  let viewer: request.Agent;

  beforeEach(async () => {
    await harness.start();
    ({ app, admin } = harness);
    viewer = await harness.invite('grace');
  });

  afterEach(() => harness.stop());

  describe('access control', () => {
    it('401s an anonymous caller', async () => {
      const anon = request.agent(app.getHttpServer());
      await anon.get('/admin/settings').expect(401);
      await anon.patch('/admin/settings').send({ minTitlesForMatch: 5 }).expect(401);
    });

    it('403s a USER on both routes', async () => {
      await viewer.get('/admin/settings').expect(403);
      await viewer.patch('/admin/settings').send({ minTitlesForMatch: 5 }).expect(403);
    });
  });

  describe('GET /admin/settings', () => {
    it('answers with the hardcoded default before anyone has ever saved', async () => {
      const response = await admin.get('/admin/settings').expect(200);

      expect(response.body).toEqual({ minTitlesForMatch: 5, updatedAt: null });
    });
  });

  describe('PATCH /admin/settings', () => {
    it('persists a new value, reflected on a later read', async () => {
      const patched = await admin
        .patch('/admin/settings')
        .send({ minTitlesForMatch: 8 })
        .expect(200);

      expect(patched.body.minTitlesForMatch).toBe(8);
      expect(patched.body.updatedAt).not.toBeNull();

      const read = await admin.get('/admin/settings').expect(200);
      expect(read.body.minTitlesForMatch).toBe(8);
    });

    it('refuses a value below the floor', async () => {
      await admin.patch('/admin/settings').send({ minTitlesForMatch: 1 }).expect(400);
    });

    it('refuses a value above the ceiling', async () => {
      await admin.patch('/admin/settings').send({ minTitlesForMatch: 51 }).expect(400);
    });
  });
});

// apps/api/test/feedback.db-spec.ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import request from 'supertest';

import { PrismaService } from '../src/prisma/prisma.service';
import { DbHarness } from './db/harness';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/**
 * Feedback submitted from the floating button.
 *
 * No status workflow, unlike comments or requests — the tests here cover who
 * may do what (any signed-in user submits, only an admin reads or removes)
 * and the screenshot's storage round trip, which nothing else exercises.
 */
describe('Feedback (real database)', () => {
  const harness = new DbHarness({ name: 'feedback', workspace: true });

  let prisma: PrismaService;
  let admin: request.Agent;
  let ada: request.Agent;

  const body = (overrides: Record<string, unknown> = {}) => ({
    message: 'The player controls overlap on a phone.',
    pageUrl: '/watch/heat',
    userAgent: 'Mozilla/5.0',
    viewportWidth: 375,
    viewportHeight: 812,
    ...overrides,
  });

  beforeEach(async () => {
    await harness.start();
    ({ prisma, admin } = harness);
    ada = await harness.invite('ada');
  });

  afterEach(() => harness.stop());

  describe('submitting', () => {
    it('accepts a text-only submission from an ordinary user', async () => {
      const response = await ada.post('/feedback').send(body()).expect(201);

      expect(response.body).toMatchObject({
        message: body().message,
        hasScreenshot: false,
        user: { id: expect.any(String), displayName: 'ada' },
      });
    });

    it('accepts one from an admin too', async () => {
      await admin.post('/feedback').send(body()).expect(201);
    });

    it('refuses a signed-out submission', async () => {
      await harness.agent().post('/feedback').send(body()).expect(401);
    });

    it('refuses an empty message', async () => {
      await ada.post('/feedback').send(body({ message: '   ' })).expect(400);
    });

    /**
     * `pageUrl` is rendered on `/admin/feedback` as `<a :href="...">`, which an
     * admin may click — so a `USER`-supplied value has to be a same-site path,
     * enforced server-side since the client is the untrusted party here.
     */
    it.each([
      ['a javascript: URL', 'javascript:alert(1)'],
      ['an off-site URL', 'https://evil.example/phish'],
      ['a protocol-relative URL', '//evil.example'],
      ['a backslash-normalised off-site URL', '/\\evil.example'],
      ['no leading slash', 'watch/heat'],
    ])('refuses %s as pageUrl', async (_label, pageUrl) => {
      await ada.post('/feedback').send(body({ pageUrl })).expect(400);
    });

    it('accepts an ordinary same-site path', async () => {
      await ada.post('/feedback').send(body({ pageUrl: '/browse?genre=Horror' })).expect(201);
    });

    it('decodes and stores a screenshot, and it streams back byte-for-byte', async () => {
      const response = await ada
        .post('/feedback')
        .send(body({ screenshot: `data:image/png;base64,${TINY_PNG_BASE64}` }))
        .expect(201);

      expect(response.body.hasScreenshot).toBe(true);

      const image = await admin
        .get(`/admin/feedback/${response.body.id}/screenshot`)
        .expect(200);

      expect(image.headers['content-type']).toBe('image/png');
      expect(Buffer.from(image.body).equals(Buffer.from(TINY_PNG_BASE64, 'base64'))).toBe(true);
    });

    it('accepts a screenshot large enough to have 413\'d under the old 100kb body-parser default', async () => {
      // ~200KB of base64 — safely over Express's stock 100kb JSON limit, safely
      // under the 7mb ceiling apps/api/src/main.ts raises it to. Proves that fix
      // actually works, rather than merely being consistent with either its
      // presence or its absence (a tiny screenshot would pass either way).
      const largeScreenshot = Buffer.alloc(150_000, 1).toString('base64');

      const response = await ada
        .post('/feedback')
        .send(body({ screenshot: `data:image/png;base64,${largeScreenshot}` }))
        .expect(201);

      expect(response.body.hasScreenshot).toBe(true);
    });
  });

  describe('the admin list', () => {
    it('is admin-only', async () => {
      await ada.get('/admin/feedback').expect(403);
      await admin.get('/admin/feedback').expect(200);
    });

    it('returns a Page, newest first', async () => {
      await ada.post('/feedback').send(body({ message: 'First' })).expect(201);
      await ada.post('/feedback').send(body({ message: 'Second' })).expect(201);

      const response = await admin.get('/admin/feedback').expect(200);

      expect(response.body).toMatchObject({ total: 2, limit: 50, offset: 0 });
      expect(response.body.items.map((f: { message: string }) => f.message)).toEqual([
        'Second',
        'First',
      ]);
    });
  });

  describe('the screenshot route', () => {
    it('is admin-only', async () => {
      const created = await ada
        .post('/feedback')
        .send(body({ screenshot: `data:image/png;base64,${TINY_PNG_BASE64}` }))
        .expect(201);

      await ada.get(`/admin/feedback/${created.body.id}/screenshot`).expect(403);
    });

    it('404s a submission with no screenshot', async () => {
      const created = await ada.post('/feedback').send(body()).expect(201);

      await admin.get(`/admin/feedback/${created.body.id}/screenshot`).expect(404);
    });

    it('404s an unknown id', async () => {
      await admin.get('/admin/feedback/nope/screenshot').expect(404);
    });
  });

  describe('deleting', () => {
    it('is admin-only', async () => {
      const created = await ada.post('/feedback').send(body()).expect(201);

      await ada.delete(`/admin/feedback/${created.body.id}`).expect(403);
    });

    it('removes the row and its screenshot file', async () => {
      const created = await ada
        .post('/feedback')
        .send(body({ screenshot: `data:image/png;base64,${TINY_PNG_BASE64}` }))
        .expect(201);

      const filePath = join(harness.workspace, 'derived', 'feedback', `${created.body.id}.png`);
      expect(existsSync(filePath)).toBe(true);

      await admin.delete(`/admin/feedback/${created.body.id}`).expect(204);

      expect(existsSync(filePath)).toBe(false);
      await expect(
        prisma.feedback.findUnique({ where: { id: created.body.id } }),
      ).resolves.toBeNull();
    });

    it('removes a submission with no screenshot too', async () => {
      const created = await ada.post('/feedback').send(body()).expect(201);

      await admin.delete(`/admin/feedback/${created.body.id}`).expect(204);
    });

    it('404s an unknown id', async () => {
      await admin.delete('/admin/feedback/nope').expect(404);
    });
  });
});

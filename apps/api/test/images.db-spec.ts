
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { StorageService } from '../src/common/storage.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { DbHarness, PASSWORD } from './db/harness';

/**
 * Serving thumbnails and posters — the read side of what step 10 only wrote.
 *
 * The caching behaviour is the part worth pinning down. The storage key is
 * stable across replacements, so a lifetime-based cache would keep serving a
 * poster an admin has already replaced.
 */
describe('Artwork (real database)', () => {
  const harness = new DbHarness({ name: 'images', workspace: true });

  const PIXEL = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let admin: request.Agent;
  let viewer: request.Agent;
  let collectionId: string;
  let videoId: string;


  beforeEach(async () => {
    await harness.start();
    ({ app, prisma, admin } = harness);
    storage = app.get(StorageService);




    const minted = await admin.post('/admin/invites').send({}).expect(201);
    viewer = request.agent(app.getHttpServer());
    await viewer
      .post('/auth/redeem')
      .send({ token: minted.body.token, username: 'viewer', password: PASSWORD })
      .expect(201);

    await storage.save('derived', 'banners/film.png', PIXEL);
    await storage.save('derived', 'posters/film.png', PIXEL);
    await storage.save('derived', 'posters/films.png', PIXEL);

    const collection = await prisma.collection.create({
      data: {
        slug: 'films',
        title: 'Films',
        folderKey: 'Films',
        state: 'PUBLISHED',
        posterKey: 'posters/films.png',
      },
      select: { id: true },
    });
    collectionId = collection.id;

    const video = await prisma.video.create({
      data: {
        collections: { create: { collectionId } },
        slug: 'film',
        title: 'Film',
        storageKey: 'Films/film.mkv',
        contentTag: 'tag',
        originalName: 'film.mkv',
        mimeType: 'video/x-matroska',
        sizeBytes: BigInt(1024),
        fileMtime: new Date(),
        state: 'PUBLISHED',
        bannerKey: 'banners/film.png',
        posterKey: 'posters/film.png',
      },
      select: { id: true },
    });
    videoId = video.id;
  });

  afterEach(() => harness.stop());

  describe('a video banner', () => {
    it('serves the image with a type taken from the key', async () => {
      const response = await viewer.get(`/videos/${videoId}/banner`).expect(200);

      expect(response.headers['content-type']).toBe('image/png');
      expect(response.body).toEqual(PIXEL);
    });

    /** Two shapes, two files. Asking for one must never return the other. */
    it('is a different picture from the poster', async () => {
      await storage.save('derived', 'posters/film.png', Buffer.concat([PIXEL, PIXEL]));

      const wide = await viewer.get(`/videos/${videoId}/banner`).expect(200);
      const tall = await viewer.get(`/videos/${videoId}/poster`).expect(200);

      expect(wide.body).not.toEqual(tall.body);
    });

    /**
     * The key is stable across replacements — a new poster overwrites
     * `banners/<id>.jpg` — so any lifetime above zero serves the old picture
     * until it expires. Revalidation is what makes a replacement show up.
     */
    it('revalidates rather than carrying a lifetime', async () => {
      const response = await viewer.get(`/videos/${videoId}/banner`).expect(200);

      expect(response.headers['cache-control']).toBe('private, no-cache');
      expect(response.headers.etag).toBeDefined();
    });

    it('answers 304 when the browser already has it', async () => {
      const first = await viewer.get(`/videos/${videoId}/banner`).expect(200);

      await viewer
        .get(`/videos/${videoId}/banner`)
        .set('If-None-Match', first.headers.etag)
        .expect(304);
    });

    it('changes its tag when the picture is replaced', async () => {
      const before = await viewer.get(`/videos/${videoId}/banner`).expect(200);

      await storage.save('derived', 'banners/film.png', Buffer.concat([PIXEL, PIXEL]));

      const after = await viewer.get(`/videos/${videoId}/banner`).expect(200);
      expect(after.headers.etag).not.toBe(before.headers.etag);
    });

    // A shared cache must not hand one member's artwork to another.
    it('is never cached publicly', async () => {
      const response = await viewer.get(`/videos/${videoId}/banner`).expect(200);

      expect(response.headers['cache-control']).toContain('private');
    });

    /**
     * Not a 404 any more, deliberately.
     *
     * A video that has not been probed yet has no artwork, which is an ordinary
     * state and not an error. Every card used to pay a round trip to be told
     * nothing was there, and the browser suite — which fails any 4xx — went red
     * on pages that had nothing wrong with them.
     */
    it('serves the stock image for a video with no artwork', async () => {
      await prisma.video.update({ where: { id: videoId }, data: { bannerKey: null } });

      const response = await viewer.get(`/videos/${videoId}/banner`).expect(200);
      expect(response.headers['content-type']).toContain('image/svg+xml');
    });

    /** The row says there is a picture and the file is gone. Still a picture. */
    it('serves the stock image when the row points at a file that is gone', async () => {
      await storage.delete('derived', 'banners/film.png');

      const response = await viewer.get(`/videos/${videoId}/banner`).expect(200);
      expect(response.headers['content-type']).toContain('image/svg+xml');
    });

    /** The stock image is one constant, so it can revalidate like any other. */
    it('revalidates the stock image too', async () => {
      await prisma.video.update({ where: { id: videoId }, data: { bannerKey: null } });

      const first = await viewer.get(`/videos/${videoId}/banner`).expect(200);
      await viewer
        .get(`/videos/${videoId}/banner`)
        .set('If-None-Match', first.headers.etag)
        .expect(304);
    });

    /**
     * A missing *picture* is fine; a video the caller may not see is not. The
     * fallback must not turn an invisible row into a 200 that confirms it
     * exists.
     */
    it('still 404s a video that does not exist', async () => {
      await viewer.get('/videos/cmnothingatall000000000/banner').expect(404);
    });

    it('404s a draft for a viewer but serves it to an admin', async () => {
      await prisma.video.update({ where: { id: videoId }, data: { state: 'DRAFT' } });

      await viewer.get(`/videos/${videoId}/banner`).expect(404);
      await admin.get(`/videos/${videoId}/banner`).expect(200);
    });

    it('needs a session', async () => {
      await request(app.getHttpServer()).get(`/videos/${videoId}/banner`).expect(401);
    });
  });

  describe('a collection poster', () => {
    it('serves the image', async () => {
      const response = await viewer.get(`/collections/${collectionId}/poster`).expect(200);

      expect(response.headers['content-type']).toBe('image/png');
      expect(response.body).toEqual(PIXEL);
    });

    /**
     * The rule the whole derivation exists for. A collection with no poster of
     * its own is not a collection with no poster — it is one nobody has
     * overridden, and it shows what is on the shelf.
     *
     * Derived on read rather than copied at ingest, so it follows the episodes:
     * add, reorder or remove one and the collection's picture keeps up, with no
     * second copy to go stale.
     */
    it('falls back to its first video when nothing is set', async () => {
      await prisma.collection.update({ where: { id: collectionId }, data: { posterKey: null } });
      await storage.save('derived', 'posters/film.png', Buffer.concat([PIXEL, PIXEL]));

      const response = await viewer.get(`/collections/${collectionId}/poster`).expect(200);
      expect(response.body).toEqual(Buffer.concat([PIXEL, PIXEL]));
    });

    it('prefers its own poster over the one it would inherit', async () => {
      await storage.save('derived', 'posters/film.png', Buffer.concat([PIXEL, PIXEL]));

      const response = await viewer.get(`/collections/${collectionId}/poster`).expect(200);
      expect(response.body).toEqual(PIXEL);
    });

    it('serves the stock image for a collection holding nothing', async () => {
      const empty = await prisma.collection.create({
        data: { slug: 'empty', title: 'Empty', state: 'PUBLISHED' },
        select: { id: true },
      });

      const response = await viewer.get(`/collections/${empty.id}/poster`).expect(200);
      expect(response.headers['content-type']).toContain('image/svg+xml');
    });

    /**
     * A published collection may hold draft episodes, and a draft's artwork is
     * not published art. The inherited candidate goes through the same
     * visibility filter as every other nested read — otherwise the poster route
     * becomes a way to see a picture from a video the caller cannot open.
     */
    it('does not inherit from a video the viewer cannot see', async () => {
      await prisma.collection.update({ where: { id: collectionId }, data: { posterKey: null } });
      await prisma.video.update({ where: { id: videoId }, data: { state: 'DRAFT' } });
      await storage.save('derived', 'posters/film.png', Buffer.concat([PIXEL, PIXEL]));

      const asViewer = await viewer.get(`/collections/${collectionId}/poster`).expect(200);
      expect(asViewer.headers['content-type']).toContain('image/svg+xml');

      // The admin can see the draft, so for them it is the episode's poster.
      const asAdmin = await admin.get(`/collections/${collectionId}/poster`).expect(200);
      expect(asAdmin.body).toEqual(Buffer.concat([PIXEL, PIXEL]));
    });

    it('serves a banner as well as a poster', async () => {
      await storage.save('derived', 'banners/films.png', PIXEL);
      await prisma.collection.update({
        where: { id: collectionId },
        data: { bannerKey: 'banners/films.png' },
      });

      const response = await viewer.get(`/collections/${collectionId}/banner`).expect(200);
      expect(response.body).toEqual(PIXEL);
    });

    it('inherits its banner from the first video too', async () => {
      const response = await viewer.get(`/collections/${collectionId}/banner`).expect(200);
      expect(response.body).toEqual(PIXEL);
    });

    it('404s a draft for a viewer but serves it to an admin', async () => {
      await prisma.collection.update({ where: { id: collectionId }, data: { state: 'DRAFT' } });

      await viewer.get(`/collections/${collectionId}/poster`).expect(404);
      await admin.get(`/collections/${collectionId}/poster`).expect(200);
    });
  });
});

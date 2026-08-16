
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '../src/prisma/prisma.service';
import { DbHarness, PASSWORD } from './db/harness';

/**
 * Skip markers through the API.
 *
 * The behaviour worth testing here rather than in the unit tests is the
 * **merge**: the editor saves one marker at a time, so each save has to be
 * validated against what is already stored.
 */
describe('Markers (real database)', () => {
  const harness = new DbHarness({ name: 'markers', workspace: true });

  
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: request.Agent;
  let videoId: string;


  /** A 600-second video, so the duration bound is a real constraint. */
  async function seedVideo(durationSec: number | null = 600): Promise<string> {
    const collection = await prisma.collection.upsert({
      where: { folderKey: 'Films' },
      create: { slug: 'films', title: 'Films', folderKey: 'Films' },
      update: {},
      select: { id: true },
    });

    const video = await prisma.video.create({
      data: {
        collections: { create: { collectionId: collection.id } },
        slug: `film-${Math.round(performance.now() * 1000)}`,
        title: 'Film',
        storageKey: `Films/film-${Math.round(performance.now() * 1000)}.mp4`,
        contentTag: 'tag',
        originalName: 'film.mp4',
        mimeType: 'video/mp4',
        sizeBytes: BigInt(1024),
        fileMtime: new Date(),
        durationSec,
        state: 'DRAFT',
      },
      select: { id: true },
    });

    return video.id;
  }

  beforeEach(async () => {
    await harness.start();
    ({ app, prisma, admin } = harness);

    videoId = await seedVideo();
  });

  afterEach(() => harness.stop());

  const patch = (body: Record<string, unknown>) =>
    admin.patch(`/videos/${videoId}/markers`).send(body);

  describe('setting markers', () => {
    it('stores a complete intro and outro', async () => {
      const response = await patch({
        introStartSec: 5,
        introEndSec: 65,
        outroStartSec: 540,
        outroEndSec: 600,
      }).expect(200);

      expect(response.body).toMatchObject({
        introStartSec: 5,
        introEndSec: 65,
        outroStartSec: 540,
        outroEndSec: 600,
      });
    });

    it('accepts fractional seconds, which is what scrubbing produces', async () => {
      const response = await patch({ introStartSec: 12.5, introEndSec: 74.25 }).expect(200);

      expect(response.body.introStartSec).toBeCloseTo(12.5);
    });
  });

  /**
   * The editor sets one marker per click, so each save is a partial patch
   * validated against what is already stored — not against itself.
   */
  describe('one marker at a time, as the scrub editor saves', () => {
    it('accepts a start on its own, then its end', async () => {
      await patch({ introStartSec: 5 }).expect(200);
      const response = await patch({ introEndSec: 65 }).expect(200);

      expect(response.body).toMatchObject({ introStartSec: 5, introEndSec: 65 });
    });

    // The check that only works because the stored value is merged in first.
    it('rejects an end that lands before a start it cannot see in the patch', async () => {
      await patch({ introStartSec: 65 }).expect(200);

      const response = await patch({ introEndSec: 5 }).expect(400);

      expect(response.body.errors).toEqual([
        expect.objectContaining({ field: 'introEndSec' }),
      ]);
    });

    it('leaves markers it was not asked about alone', async () => {
      await patch({ introStartSec: 5, introEndSec: 65 }).expect(200);

      const response = await patch({ outroStartSec: 540, outroEndSec: 600 }).expect(200);

      expect(response.body).toMatchObject({ introStartSec: 5, introEndSec: 65 });
    });
  });

  describe('clearing', () => {
    // An explicit null is how the editor removes a marker set by mistake, and
    // is different from omitting the field.
    it('clears a marker with null', async () => {
      await patch({ introStartSec: 5, introEndSec: 65 }).expect(200);

      const response = await patch({ introStartSec: null, introEndSec: null }).expect(200);

      expect(response.body).toMatchObject({ introStartSec: null, introEndSec: null });
    });

    it('clears one end and leaves the other, which the player then ignores', async () => {
      await patch({ introStartSec: 5, introEndSec: 65 }).expect(200);

      const response = await patch({ introEndSec: null }).expect(200);

      expect(response.body).toMatchObject({ introStartSec: 5, introEndSec: null });
    });
  });

  describe('what it refuses', () => {
    it('rejects a marker past the end of the video', async () => {
      const response = await patch({ outroEndSec: 601 }).expect(400);

      expect(response.body.errors[0].message).toContain('600');
    });

    it('rejects a negative marker', async () => {
      await patch({ introStartSec: -1 }).expect(400);
    });

    it('rejects an empty body rather than doing nothing quietly', async () => {
      await patch({}).expect(400);
    });

    it('404s an unknown video', async () => {
      await admin.patch('/videos/nope/markers').send({ introStartSec: 5 }).expect(404);
    });

    it('is admin-only', async () => {
      const invite = await admin.post('/admin/invites').send({}).expect(201);
      const user = request.agent(app.getHttpServer());
      await user
        .post('/auth/redeem')
        .send({ token: invite.body.token, username: 'grace', password: PASSWORD })
        .expect(201);

      await user.patch(`/videos/${videoId}/markers`).send({ introStartSec: 5 }).expect(403);
    });

    it('leaves the stored markers untouched when it rejects', async () => {
      await patch({ introStartSec: 5, introEndSec: 65 }).expect(200);

      await patch({ introEndSec: 2 }).expect(400);

      await expect(prisma.video.findUniqueOrThrow({ where: { id: videoId } })).resolves.toMatchObject(
        { introStartSec: 5, introEndSec: 65 },
      );
    });
  });

  /**
   * An unprobed video has no duration to check against. Refusing markers
   * outright would mean a probe failure also blocks curation.
   */
  describe('a video that has not been probed', () => {
    it('still accepts markers, without the duration bound', async () => {
      videoId = await seedVideo(null);

      // Far beyond any plausible runtime, but inside the schema's absolute
      // 24-hour sanity cap — which applies whether or not a duration is known.
      await patch({ introStartSec: 5, introEndSec: 80_000 }).expect(200);
    });

    it('is still bounded by the absolute sanity cap', async () => {
      videoId = await seedVideo(null);

      await patch({ introEndSec: 90_000 }).expect(400);
    });

    it('still enforces ordering', async () => {
      videoId = await seedVideo(null);

      await patch({ introStartSec: 65, introEndSec: 5 }).expect(400);
    });
  });

  it('shows the markers on a normal video read', async () => {
    await patch({ introStartSec: 5, introEndSec: 65 }).expect(200);

    const response = await admin.get(`/videos/${videoId}`).expect(200);

    expect(response.body).toMatchObject({ introStartSec: 5, introEndSec: 65 });
  });
});

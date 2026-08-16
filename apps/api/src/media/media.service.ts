import { extname } from 'node:path';

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
} from '@nestjs/common';

import { StorageService } from '../common/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { playbackRoot } from '../transcode/converted-key';
import {
  ARTWORK_SHAPES,
  type ArtworkShape,
  artworkDirectory,
  artworkKey,
  artworkKeyOf,
  artworkKeyPatch,
  captureFilter,
  manualArtworkPatch,
} from './artwork';
import { NoFrameError } from './ffmpeg-error';
import { FfmpegService } from './ffmpeg.service';
import { needsConversion } from './needs-conversion';
import { describeError } from '../common/errors';

/**
 * Probing and thumbnails.
 *
 * A small in-process queue at **concurrency 2**: probing is IO-bound and cheap,
 * so two at a time keeps a folder drop moving without competing with anything
 * else. Transcoding is a different matter and gets its own persistent queue in
 * step 12 — that one is CPU-saturating and runs one at a time.
 *
 * Nothing here throws at the caller. A probe that fails writes `probeError` to
 * the row, because one unreadable file must not stop a scan of two hundred.
 */

const CONCURRENCY = 2;

/** Where in the video to grab the poster frame. Far enough in to miss the black frames at the start. */
const THUMBNAIL_POSITION = 0.1;

@Injectable()
export class MediaService implements OnModuleDestroy {
  private readonly logger = new Logger(MediaService.name);

  private readonly queued = new Set<string>();
  private shuttingDown = false;
  private readonly waiting: string[] = [];
  private active = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly ffmpeg: FfmpegService,
  ) {}

  /**
   * Stops the queue when the app shuts down.
   *
   * Without this the probes still in flight outlive `app.close()`: their
   * ffprobe children and Prisma writes keep the event loop alive, so Jest
   * reported "did not exit one second after the test run has completed" and
   * `test:db` exited non-zero **with all 399 tests passing**. The same
   * stragglers logged `No record was found for an update` when they landed on
   * rows the finished test had already deleted.
   *
   * Anything still waiting is dropped rather than run — nothing is watching for
   * the result any more — and the in-flight ones are given a bounded moment to
   * land so a half-written probe does not race the connection closing under it.
   */
  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    this.waiting.length = 0;

    const deadline = Date.now() + 5_000;
    while (this.active > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  get pending(): number {
    return this.waiting.length + this.active;
  }

  /**
   * Queues a video for probing, unless it is already waiting.
   *
   * Deduplicated by id: reconcile runs repeatedly and would otherwise queue the
   * same file on every pass.
   */
  enqueue(videoId: string): void {
    if (this.queued.has(videoId)) return;

    this.queued.add(videoId);
    this.waiting.push(videoId);
    this.pump();
  }

  /** Resolves once everything queued so far has been processed — for tests and for `reprobe`. */
  async drain(): Promise<void> {
    while (this.pending > 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private pump(): void {
    if (this.shuttingDown) return;

    while (this.active < CONCURRENCY && this.waiting.length > 0) {
      const videoId = this.waiting.shift() as string;
      this.active += 1;

      void this.processOne(videoId)
        .catch((error: unknown) => {
          // Already handled per-video below; this is the last resort.
          this.logger.error(`Probe of ${videoId} failed: ${describeError(error)}`);
        })
        .finally(() => {
          this.active -= 1;
          this.queued.delete(videoId);
          this.pump();
        });
    }
  }

  private async processOne(videoId: string): Promise<void> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: {
        id: true,
        storageKey: true,
        playbackKey: true,
        posterKey: true,
        posterSource: true,
        bannerKey: true,
        bannerSource: true,
      },
    });
    if (!video) return;

    // Probe what will actually be played, so a converted file reports its own
    // dimensions rather than the source's.
    const root = video.playbackKey ? playbackRoot(video.playbackKey) : 'media';
    const key = video.playbackKey ?? video.storageKey;
    const path = this.storage.resolvePath(root, key);

    /** Hoisted so the poster below can read it after the probe's catch. */
    let durationSec: number | null;

    try {
      const probe = await this.ffmpeg.probe(path);
      const extension = extname(key).replace('.', '').toLowerCase();

      const verdict = needsConversion({
        extension,
        videoCodec: probe.videoCodec,
        audioCodec: probe.audioCodec,
        pixelFormat: probe.pixelFormat,
        videoProfile: probe.videoProfile,
      });

      await this.prisma.video.update({
        where: { id: video.id },
        data: {
          durationSec: probe.durationSec,
          width: probe.width,
          height: probe.height,
          videoCodec: probe.videoCodec,
          audioCodec: probe.audioCodec,
          audioTracks: probe.audioTracks,
          // A converted file is by definition not awaiting conversion.
          needsConversion: video.playbackKey ? false : verdict.needed,
          probedAt: new Date(),
          probeError: null,
        },
      });

      durationSec = probe.durationSec;
    } catch (error) {
      // Recorded rather than thrown: one unreadable file must not stop a scan,
      // and the admin needs to see which file and why.
      this.logger.warn(`Probe failed for ${key}: ${describeError(error)}`);
      await this.prisma.video.update({
        where: { id: video.id },
        data: { probeError: describeError(error).slice(0, 1000), probedAt: new Date() },
      });
      return;
    }

    /**
     * The poster is generated **outside** the probe's catch, and its failure is
     * logged rather than stored.
     *
     * It used to sit inside the try above, so a capture that failed was written
     * to `probeError` — on a row whose probe had just succeeded and stored a
     * duration, dimensions and codecs. The admin then sees a file reported as
     * unreadable in the ingest list while it plays and edits perfectly well,
     * which is what was reported from a real library.
     *
     * A missing poster is a missing picture. It is not a reason to call the
     * video broken, and `probeError` is the field that says it is.
     */
    await this.generateArtwork(video, durationSec);
  }

  /**
   * Generates both shapes from the frame 10% in — each **only** while its own
   * source is `AUTO`.
   *
   * Artwork someone chose by hand is never overwritten by a reprobe, and the two
   * are tracked separately so that rule can apply to one and not the other: an
   * admin picks a real poster for a film and still gets a fresh banner whenever
   * the file is re-probed.
   *
   * Each shape is attempted and reported independently. Sharing one `try` meant
   * a poster that failed took the banner with it, and a video would come out of
   * a probe with neither picture because one crop went wrong.
   *
   * The failures are logged, never written to `probeError`. That field says the
   * *file* is unreadable, and a video whose probe just succeeded — duration,
   * dimensions, codecs all stored — must not be listed as broken because a
   * picture could not be cut from it. It read that way in a real library once.
   */
  private async generateArtwork(
    video: {
      id: string;
      storageKey: string;
      playbackKey: string | null;
      posterSource: string;
      bannerSource: string;
    },
    durationSec: number | null,
  ): Promise<void> {
    if (durationSec === null) return;

    const source = this.storage.resolvePath(
      video.playbackKey ? playbackRoot(video.playbackKey) : 'media',
      video.playbackKey ?? video.storageKey,
    );
    const atSeconds = durationSec * THUMBNAIL_POSITION;
    const sources: Record<ArtworkShape, string> = {
      poster: video.posterSource,
      banner: video.bannerSource,
    };

    for (const shape of ARTWORK_SHAPES) {
      if (sources[shape] !== 'AUTO') continue;

      try {
        const key = await this.writeArtwork(video.id, source, atSeconds, shape);
        await this.prisma.video.update({
          where: { id: video.id },
          data:
            shape === 'poster'
              ? { posterKey: key, posterSource: 'AUTO' }
              : { bannerKey: key, bannerSource: 'AUTO' },
        });
      } catch (error) {
        this.logger.warn(`${shape} failed for ${video.storageKey}: ${describeError(error)}`);
      }
    }
  }

  /**
   * Captures a frame into place **atomically**.
   *
   * ffmpeg truncates its output the moment it opens it, so writing straight to
   * `banners/<id>.jpg` leaves the poster missing or half-written for as long
   * as the capture takes. Every card in the app asks for that URL, so a routine
   * re-probe made artwork across the library flicker to a broken image — and it
   * is a 404, not a stale picture, which is worse. Three viewer tests caught it
   * when a boot-time reconcile re-probed everything mid-run.
   *
   * So it goes to `derived/tmp/` first and is renamed in on success, the same
   * way a transcode does. `rename` within DERIVED_ROOT is atomic and stays on
   * one filesystem; a reader either sees the old poster or the new one, never
   * neither. A failed capture leaves the live file untouched.
   */
  private async writeArtwork(
    videoId: string,
    source: string,
    atSeconds: number,
    shape: ArtworkShape,
  ): Promise<string> {
    const key = artworkKey(shape, videoId);
    // Per shape, or capturing both at once has them writing the same temp file.
    const temporaryKey = `tmp/${videoId}-${shape}.jpg`;

    // Into DERIVED_ROOT, never the watched media tree — generated output
    // landing there feeds the ingest watcher its own work.
    await this.storage.ensureDirectory('derived', artworkDirectory(shape));
    await this.storage.ensureDirectory('derived', 'tmp');

    try {
      await this.ffmpeg.captureFrame(
        source,
        atSeconds,
        this.storage.resolvePath('derived', temporaryKey),
        captureFilter(shape),
      );
      await this.storage.move('derived', temporaryKey, key);
    } catch (error) {
      // A half-written frame must not be left where the next run might rename
      // it into place.
      await this.storage.delete('derived', temporaryKey);
      throw error;
    }

    return key;
  }

  /** Re-runs a probe on demand, and waits for it — the admin clicked a button and expects an answer. */
  async reprobe(videoId: string): Promise<void> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true },
    });
    if (!video) throw new NotFoundException('No such video');

    this.enqueue(videoId);
    await this.drain();
  }

  /**
   * Captures one shape at a chosen timestamp and marks it MANUAL, so a later
   * reprobe leaves it alone.
   *
   * Only the shape asked for. Capturing both from one click would silently undo
   * a poster the admin had already chosen by hand, on the way to fixing a
   * banner.
   */
  async captureArtwork(videoId: string, atSeconds: number, shape: ArtworkShape): Promise<string> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true, storageKey: true, playbackKey: true, durationSec: true },
    });
    if (!video) throw new NotFoundException('No such video');

    const source = this.storage.resolvePath(
      video.playbackKey ? playbackRoot(video.playbackKey) : 'media',
      video.playbackKey ?? video.storageKey,
    );

    let key: string;
    try {
      key = await this.writeArtwork(video.id, source, atSeconds, shape);
    } catch (error) {
      /**
       * A timestamp with no frame at it is a bad request, not a server fault.
       *
       * The admin picked the moment; telling them the file has nothing there
       * is the whole answer, and a 500 saying "Internal server error" is not
       * something anyone can act on.
       */
      if (error instanceof NoFrameError) throw new BadRequestException(error.message);
      throw error;
    }

    await this.prisma.video.update({
      where: { id: video.id },
      data: manual(shape, key),
    });

    return key;
  }

  /** Stores an uploaded image as one shape. Also MANUAL — someone chose it. */
  async setArtwork(
    videoId: string,
    image: Buffer,
    extension: string,
    shape: ArtworkShape,
  ): Promise<string> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true },
    });
    if (!video) throw new NotFoundException('No such video');

    // An uploaded picture keeps its own extension, so the key is not quite
    // `artworkKey()` — that one names the JPEG a capture always produces.
    const key = `${artworkDirectory(shape)}/${video.id}.${extension}`;
    await this.storage.save('derived', key, image);

    await this.prisma.video.update({
      where: { id: video.id },
      data: manual(shape, key),
    });

    return key;
  }

  /**
   * Drops one shape and returns it to automatic.
   *
   * Deliberately does not regenerate here — the next probe will, and doing both
   * would make "remove" mean "replace".
   */
  async clearArtwork(videoId: string, shape: ArtworkShape): Promise<void> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true, posterKey: true, bannerKey: true },
    });
    if (!video) throw new NotFoundException('No such video');

    const existing = shape === 'poster' ? video.posterKey : video.bannerKey;
    if (existing) {
      await this.storage.delete('derived', existing);
    }

    await this.prisma.video.update({
      where: { id: video.id },
      data:
        shape === 'poster'
          ? { posterKey: null, posterSource: 'AUTO' }
          : { bannerKey: null, bannerSource: 'AUTO' },
    });
  }
}

/**
 * A collection's artwork override.
 *
 * Separate from the video methods above because a collection has **no file of
 * its own** — there is nothing to seek into, so there is no capture, only an
 * upload and a reset. And "reset" here means *go back to inheriting*, not
 * "remove the picture": clearing the key returns the collection to its first
 * video's artwork, which is what it showed before anyone overrode it.
 */
@Injectable()
export class CollectionArtworkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async set(
    collectionId: string,
    image: Buffer,
    extension: string,
    shape: ArtworkShape,
  ): Promise<string> {
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { id: true },
    });
    if (!collection) throw new NotFoundException('No such collection');

    // Under the collection's own id, so it cannot collide with a video's.
    const key = `${artworkDirectory(shape)}/collection-${collection.id}.${extension}`;
    await this.storage.save('derived', key, image);

    await this.prisma.collection.update({
      where: { id: collection.id },
      data: shape === 'poster' ? { posterKey: key } : { bannerKey: key },
    });

    return key;
  }

  /** Drops the override. The collection goes back to its first video's picture. */
  async clear(collectionId: string, shape: ArtworkShape): Promise<void> {
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { id: true, posterKey: true, bannerKey: true },
    });
    if (!collection) throw new NotFoundException('No such collection');

    const existing = artworkKeyOf(collection, shape);
    if (existing) {
      await this.storage.delete('derived', existing);
    }

    await this.prisma.collection.update({
      where: { id: collection.id },
      data: artworkKeyPatch(shape, null),
    });
  }
}

/** The update for "an admin chose this one", for whichever shape they chose. */
const manual = manualArtworkPatch;

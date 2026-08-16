import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  toPage,
  type ListVideosQuery,
  type Page,
  type UpdateMarkersInput,
  type UpdateVideoInput,
} from '@video/shared';

import { whereEpisode, whereFilm } from '../common/films';
import { narrowToVisibleStates, videoMissingFields, whereVisible } from '../common/publishing';
import { slugify, uniqueSlug } from '../common/slug';
import { StorageService } from '../common/storage.service';
import { titleUpdate } from '../common/title';
import type { Role } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';
import { playbackRoot } from '../transcode/converted-key';
import {
  derivedKeysToDelete,
  mediaKeysToDelete,
  playbackKeysToDelete,
  subtitleDirectoryKey,
} from './deletion';
import { validateMarkers, type Markers } from './markers';

/**
 * Every "which collection" filter, as **one** clause.
 *
 * They all constrain the same relation, so spread separately they overwrite
 * each other rather than combining — `?collectionId=X&seasonId=Y` silently
 * dropped the collection and answered about the season alone. Building the
 * clause once is what makes that impossible rather than merely unlikely.
 *
 * `film` is the odd one: it asks whether the join exists *at all* rather than
 * what it points at — see `common/films.ts` — so it is `none`/`some` over the
 * whole relation and cannot be folded into the membership object below.
 * Omitted means "do not filter"; `false` asks for the videos a shelf claims.
 */
function membershipFilter(query: ListVideosQuery) {
  if (query.film === true) return whereFilm();
  if (query.film === false) return whereEpisode();

  const membership = {
    ...(query.collectionId ? { collectionId: query.collectionId } : {}),
    ...(query.seasonId ? { seasonId: query.seasonId } : {}),
  };

  if (Object.keys(membership).length === 0) return {};

  return { collections: { some: membership } };
}

const VIDEO_SELECT = {
  id: true,
  slug: true,
  // Every collection it belongs to, with where it sits in each. A video with an
  // empty array is standalone, which is an ordinary thing to be rather than a
  // video that has lost its parent.
  collections: {
    select: {
      collectionId: true,
      seasonId: true,
      orderIndex: true,
      collection: { select: { id: true, slug: true, title: true, state: true } },
    },
  },
  title: true,
  description: true,
  year: true,
  tags: true,
  // Imported metadata. `tmdbId`/`tmdbType` come back so the admin screen can show
  // a title as already matched rather than offering to match it again.
  tmdbId: true,
  tmdbType: true,
  imdbId: true,
  genres: true,
  tagline: true,
  originalTitle: true,
  originalLanguage: true,
  releaseDate: true,
  certification: true,
  tmdbRating: true,
  tmdbVoteCount: true,
  metadataUpdatedAt: true,
  state: true,
  origin: true,
  storageKey: true,
  playbackKey: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  durationSec: true,
  width: true,
  height: true,
  videoCodec: true,
  audioCodec: true,
  audioTracks: true,
  needsConversion: true,
  probedAt: true,
  probeError: true,
  missingSince: true,
  // Whether the source was reclaimed, so a screen offering to delete the file
  // can tell that there is no longer one to delete.
  sourceDeletedAt: true,
  posterKey: true,
  posterSource: true,
  bannerKey: true,
  bannerSource: true,
  // So the editor can say whether the default track is a choice or a rule.
  subtitleDefaultSource: true,
  trailerYoutubeId: true,
  introStartSec: true,
  introEndSec: true,
  outroStartSec: true,
  outroEndSec: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class VideosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * There is no `create` here on purpose. A video row exists because a file
   * exists — created by ingest (step 9) or upload (step 13), never conjured
   * from a request body.
   */
  async list(query: ListVideosQuery, role: Role): Promise<Page<unknown>> {
    const where = {
      ...membershipFilter(query),
      ...(query.tag ? { tags: { has: query.tag } } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' as const } },
              { description: { contains: query.q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      // Spread last: this is the constraint nothing else may overwrite.
      ...narrowToVisibleStates(role, query.state),
    };

    const [videos, total] = await this.prisma.$transaction([
      this.prisma.video.findMany({
        where,
        select: VIDEO_SELECT,
        /**
         * `id` last makes the order total. `title` repeats, and offset paging
         * over a non-total order repeats and skips rows between pages.
         *
         * Season and running order used to lead this list, back when a video had
         * one parent to be ordered within. They are membership facts now, and a
         * video in two collections has two of them — there is no single order to
         * sort a library-wide listing by. A collection's own page still shows its
         * videos in order; that read goes through the join.
         */
        orderBy: [{ title: 'asc' }, { id: 'asc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.video.count({ where }),
    ]);

    return toPage(
      videos.map((video) => this.withChecklist(video, role)),
      total,
      query,
    );
  }

  async findOne(id: string, role: Role) {
    const video = await this.prisma.video.findFirst({
      where: { id, ...whereVisible(role) },
      select: VIDEO_SELECT,
    });
    if (!video) throw new NotFoundException('No such video');

    return this.withChecklist(video, role);
  }

  /**
   * A video by its slug, which is how it is addressed now that it has a page of
   * its own rather than one borrowed from a collection.
   */
  async findBySlug(slug: string, role: Role) {
    const video = await this.prisma.video.findFirst({
      where: { slug, ...whereVisible(role) },
      select: VIDEO_SELECT,
    });
    if (!video) throw new NotFoundException('No such video');

    return this.withChecklist(video, role);
  }

  /**
   * Edits the video itself, and only that.
   *
   * Which collections it belongs to, which season, and in what order are facts
   * about a membership — `POST/DELETE /collections/:id/videos` and
   * `PATCH /collections/:id/videos/order` own those, and each names the
   * collection it is acting on.
   */
  async update(id: string, dto: UpdateVideoInput) {
    const video = await this.prisma.video.findUnique({
      where: { id },
      select: { id: true, title: true },
    });
    if (!video) throw new NotFoundException('No such video');

    const slug = dto.regenerateSlug
      ? await this.freeSlug(slugify(dto.title ?? video.title), id)
      : undefined;

    return this.prisma.video.update({
      where: { id },
      data: {
        // Carries normalisedTitle with it — see common/title.ts.
        ...titleUpdate(dto.title),
        description: dto.description,
        year: dto.year,
        tags: dto.tags,
        // Imported metadata, editable by hand. Each name has to appear here as
        // well as in the schema: `data` is built field by field, so a field
        // added only to the schema is silently dropped and the PATCH still
        // answers 200 with a response that looks right. That is what happened
        // with `trailerYoutubeId`, which is why the db-spec asserts the round
        // trip rather than the status code.
        //
        // `undefined` leaves each alone and `null` clears it, which is exactly
        // what Prisma does with each — so the schema's "omitted vs explicitly
        // empty" distinction survives all the way to the column.
        tagline: dto.tagline,
        genres: dto.genres,
        certification: dto.certification,
        originalTitle: dto.originalTitle,
        originalLanguage: dto.originalLanguage,
        releaseDate: dto.releaseDate,
        imdbId: dto.imdbId,
        trailerYoutubeId: dto.trailerYoutubeId,
        slug,
      },
      select: VIDEO_SELECT,
    });
  }

  /**
   * Removes the video, and its source file only when asked.
   *
   * Two different things are on disk and they are governed differently.
   * Everything under `DERIVED_ROOT` — poster, banner, converted file, subtitle
   * tracks — is regenerable output belonging to a row that is about to stop
   * existing, so it **always** goes: nothing else sweeps it, and leaving it
   * means a delete quietly leaks files nobody can ever reach again. The source
   * under `MEDIA_ROOT` is the archival copy and goes **only** on request,
   * because reconcile can rebuild the row from it and the default has to be the
   * recoverable mistake rather than the other one.
   *
   * Which also means a plain delete does not stick while the source is there:
   * the next scan finds the file, and creates a fresh draft with none of the
   * curation the old row carried. That is the honest behaviour and the admin UI
   * says so outright — it is not something to paper over here, because the
   * alternative is destroying media by default.
   *
   * Every key is read **before** the delete. All of them live on this row or on
   * a `Subtitle` row, both of which the cascade takes; afterwards there is
   * nothing left to say what to clean up.
   */
  async remove(id: string, deleteFiles: boolean): Promise<void> {
    const video = await this.prisma.video.findUnique({
      where: { id },
      select: {
        id: true,
        storageKey: true,
        playbackKey: true,
        posterKey: true,
        bannerKey: true,
        sourceDeletedAt: true,
        subtitles: { select: { storageKey: true, sourceKey: true } },
      },
    });
    if (!video) throw new NotFoundException('No such video');

    /**
     * A conversion in flight would be updating a row the cascade had taken.
     *
     * `MediaJob` is `onDelete: Cascade`, and `JobsService` holds its running
     * job and its cancellation handles in memory. Deleting the video under one
     * leaves ffmpeg writing to a path whose row is gone, and the job's own
     * bookkeeping then fails against a row that no longer exists — including
     * inside its `catch`, so the rejection escapes as an unhandled one rather
     * than surfacing anywhere a person would see it.
     *
     * `QUEUED` counts as well as `RUNNING`: guarding only the latter leaves the
     * window between the queue picking a job up and it being marked started.
     */
    const activeJob = await this.prisma.mediaJob.findFirst({
      where: { videoId: id, status: { in: ['QUEUED', 'RUNNING'] } },
      select: { id: true },
    });
    if (activeJob) {
      throw new BadRequestException(
        'A job is still running for this video. Cancel it before deleting.',
      );
    }

    /**
     * A reclaimed video's converted file is not derived output; it is the only
     * copy left.
     *
     * Reclaiming the source is allowed *because* the converted file replaces
     * it, which is why that operation refuses unless the replacement is really
     * there. Sweeping it up here as regenerable would destroy the film through
     * the button labelled as the safe one — so the safe one refuses instead,
     * and the caller has to say they mean it.
     */
    const converted = video.playbackKey;
    if (
      !deleteFiles
      && video.sourceDeletedAt !== null
      && converted !== null
      && (await this.storage.exists(playbackRoot(converted), converted))
    ) {
      throw new BadRequestException(
        'The converted file is the only copy of this video, because its source was reclaimed. '
          + 'Delete it with its files to remove the entry.',
      );
    }

    await this.prisma.video.delete({ where: { id } });

    for (const key of derivedKeysToDelete(video)) {
      await this.storage.delete('derived', key);
    }
    await this.storage.delete('derived', subtitleDirectoryKey(id));

    /*
     * Before the `deleteFiles` gate, not after it.
     *
     * The converted file sits in the watched tree, and the only thing that kept
     * ingest from reading it as a video was the row that just stopped existing.
     * Leaving it behind on a recoverable delete would put the entry straight
     * back on the next scan, under a new id and with none of its history.
     */
    for (const key of playbackKeysToDelete(video)) {
      await this.storage.delete(playbackRoot(key), key);
    }

    if (!deleteFiles) return;

    for (const key of mediaKeysToDelete(video)) {
      await this.storage.delete('media', key);
    }

    /*
     * The folder the file sat in is deliberately left alone, unlike a season's.
     *
     * A season row is rebuilt from a *directory*, which is why an empty one has
     * to go or the season comes back. A video row is rebuilt from a *file*, and
     * that file is now gone, so the delete sticks either way and an empty
     * folder is inert. Meanwhile a video's parent is very often a season folder
     * with a live `Season` row pointing at it, and removing that out from under
     * the row would be the same bug the other way round.
     */
  }

  /**
   * Sets, adjusts or clears the skip markers.
   *
   * The patch is merged onto what is already stored **before** validating, not
   * after. Setting only `introEndSec` has to be checked against the
   * `introStartSec` already in the database — validating the patch alone would
   * accept an end before a start it could not see.
   */
  async updateMarkers(id: string, patch: UpdateMarkersInput) {
    const video = await this.prisma.video.findUnique({
      where: { id },
      select: {
        id: true,
        durationSec: true,
        introStartSec: true,
        introEndSec: true,
        outroStartSec: true,
        outroEndSec: true,
      },
    });
    if (!video) throw new NotFoundException('No such video');

    const merged: Markers = {
      // `undefined` means "leave alone"; an explicit `null` means "clear".
      introStartSec: patch.introStartSec === undefined ? video.introStartSec : patch.introStartSec,
      introEndSec: patch.introEndSec === undefined ? video.introEndSec : patch.introEndSec,
      outroStartSec: patch.outroStartSec === undefined ? video.outroStartSec : patch.outroStartSec,
      outroEndSec: patch.outroEndSec === undefined ? video.outroEndSec : patch.outroEndSec,
    };

    const issues = validateMarkers(merged, video.durationSec);
    if (issues.length > 0) {
      // Same shape the validation pipe produces, so the editor renders marker
      // errors the way it renders every other field error.
      throw new BadRequestException({ message: 'Validation failed', errors: issues });
    }

    return this.prisma.video.update({
      where: { id },
      data: merged,
      select: VIDEO_SELECT,
    });
  }

  async publish(id: string) {
    const video = await this.prisma.video.findUnique({
      where: { id },
      select: { id: true, title: true, description: true, durationSec: true, bannerKey: true },
    });
    if (!video) throw new NotFoundException('No such video');

    const missingFields = videoMissingFields(video);
    if (missingFields.length > 0) {
      // The checklist comes back with the rejection so the UI does not have to
      // ask a second time to find out what is wrong.
      throw new BadRequestException({
        message: 'This video is not ready to publish',
        missingFields,
      });
    }

    return this.prisma.video.update({
      where: { id },
      data: { state: 'PUBLISHED' },
      select: VIDEO_SELECT,
    });
  }

  async archive(id: string) {
    const video = await this.prisma.video.findUnique({ where: { id }, select: { id: true } });
    if (!video) throw new NotFoundException('No such video');

    return this.prisma.video.update({
      where: { id },
      data: { state: 'ARCHIVED' },
      select: VIDEO_SELECT,
    });
  }

  /**
   * Video slugs are unique library-wide.
   *
   * They used to be scoped to a collection, so two shows could both have a
   * `pilot`. A video is addressed at `/v/<slug>` on its own now, so the scope
   * has to be the library — and `pilot-2` is what the shared numbering gives the
   * second one.
   */
  private async freeSlug(base: string, exceptId?: string): Promise<string> {
    const taken = await this.prisma.video.findMany({
      where: exceptId ? { NOT: { id: exceptId } } : undefined,
      select: { slug: true },
    });

    return uniqueSlug(
      base,
      taken.map((row) => row.slug),
    );
  }

  /** The publish checklist is admin-facing; a USER only ever sees published videos anyway. */
  private withChecklist<
    T extends {
      title: string;
      description: string | null;
      durationSec: number | null;
      bannerKey: string | null;
    },
  >(video: T, role: Role) {
    return role === 'ADMIN' ? { ...video, missingFields: videoMissingFields(video) } : video;
  }
}

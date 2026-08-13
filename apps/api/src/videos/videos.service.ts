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
import { titleUpdate } from '../common/title';
import type { Role } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';
import { validateMarkers, type Markers } from './markers';

/**
 * Every "which collection" filter, as **one** clause.
 *
 * They all constrain the same relation, so spread separately they overwrite
 * each other rather than combining — `?collectionId=X&seasonId=Y` silently
 * dropped the collection and answered about the season alone. Building the
 * clause once is what makes that impossible rather than merely unlikely.
 *
 * `film` is the odd one: it is a fact about the *seasons behind* the join —
 * see `common/films.ts` — so it is `none`/`some` across two relations and
 * cannot be folded into the membership object below. Omitted means "do not
 * filter"; `false` asks for the episodes.
 */
function membershipFilter(query: ListVideosQuery, role: Role) {
  if (query.film === true) return whereFilm(role);
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
  bannerKey: true,
  bannerSource: true,
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
  constructor(private readonly prisma: PrismaService) {}

  /**
   * There is no `create` here on purpose. A video row exists because a file
   * exists — created by ingest (step 9) or upload (step 13), never conjured
   * from a request body.
   */
  async list(query: ListVideosQuery, role: Role): Promise<Page<unknown>> {
    const where = {
      ...membershipFilter(query, role),
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
   * Removes the row only. The file stays, so this is not a way to free disk
   * space — and reconcile will recreate the row on the next scan unless the
   * file is removed too. Reclaiming source files is `DELETE /videos/:id/source`
   * in step 12, which is a different operation with different consequences.
   */
  async remove(id: string): Promise<void> {
    const video = await this.prisma.video.findUnique({ where: { id }, select: { id: true } });
    if (!video) throw new NotFoundException('No such video');

    await this.prisma.video.delete({ where: { id } });
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

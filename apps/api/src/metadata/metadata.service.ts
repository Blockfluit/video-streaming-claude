import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  toPage,
  type ApplyMetadataInput,
  type MetadataField,
  type Page,
  type SearchMetadataQuery,
  type TmdbType,
} from '@video/shared';

import { buildDiff, COLLECTION_FIELDS, VIDEO_FIELDS, type FieldDiff } from './diff';
import { TmdbClient } from './tmdb.client';
import { mapEpisodes, mapSearchResults, mapTitle, type MetadataProposal } from './tmdb.mapper';
import { isUniqueViolation } from '../common/errors';
import { titleUpdate } from '../common/title';
import { CollectionArtworkService, MediaService } from '../media/media.service';
import { PeopleService } from '../people/people.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Matching a title against TMDB and writing what an admin approves.
 *
 * The shape of this is one decision: **search, preview, apply**, with a person
 * between the second and the third. Nothing here writes on its own, which is why
 * there are no per-field provenance columns anywhere in the schema — the record
 * of "was this typed or imported?" is that somebody looked at a diff and ticked
 * boxes.
 *
 * A film in this library is a video belonging to no collection, so both a
 * `Collection` and a `Video` are importable targets. The two differ only in
 * which fields exist and where credits land.
 */

export type Target = { kind: 'collection' | 'video'; id: string };

export interface MetadataPreview {
  target: Target;
  tmdbId: number;
  tmdbType: TmdbType;
  imdbId: string | null;
  fields: FieldDiff[];
  credits: { cast: number; crew: number };
  artwork: { poster: boolean; banner: boolean; posterIsManual: boolean; bannerIsManual: boolean };
  episodes: { seasons: number } | null;
}

@Injectable()
export class MetadataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tmdb: TmdbClient,
    private readonly people: PeopleService,
    private readonly media: MediaService,
    private readonly collectionArtwork: CollectionArtworkService,
  ) {}

  async search(query: SearchMetadataQuery): Promise<Page<unknown>> {
    const response = await this.tmdb.searchTitles(query.title, query.type, query.year);
    const all = mapSearchResults(response, query.type ?? 'movie');

    // TMDB pages at twenty and this pages at whatever was asked for, so the
    // window is applied here. `total` is the number actually retrieved rather
    // than TMDB's count: claiming a hundred results and serving twenty is worse
    // than saying twenty.
    const items = all.slice(query.offset, query.offset + query.limit);
    return toPage(items, all.length, query);
  }

  async preview(target: Target, tmdbId: number, type: TmdbType): Promise<MetadataPreview> {
    const current = await this.load(target);
    const detail = await this.tmdb.titleDetail(tmdbId, type);
    const proposal = mapTitle(detail, type, this.tmdb.certificationCountry);

    return {
      target,
      tmdbId: proposal.tmdbId,
      tmdbType: proposal.tmdbType,
      imdbId: proposal.imdbId,
      fields: buildDiff(current.metadata, proposal, fieldsFor(target)),
      credits: { cast: proposal.cast.length, crew: proposal.crew.length },
      artwork: {
        poster: proposal.posterPath !== null,
        banner: proposal.backdropPath !== null,
        // Surfaced rather than silently skipped: an admin who chose a poster by
        // hand should be told that this would replace it, not have the checkbox
        // quietly do nothing.
        posterIsManual: current.posterIsManual,
        bannerIsManual: current.bannerIsManual,
      },
      episodes:
        type === 'tv' && target.kind === 'collection'
          ? { seasons: proposal.seasonCount ?? 0 }
          : null,
    };
  }

  async apply(target: Target, dto: ApplyMetadataInput): Promise<MetadataPreview> {
    await this.load(target);

    const detail = await this.tmdb.titleDetail(dto.tmdbId, dto.type);
    const proposal = mapTitle(detail, dto.type, this.tmdb.certificationCountry);

    // Everything that talks to TMDB happens before the transaction. Holding one
    // open across a network call ties a database connection to somebody else's
    // latency, and artwork is the slowest part of this by far.
    const artwork = dto.includeArtwork ? await this.downloadArtwork(proposal) : null;
    const episodes =
      dto.includeEpisodes && dto.type === 'tv' && target.kind === 'collection'
        ? await this.loadEpisodes(dto.tmdbId, proposal.seasonCount ?? 0)
        : [];

    await this.writeFields(target, proposal, dto.fields);

    if (dto.includeCredits) {
      await this.writeCredits(target, proposal);
    }
    if (artwork !== null) {
      await this.writeArtwork(target, artwork);
    }
    if (episodes.length > 0) {
      await this.writeEpisodes(target.id, episodes);
    }

    return this.preview(target, dto.tmdbId, dto.type);
  }

  /**
   * Forgets which TMDB title this is, and nothing else.
   *
   * Only the pair the unique index is on, plus the timestamp that describes it.
   * Every descriptive field stays: an admin approved those one at a time, and
   * unmatching means "this is not that title", not "throw away my work". The
   * IMDb id stays too — it is editable by hand and may be right even when the
   * TMDB match was not.
   *
   * This exists because the conflict message already told admins to unmatch and
   * there was no way to: releasing a title for another collection was
   * impossible without editing the database.
   */
  async unmatch(target: Target): Promise<void> {
    await this.load(target);

    const data = { tmdbId: null, tmdbType: null, metadataUpdatedAt: null };

    if (target.kind === 'collection') {
      await this.prisma.collection.update({ where: { id: target.id }, data });
    } else {
      await this.prisma.video.update({ where: { id: target.id }, data });
    }
  }

  /**
   * Writes the approved fields, and only those.
   *
   * Built by walking the *allowed* list rather than the proposal, so a field
   * name that is not in `METADATA_FIELDS` cannot reach a column even if a client
   * sends one — the schema rejects it first, and this would ignore it anyway.
   */
  private async writeFields(
    target: Target,
    proposal: MetadataProposal,
    fields: readonly MetadataField[],
  ): Promise<void> {
    const approved = new Set(fields);
    const allowed = fieldsFor(target);
    const data: Record<string, unknown> = {};

    for (const field of allowed) {
      if (!approved.has(field)) continue;
      const value = proposal[field];
      // The same rule the diff applies: a proposal with nothing to say about a
      // field never empties it. Without this, ticking a box on a stale preview
      // could still clear a synopsis.
      if (value === null || (Array.isArray(value) && value.length === 0)) continue;

      if (field === 'title') {
        // Carries normalisedTitle with it, or the "already in the library?"
        // matching behind /requests silently stops seeing this row.
        Object.assign(data, titleUpdate(String(value)));
        continue;
      }
      data[field] = value;
    }

    // Always recorded, whatever was ticked: this is what makes the match itself
    // durable, so a re-import is an update and the IMDb link has something to
    // point at.
    data.tmdbId = proposal.tmdbId;
    data.tmdbType = proposal.tmdbType;
    data.imdbId = proposal.imdbId;
    data.metadataUpdatedAt = new Date();

    try {
      if (target.kind === 'collection') {
        await this.prisma.collection.update({ where: { id: target.id }, data });
      } else {
        await this.prisma.video.update({ where: { id: target.id }, data });
      }
    } catch (error) {
      // Caught rather than checked for: check-then-write has a gap, and the
      // unique index is what actually decides. Untranslated this surfaces as
      // "Internal server error", which tells an admin who has matched the wrong
      // title nothing about what to do next.
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Another collection is already matched to that title. Unmatch it there first.',
        );
      }
      throw error;
    }
  }

  /**
   * Creates every cast and crew credit that is not already there.
   *
   * Additive on purpose. A re-import must not renumber `position`, which is
   * drag-reordered by hand, and must not delete a credit an admin added — so
   * this only ever inserts what is missing.
   */
  private async writeCredits(target: Target, proposal: MetadataProposal): Promise<void> {
    const proposed = [...proposal.cast, ...proposal.crew];
    if (proposed.length === 0) return;

    const people = await this.people.resolveMany(proposed);
    const parent =
      target.kind === 'collection' ? { collectionId: target.id } : { videoId: target.id };

    const existing = await this.prisma.credit.findMany({
      where: parent,
      select: { personId: true, role: true, jobTitle: true },
    });
    // Keyed on the job title as well as the role, because all but six jobs
    // collapse to OTHER — on (person, role) alone, a costume designer and a
    // stunt coordinator are the same credit and only one of them survives.
    const seen = new Set(existing.map((credit) => creditKey(credit)));

    const rows: {
      personId: string;
      role: MetadataProposal['cast'][number]['role'];
      characterName: string | null;
      jobTitle: string | null;
      department: string | null;
      position: number;
      collectionId?: string;
      videoId?: string;
    }[] = [];

    for (const credit of proposed) {
      const personId = people.get(credit.tmdbPersonId);
      if (personId === undefined) continue;

      const key = creditKey({ personId, role: credit.role, jobTitle: credit.jobTitle });
      if (seen.has(key)) continue;
      seen.add(key);

      rows.push({
        personId,
        role: credit.role,
        characterName: credit.characterName,
        jobTitle: credit.jobTitle,
        department: credit.department,
        position: credit.position,
        ...parent,
      });
    }

    if (rows.length > 0) {
      await this.prisma.credit.createMany({ data: rows });
    }
  }

  private async downloadArtwork(proposal: MetadataProposal) {
    const poster = proposal.posterPath
      ? await this.tmdb.fetchImage(proposal.posterPath)
      : null;
    // The backdrop is the landscape shape, which is what a hero and a card use.
    const banner = proposal.backdropPath
      ? await this.tmdb.fetchImage(proposal.backdropPath)
      : null;

    return { poster, banner };
  }

  private async writeArtwork(
    target: Target,
    artwork: { poster: Image | null; banner: Image | null },
  ): Promise<void> {
    for (const [shape, image] of [
      ['poster', artwork.poster],
      ['banner', artwork.banner],
    ] as const) {
      if (image === null) continue;

      if (target.kind === 'collection') {
        await this.collectionArtwork.set(target.id, image.body, image.extension.slice(1), shape);
      } else {
        // Goes in as MANUAL, which is what stops the next reprobe replacing a
        // real poster with a frame grabbed 10% into the file.
        await this.media.setArtwork(target.id, image.body, image.extension.slice(1), shape);
      }
    }
  }

  private async loadEpisodes(tmdbId: number, seasonCount: number) {
    const seasons = Math.min(Math.max(seasonCount, 0), MAX_SEASONS);
    const all = [];

    for (let number = 1; number <= seasons; number += 1) {
      // Sequential rather than parallel: this is a courtesy to a free API, and
      // a series import is a handful of requests either way.
      const season = await this.tmdb.seasonDetail(tmdbId, number);
      all.push(...mapEpisodes(season));
    }

    return all;
  }

  /**
   * Fills each episode's own title, synopsis and air date.
   *
   * Matched on `orderIndex` within a season, which is the only number the
   * library has for "which episode is this". An episode with no order index is
   * one ingest could not number, and guessing at it would put the wrong synopsis
   * on the wrong episode — which is worse than leaving it blank.
   */
  private async writeEpisodes(
    collectionId: string,
    episodes: Awaited<ReturnType<MetadataService['loadEpisodes']>>,
  ): Promise<void> {
    const memberships = await this.prisma.collectionVideo.findMany({
      where: { collectionId },
      select: { videoId: true, orderIndex: true, season: { select: { number: true } } },
    });

    const byNumber = new Map(
      episodes.map((episode) => [`${episode.seasonNumber ?? ''}:${episode.episodeNumber}`, episode]),
    );

    for (const membership of memberships) {
      if (membership.orderIndex === null) continue;

      const episode = byNumber.get(`${membership.season?.number ?? ''}:${membership.orderIndex}`);
      if (episode === undefined) continue;

      await this.prisma.video.update({
        where: { id: membership.videoId },
        data: {
          ...(episode.title ? titleUpdate(episode.title) : {}),
          ...(episode.description ? { description: episode.description } : {}),
          ...(episode.releaseDate ? { releaseDate: episode.releaseDate } : {}),
        },
      });
    }
  }

  /** The row's current values, in the proposal's field names. */
  private async load(target: Target) {
    if (target.kind === 'collection') {
      const collection = await this.prisma.collection.findUnique({
        where: { id: target.id },
        select: {
          title: true,
          description: true,
          tagline: true,
          year: true,
          releaseDate: true,
          genres: true,
          certification: true,
          originalTitle: true,
          originalLanguage: true,
          tmdbRating: true,
          seriesStatus: true,
          seasonCount: true,
          episodeCount: true,
          trailerYoutubeId: true,
        },
      });
      if (!collection) throw new NotFoundException('No such collection');

      // A collection's artwork is an override rather than a generated picture,
      // so there is no AUTO/MANUAL to respect — setting one is always deliberate.
      return { metadata: collection, posterIsManual: false, bannerIsManual: false };
    }

    const video = await this.prisma.video.findUnique({
      where: { id: target.id },
      select: {
        title: true,
        description: true,
        tagline: true,
        year: true,
        releaseDate: true,
        genres: true,
        certification: true,
        originalTitle: true,
        originalLanguage: true,
        tmdbRating: true,
        trailerYoutubeId: true,
        posterSource: true,
        bannerSource: true,
      },
    });
    if (!video) throw new NotFoundException('No such video');

    const { posterSource, bannerSource, ...metadata } = video;
    return {
      metadata,
      posterIsManual: posterSource === 'MANUAL',
      bannerIsManual: bannerSource === 'MANUAL',
    };
  }
}

interface Image {
  body: Buffer;
  extension: string;
}

/** A courtesy bound. A show with more seasons than this does not exist. */
const MAX_SEASONS = 50;

const fieldsFor = (target: Target): readonly MetadataField[] =>
  target.kind === 'collection' ? COLLECTION_FIELDS : VIDEO_FIELDS;

const creditKey = (credit: {
  personId: string;
  role: string;
  jobTitle: string | null;
}): string => `${credit.personId}:${credit.role}:${credit.jobTitle ?? ''}`;

export function targetFor(kind: 'collection' | 'video', id: string): Target {
  if (id.trim().length === 0) throw new BadRequestException('No such record');
  return { kind, id };
}

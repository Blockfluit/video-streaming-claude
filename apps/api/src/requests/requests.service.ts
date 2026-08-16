import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OPEN_REQUEST_STATUSES,
  normaliseTitle,
  toPage,
  type CreateRequestInput,
  type ListRequestsQuery,
  type Page,
  type UpdateRequestStatusInput,
} from '@video/shared';

import type { AuthUser } from '../auth/auth.types';
import { isUniqueViolation } from '../common/errors';
import { whereVisible } from '../common/publishing';
import type { Role } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';
import { toRequestView, type LibraryMatch, type RequestView } from './serialize';

const REQUEST_SELECT = {
  id: true,
  userId: true,
  title: true,
  normalisedTitle: true,
  year: true,
  comment: true,
  status: true,
  adminNote: true,
  statusChangedAt: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, username: true, displayName: true } },
  statusChangedBy: { select: { id: true, displayName: true } },
} as const;

@Injectable()
export class RequestsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every request, newest first, serialised for whoever is asking.
   *
   * Deliberately **not** filtered by who asked: the point of the page is that
   * everyone can see what has been requested and what came of it. What a
   * non-admin does not get is the names, and that is the serializer's job — this
   * method returns the same rows to everybody.
   */
  async list(user: AuthUser, query: ListRequestsQuery): Promise<Page<RequestView>> {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.mine === true ? { userId: user.id } : {}),
      ...(query.q ? { title: { contains: query.q, mode: 'insensitive' as const } } : {}),
    };

    const [requests, total] = await this.prisma.$transaction([
      this.prisma.videoRequest.findMany({
        where,
        select: REQUEST_SELECT,
        // `id` last so the order is total — two requests can share a timestamp.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.videoRequest.count({ where }),
    ]);

    /*
     * The library-match hints are looked up once for the whole page rather than
     * per row, and only for an admin — for anyone else they would be a way to
     * read the titles of drafts, which is the leak the whole visibility rule
     * exists to prevent.
     */
    const matches =
      user.role === 'ADMIN'
        ? await this.libraryMatches(requests.map((request) => request.normalisedTitle))
        : new Map<string, LibraryMatch>();

    return toPage(
      requests.map((request) =>
        toRequestView(request, user, matches.get(request.normalisedTitle) ?? null),
      ),
      total,
      query,
    );
  }

  /**
   * Asking for something new.
   *
   * Two things can refuse it, and they refuse it differently:
   *
   *  - It is **already in the library**, as far as this caller can see. Scoped
   *    to their visibility on purpose: refusing a USER because a DRAFT exists
   *    would tell them the draft exists, which is precisely what `whereVisible`
   *    is for. Their request goes through, and the admin — who can see both —
   *    gets the two shown side by side.
   *  - It has **already been requested** and that request is still open. Caught
   *    from the partial unique index rather than checked first: check-then-write
   *    has a gap, and two people submitting the same title land inside it.
   */
  async create(user: AuthUser, dto: CreateRequestInput): Promise<RequestView> {
    const normalisedTitle = normaliseTitle(dto.title);

    const existing = await this.findInLibrary(normalisedTitle, user.role);
    if (existing) {
      throw new ConflictException({
        message: `"${existing.title}" is already in the library.`,
        reason: 'ALREADY_IN_LIBRARY',
        match: existing,
      });
    }

    try {
      const request = await this.prisma.videoRequest.create({
        data: {
          userId: user.id,
          title: dto.title,
          normalisedTitle,
          year: dto.year ?? null,
          comment: dto.comment ?? null,
        },
        select: REQUEST_SELECT,
      });

      return toRequestView(request, user, null);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      throw new ConflictException({
        message: 'Somebody has already requested that, and it is still open.',
        reason: 'ALREADY_REQUESTED',
        requestId: await this.openRequestId(normalisedTitle),
      });
    }
  }

  /**
   * The admin's answer. ADMIN-only at the route — that is what makes the status
   * something a requester reads rather than something they set.
   *
   * Any status may follow any other. A state machine would read well and would
   * mostly get in the way: an admin who marks the wrong request AVAILABLE needs
   * to put it back, and there is no sequence of steps that is wrong to record.
   */
  async setStatus(
    id: string,
    user: AuthUser,
    dto: UpdateRequestStatusInput,
  ): Promise<RequestView> {
    const request = await this.require(id);

    try {
      const updated = await this.prisma.videoRequest.update({
        where: { id },
        data: {
          status: dto.status,
          // Omitted leaves the existing note alone; an explicit null clears it.
          // Without that distinction, moving SEEN to PROCESSING would silently
          // discard the explanation attached to the request.
          ...(dto.adminNote === undefined ? {} : { adminNote: dto.adminNote }),
          statusChangedAt: new Date(),
          statusChangedById: user.id,
        },
        select: REQUEST_SELECT,
      });

      const match = await this.findInLibrary(updated.normalisedTitle, user.role);
      return toRequestView(updated, user, match);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      /*
       * Reopening a settled request when another open one already holds that
       * title. Only one request per title may be open at a time, so this is the
       * index doing its job rather than a fault.
       */
      throw new ConflictException({
        message: 'Another request for that title is already open.',
        reason: 'ALREADY_REQUESTED',
        requestId: await this.openRequestId(request.normalisedTitle),
      });
    }
  }

  /**
   * Withdrawing a request. The author's own, or anyone's for an admin.
   *
   * A hard delete, unlike a comment: a comment is part of a conversation that
   * still has to read around the gap, and a withdrawn request is simply not
   * being asked for any more. Removing it also frees the title for someone else
   * to request, which a tombstone holding the unique index would not.
   */
  async remove(id: string, user: AuthUser): Promise<void> {
    const request = await this.require(id);

    if (request.userId !== user.id && user.role !== 'ADMIN') {
      throw new ForbiddenException('You can only withdraw your own requests');
    }

    await this.prisma.videoRequest.delete({ where: { id } });
  }

  private async require(id: string) {
    const request = await this.prisma.videoRequest.findUnique({
      where: { id },
      select: { id: true, userId: true, normalisedTitle: true, status: true },
    });
    if (!request) throw new NotFoundException('No such request');

    return request;
  }

  /** The open request holding a title, if there still is one. */
  private async openRequestId(normalisedTitle: string): Promise<string | null> {
    const open = await this.prisma.videoRequest.findFirst({
      // The same set the partial unique index filters on. Both come from
      // OPEN_REQUEST_STATUSES so the query and the constraint cannot drift.
      where: { normalisedTitle, status: { in: [...OPEN_REQUEST_STATUSES] } },
      select: { id: true },
    });

    return open?.id ?? null;
  }

  /**
   * Something in the library with the same normalised title, as far as `role`
   * may see.
   *
   * A collection is preferred over a video when both match. A film is stored as
   * a collection holding one video with the same title, so both hit — and the
   * collection is the page a person actually wants to land on.
   *
   * A row whose `normalisedTitle` is `''` — the sentinel for "not comparable",
   * which only an unbackfilled row can hold — can never match, because the
   * argument is derived from a title that had to be non-empty to validate.
   */
  private async findInLibrary(
    normalisedTitle: string,
    role: Role,
  ): Promise<LibraryMatch | null> {
    if (normalisedTitle.length === 0) return null;

    const [collection, video] = await this.prisma.$transaction([
      this.prisma.collection.findFirst({
        where: { normalisedTitle, ...whereVisible(role) },
        select: { id: true, slug: true, title: true, state: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.video.findFirst({
        where: { normalisedTitle, ...whereVisible(role) },
        select: {
          id: true,
          slug: true,
          title: true,
          state: true,
          collections: {
            select: {
              collection: { select: { slug: true, title: true } },
              season: { select: { slug: true } },
            },
          },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);

    if (collection) return { kind: 'collection', ...collection };
    if (video) return { kind: 'video', ...video };

    return null;
  }

  /**
   * The same lookup for a whole page at once, so a list of 100 requests costs
   * two queries rather than two hundred.
   *
   * Admin-only, and therefore unfiltered by visibility — a draft matching a
   * request is the single most useful thing this can say.
   */
  private async libraryMatches(normalisedTitles: string[]): Promise<Map<string, LibraryMatch>> {
    const wanted = [...new Set(normalisedTitles.filter((title) => title.length > 0))];
    if (wanted.length === 0) return new Map();

    const [collections, videos] = await this.prisma.$transaction([
      this.prisma.collection.findMany({
        where: { normalisedTitle: { in: wanted } },
        select: { id: true, slug: true, title: true, state: true, normalisedTitle: true },
      }),
      this.prisma.video.findMany({
        where: { normalisedTitle: { in: wanted } },
        select: {
          id: true,
          slug: true,
          title: true,
          state: true,
          normalisedTitle: true,
          collections: {
            select: {
              collection: { select: { slug: true, title: true } },
              season: { select: { slug: true } },
            },
          },
        },
      }),
    ]);

    const matches = new Map<string, LibraryMatch>();

    // Videos first, then collections overwrite them — same preference as
    // `findInLibrary`, expressed as insertion order rather than a branch.
    for (const { normalisedTitle, ...video } of videos) {
      if (!matches.has(normalisedTitle)) matches.set(normalisedTitle, { kind: 'video', ...video });
    }
    for (const { normalisedTitle, ...collection } of collections) {
      matches.set(normalisedTitle, { kind: 'collection', ...collection });
    }

    return matches;
  }
}

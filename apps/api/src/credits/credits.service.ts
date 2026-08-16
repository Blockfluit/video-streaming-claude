import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { toPage, type Page } from '@video/shared';
import type { CreateCreditInput, ReorderCreditsInput, UpdateCreditInput } from '@video/shared';

import { requireVisibleCollection, requireVisibleVideo } from '../common/require';
import type { CreditRole, Role } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';
import { mergeCredits, type MergeableCredit } from './merge';

const CREDIT_SELECT = {
  id: true,
  personId: true,
  role: true,
  characterName: true,
  position: true,
  // The raw TMDB job and department. `role` collapses everything but six jobs to
  // OTHER, so these are what let a full-credits view say "Costume Designer"
  // rather than listing two hundred people under one word.
  jobTitle: true,
  department: true,
  collectionId: true,
  videoId: true,
  person: {
    select: { id: true, slug: true, name: true, photoKey: true, imdbId: true, knownFor: true },
  },
} as const;

/**
 * A ceiling on one panel's worth of credits.
 *
 * Both listings are a whole cast in one response rather than a paged window —
 * a credits panel that arrives in pages is not a credits panel — but they still
 * return a `Page`, because **every list endpoint does**. The subtitles endpoint
 * shipped as a bare array for exactly this reason and the player's track list
 * silently came back empty; the frontend reads `.items` because everything else
 * does, which is the whole point of the convention.
 */
const MAX_CREDITS = 500;

/** Which parent a credit hangs off. Exactly one, enforced by a CHECK constraint too. */
type Parent = { collectionId: string; videoId?: undefined } | { videoId: string; collectionId?: undefined };

@Injectable()
export class CreditsService {
  constructor(private readonly prisma: PrismaService) {}

  /** A collection's own credits — the series' main cast and crew. */
  async listForCollection(collectionId: string, role: Role): Promise<Page<MergeableCredit>> {
    await this.requireCollection(collectionId, role);

    const credits = await this.prisma.credit.findMany({
      where: { collectionId },
      select: CREDIT_SELECT,
      orderBy: [{ role: 'asc' }, { position: 'asc' }, { id: 'asc' }],
      take: MAX_CREDITS,
    });

    return toPage(credits, credits.length, { limit: MAX_CREDITS, offset: 0 });
  }

  /**
   * A video's credits **merged with its collection's**, which is what the panel
   * under the player shows: the show's cast entered once, plus this episode's
   * guest stars.
   */
  async listForVideo(videoId: string, role: Role) {
    const video = await this.requireVideo(videoId, role);

    /**
     * Inherited from **every** collection the video is in, not from one parent.
     *
     * An episode can sit in its show and in a themed row, and dropping either
     * one's cast because the other exists would hide credits for no reason a
     * viewer could see. Ordered by collection id so the merge is fed the same
     * list every time: the sort has to be total, or the panel reshuffles between
     * identical requests and reads as a rendering bug for weeks.
     */
    const parentIds = video.collections.map((membership) => membership.collectionId);

    const [own, inherited] = await Promise.all([
      this.prisma.credit.findMany({ where: { videoId }, select: CREDIT_SELECT, take: MAX_CREDITS }),
      parentIds.length === 0
        ? []
        : this.prisma.credit.findMany({
            where: { collectionId: { in: parentIds } },
            select: CREDIT_SELECT,
            orderBy: [{ collectionId: 'asc' }, { position: 'asc' }, { id: 'asc' }],
            take: MAX_CREDITS,
          }),
    ]);

    const merged = mergeCredits(inherited, own);
    return toPage(merged, merged.length, { limit: MAX_CREDITS, offset: 0 });
  }

  async createForCollection(collectionId: string, dto: CreateCreditInput) {
    await this.requireCollection(collectionId, 'ADMIN');
    return this.create({ collectionId }, dto);
  }

  async createForVideo(videoId: string, dto: CreateCreditInput) {
    await this.requireVideo(videoId, 'ADMIN');
    return this.create({ videoId }, dto);
  }

  async update(id: string, dto: UpdateCreditInput) {
    const credit = await this.prisma.credit.findUnique({
      where: { id },
      select: { id: true, personId: true, role: true, collectionId: true, videoId: true },
    });
    if (!credit) throw new NotFoundException('No such credit');

    // Changing the role can collide with a credit that already exists for the
    // same person in that role on the same parent.
    if (dto.role !== undefined && dto.role !== credit.role) {
      await this.refuseDuplicate(this.parentOf(credit), credit.personId, dto.role, id);
    }

    return this.prisma.credit.update({
      where: { id },
      data: { role: dto.role, characterName: dto.characterName, position: dto.position },
      select: CREDIT_SELECT,
    });
  }

  /**
   * Rewrites a whole billing order in one transaction.
   *
   * The parent is named in the request and every id is checked against it: a
   * reorder that took ids on trust would be a way to renumber credits on a
   * video the caller never mentioned. Partial lists are refused too — a caller
   * that sends half the credits gets a numbering it did not intend.
   */
  async reorder(dto: ReorderCreditsInput) {
    const parent: Parent =
      dto.collectionId !== undefined
        ? { collectionId: dto.collectionId }
        : { videoId: dto.videoId as string };

    if (parent.collectionId !== undefined) {
      await this.requireCollection(parent.collectionId, 'ADMIN');
    } else {
      await this.requireVideo(parent.videoId as string, 'ADMIN');
    }

    const unique = new Set(dto.creditIds);
    if (unique.size !== dto.creditIds.length) {
      throw new BadRequestException('The same credit is listed twice');
    }

    const existing = await this.prisma.credit.findMany({
      where: parent,
      select: { id: true },
    });

    if (existing.length !== dto.creditIds.length || !existing.every((row) => unique.has(row.id))) {
      throw new BadRequestException('List every credit on this collection or video exactly once');
    }

    await this.prisma.$transaction(
      dto.creditIds.map((id, position) =>
        this.prisma.credit.update({ where: { id }, data: { position } }),
      ),
    );

    return parent.collectionId !== undefined
      ? this.listForCollection(parent.collectionId, 'ADMIN')
      : this.listForVideo(parent.videoId as string, 'ADMIN');
  }

  async remove(id: string): Promise<void> {
    const credit = await this.prisma.credit.findUnique({ where: { id }, select: { id: true } });
    if (!credit) throw new NotFoundException('No such credit');

    await this.prisma.credit.delete({ where: { id } });
  }

  private async create(parent: Parent, dto: CreateCreditInput) {
    const person = await this.prisma.person.findUnique({
      where: { id: dto.personId },
      select: { id: true },
    });
    if (!person) throw new NotFoundException('No such person');

    await this.refuseDuplicate(parent, dto.personId, dto.role);

    return this.prisma.credit.create({
      data: {
        ...parent,
        personId: dto.personId,
        role: dto.role,
        characterName: dto.characterName ?? null,
        position: dto.position ?? (await this.nextPosition(parent, dto.role)),
      },
      select: CREDIT_SELECT,
    });
  }

  /**
   * Refuses the same person in the same role on the same parent.
   *
   * This has to live here rather than in a composite unique index: the parent
   * columns are nullable, and Postgres treats NULLs as distinct, so an index on
   * `(personId, role, collectionId, videoId)` would let every video credit
   * duplicate freely.
   */
  private async refuseDuplicate(
    parent: Parent,
    personId: string,
    role: CreditRole,
    exceptId?: string,
  ): Promise<void> {
    const clash = await this.prisma.credit.findFirst({
      where: { ...parent, personId, role, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { id: true },
    });
    if (clash) throw new ConflictException('That person already has that credit here');
  }

  /** Appended to the end of their role's billing order, not the parent's whole list. */
  private async nextPosition(parent: Parent, role: CreditRole): Promise<number> {
    const last = await this.prisma.credit.aggregate({
      where: { ...parent, role },
      _max: { position: true },
    });

    return last._max.position === null ? 0 : last._max.position + 1;
  }

  private parentOf(credit: { collectionId: string | null; videoId: string | null }): Parent {
    return credit.collectionId !== null
      ? { collectionId: credit.collectionId }
      : { videoId: credit.videoId as string };
  }

  private requireCollection(id: string, role: Role) {
    return requireVisibleCollection(this.prisma, id, role, { id: true });
  }

  private requireVideo(id: string, role: Role) {
    return requireVisibleVideo(this.prisma, id, role, {
      id: true,
      collections: { select: { collectionId: true } },
    });
  }
}

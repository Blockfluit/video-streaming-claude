import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  toPage,
  type CreatePersonInput,
  type ListPeopleQuery,
  type Page,
  type UpdatePersonInput,
} from '@video/shared';

import { whereVisible } from '../common/publishing';
import { slugify, uniqueSlug } from '../common/slug';
import type { Role } from '../prisma/generated/enums';
import { PrismaService } from '../prisma/prisma.service';

const PERSON_SELECT = {
  id: true,
  slug: true,
  name: true,
  bio: true,
  photoKey: true,
  // What an imported person carries: an id to link out by, and one word about
  // what they do. Everything else about them is IMDb's page, not a copy of it.
  imdbId: true,
  knownFor: true,
  tmdbId: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * A filmography is bounded for the same reason a collection's episode list is:
 * one response should not grow without limit. A prolific person past this is
 * paged through `GET /videos` and `GET /collections` instead.
 */
const MAX_FILMOGRAPHY = 500;

@Injectable()
export class PeopleService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListPeopleQuery): Promise<Page<unknown>> {
    const where = query.q
      ? { name: { contains: query.q, mode: 'insensitive' as const } }
      : {};

    const [people, total] = await this.prisma.$transaction([
      this.prisma.person.findMany({
        where,
        select: { ...PERSON_SELECT, _count: { select: { credits: true } } },
        // `id` last makes the order total; names are not unique enough to page on.
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.person.count({ where }),
    ]);

    return toPage(people, total, query);
  }

  /**
   * A person and what they worked on.
   *
   * Looked up by slug, since this is a linkable page. The filmography is
   * filtered by the caller's visibility — an unpublished film must not surface
   * through a director's page having been hidden on the browse page.
   */
  async findBySlug(slug: string, role: Role) {
    const person = await this.prisma.person.findUnique({
      where: { slug },
      select: PERSON_SELECT,
    });
    if (!person) throw new NotFoundException('No such person');

    const credits = await this.prisma.credit.findMany({
      where: {
        personId: person.id,
        OR: [
          { collection: { is: whereVisible(role) } },
          { video: { is: whereVisible(role) } },
        ],
      },
      select: {
        id: true,
        role: true,
        characterName: true,
        collection: { select: { id: true, slug: true, title: true, year: true, posterKey: true } },
        video: {
          select: {
            id: true,
            slug: true,
            title: true,
            bannerKey: true,
            // Every collection it is in: a film may appear in several, and
            // naming one of them would be an arbitrary choice.
            collections: {
              select: { collection: { select: { id: true, slug: true, title: true } } },
            },
          },
        },
      },
      orderBy: [{ role: 'asc' }, { id: 'asc' }],
      take: MAX_FILMOGRAPHY,
    });

    return { ...person, credits };
  }

  async create(dto: CreatePersonInput) {
    // `name` is unique in the schema, but the message Postgres gives for that is
    // not one to show an admin mid-typing.
    await this.refuseDuplicateName(dto.name);

    return this.prisma.person.create({
      data: {
        name: dto.name,
        bio: dto.bio ?? null,
        photoKey: dto.photoKey ?? null,
        slug: await this.freeSlug(slugify(dto.name)),
      },
      select: PERSON_SELECT,
    });
  }

  async update(id: string, dto: UpdatePersonInput) {
    const person = await this.prisma.person.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
    if (!person) throw new NotFoundException('No such person');

    if (dto.name !== undefined && dto.name !== person.name) {
      await this.refuseDuplicateName(dto.name);
    }

    return this.prisma.person.update({
      where: { id },
      data: {
        name: dto.name,
        bio: dto.bio,
        photoKey: dto.photoKey,
        slug: dto.regenerateSlug
          ? await this.freeSlug(slugify(dto.name ?? person.name), id)
          : undefined,
      },
      select: PERSON_SELECT,
    });
  }

  /**
   * Deleting a person takes their credits with them — the cascade is in the
   * schema. That is the intent: a credit with no person is not a fact about
   * anything, unlike a video row whose file has gone missing.
   */
  async remove(id: string): Promise<void> {
    const person = await this.prisma.person.findUnique({ where: { id }, select: { id: true } });
    if (!person) throw new NotFoundException('No such person');

    await this.prisma.person.delete({ where: { id } });
  }

  private async refuseDuplicateName(name: string): Promise<void> {
    const clash = await this.prisma.person.findFirst({
      // Case-insensitive: "ada lovelace" and "Ada Lovelace" are one person, and
      // the schema's unique index would happily hold both.
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (clash) throw new ConflictException('Somebody with that name is already in the library');
  }

  private async freeSlug(base: string, exceptId?: string): Promise<string> {
    const taken = await this.prisma.person.findMany({
      where: exceptId ? { NOT: { id: exceptId } } : {},
      select: { slug: true },
    });

    return uniqueSlug(
      base,
      taken.map((row) => row.slug),
    );
  }
}

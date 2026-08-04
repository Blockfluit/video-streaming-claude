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
import { PersonLinksService } from '../metadata/person-links.service';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly personLinks: PersonLinksService,
  ) {}

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
      select: { ...PERSON_SELECT, imdbCheckedAt: true },
    });
    if (!person) throw new NotFoundException('No such person');

    // Fire and forget. TMDB does not return a person's IMDb id with a title's
    // credits, so it is fetched the first time somebody actually looks at them —
    // and the link appears on the next load rather than holding up this one.
    this.personLinks.enqueue(person);

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

  /**
   * Finds or creates a batch of people, returning their ids by TMDB person id.
   *
   * Written because the per-row path cannot do this. `create` calls `freeSlug`,
   * which loads *every* person's slug, and `refuseDuplicateName`, which is a
   * query of its own — so a 250-credit film would be five hundred queries and
   * two hundred and fifty full-table scans. This is three queries and one
   * `createMany`, whatever the size of the cast.
   *
   * Matching goes `tmdbId` first, then case-insensitively by name. The id is the
   * reliable key; the name pass is what stops an import creating a second row
   * for a director an admin already entered by hand.
   */
  async resolveMany(
    entries: readonly { tmdbPersonId: number; name: string; knownFor: string | null }[],
  ): Promise<Map<number, string>> {
    // One entry per person: a film credits the same person as writer and
    // director routinely, and creating them twice is the bug this exists to stop.
    const wanted = new Map<number, { name: string; knownFor: string | null }>();
    for (const entry of entries) {
      if (!wanted.has(entry.tmdbPersonId)) {
        wanted.set(entry.tmdbPersonId, { name: entry.name, knownFor: entry.knownFor });
      }
    }
    if (wanted.size === 0) return new Map();

    const resolved = new Map<number, string>();

    const byTmdbId = await this.prisma.person.findMany({
      where: { tmdbId: { in: [...wanted.keys()] } },
      select: { id: true, tmdbId: true },
    });
    for (const person of byTmdbId) {
      if (person.tmdbId !== null) resolved.set(person.tmdbId, person.id);
    }

    const unmatched = [...wanted.entries()].filter(([tmdbId]) => !resolved.has(tmdbId));
    if (unmatched.length === 0) return resolved;

    // Prisma has no case-insensitive `in`, so the fold happens here: fetch the
    // candidates by exact name, then compare lowercased. Names are indexed and
    // the list is bounded by the cast, so this stays one query.
    const names = unmatched.map(([, entry]) => entry.name);
    const byName = await this.prisma.person.findMany({
      where: { OR: names.map((name) => ({ name: { equals: name, mode: 'insensitive' as const } })) },
      select: { id: true, name: true, tmdbId: true },
    });
    const existingByName = new Map(byName.map((person) => [person.name.toLowerCase(), person]));

    const toCreate: { tmdbId: number; name: string; knownFor: string | null }[] = [];
    const toAdopt: { id: string; tmdbId: number; knownFor: string | null }[] = [];

    for (const [tmdbId, entry] of unmatched) {
      const existing = existingByName.get(entry.name.toLowerCase());
      if (existing === undefined) {
        toCreate.push({ tmdbId, name: entry.name, knownFor: entry.knownFor });
        continue;
      }

      resolved.set(tmdbId, existing.id);
      // A hand-entered person meeting their TMDB id for the first time. Only
      // claim one that is free — overwriting an id would repoint a row at
      // somebody else.
      if (existing.tmdbId === null) {
        toAdopt.push({ id: existing.id, tmdbId, knownFor: entry.knownFor });
      }
    }

    for (const person of toAdopt) {
      await this.prisma.person.update({
        where: { id: person.id },
        data: { tmdbId: person.tmdbId, knownFor: person.knownFor ?? undefined },
      });
    }

    if (toCreate.length > 0) {
      // One snapshot of the taken slugs for the whole batch, rather than a
      // re-read per person — and new slugs are added to it as they are claimed,
      // or two people named "Chris Evans" in one cast would both take `chris-evans`.
      const taken = new Set(
        (await this.prisma.person.findMany({ select: { slug: true } })).map((row) => row.slug),
      );

      const rows = toCreate.map((person) => {
        const slug = uniqueSlug(slugify(person.name), taken);
        taken.add(slug);
        return { name: person.name, slug, tmdbId: person.tmdbId, knownFor: person.knownFor };
      });

      // `skipDuplicates` covers the race with another import running at the same
      // moment; the read below is what actually resolves the ids either way.
      await this.prisma.person.createMany({ data: rows, skipDuplicates: true });

      const created = await this.prisma.person.findMany({
        where: { tmdbId: { in: toCreate.map((person) => person.tmdbId) } },
        select: { id: true, tmdbId: true },
      });
      for (const person of created) {
        if (person.tmdbId !== null) resolved.set(person.tmdbId, person.id);
      }
    }

    return resolved;
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

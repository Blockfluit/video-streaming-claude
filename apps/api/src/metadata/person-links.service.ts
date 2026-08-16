import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import { TmdbClient } from './tmdb.client';
import { PrismaService } from '../prisma/prisma.service';
import { describeError } from '../common/errors';

/**
 * Filling in people's IMDb ids, behind the read rather than during the import.
 *
 * TMDB returns a person's name and id alongside a title's credits but **not**
 * their `imdb_id` — that needs `/person/{id}/external_ids`, one request each. A
 * 250-credit film would therefore cost 250 extra requests at import time, for a
 * link most of those people will never have clicked.
 *
 * So reading a person enqueues them instead. The queue is in-memory, deduped and
 * runs two at a time, exactly like the probe queue in `MediaService` — the read
 * is never blocked, never fails because TMDB is slow, and the link appears on
 * the next load. `imdbCheckedAt` is what stops somebody who genuinely has no
 * IMDb id being asked about on every single page view.
 */

const CONCURRENCY = 2;

@Injectable()
export class PersonLinksService implements OnModuleDestroy {
  private readonly logger = new Logger(PersonLinksService.name);
  private readonly queued = new Set<string>();
  private running = 0;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tmdb: TmdbClient,
  ) {}

  onModuleDestroy(): void {
    // Tests and shutdowns: a queue still working through people keeps the
    // process alive and writes to a database that is closing.
    this.stopped = true;
    this.queued.clear();
  }

  /**
   * Notes that a person's link is worth resolving. Returns immediately.
   *
   * Takes the row rather than an id so the common case — already resolved, or
   * no TMDB id to resolve from — costs nothing at all.
   */
  enqueue(person: { id: string; tmdbId: number | null; imdbId: string | null; imdbCheckedAt: Date | null }): void {
    if (!this.tmdb.isConfigured) return;
    if (person.tmdbId === null) return;
    if (person.imdbId !== null || person.imdbCheckedAt !== null) return;
    if (this.queued.has(person.id)) return;

    this.queued.add(person.id);
    void this.pump();
  }

  enqueueAll(people: readonly Parameters<PersonLinksService['enqueue']>[0][]): void {
    for (const person of people) this.enqueue(person);
  }

  /**
   * Works through everyone still unresolved, and waits for it.
   *
   * The button on the admin people screen, for anybody who would rather not
   * wait for the queue to reach them.
   */
  async resolveAll(limit = 200): Promise<{ resolved: number; checked: number }> {
    const pending = await this.prisma.person.findMany({
      where: { tmdbId: { not: null }, imdbId: null, imdbCheckedAt: null },
      select: { id: true, tmdbId: true },
      take: limit,
    });

    let resolved = 0;
    for (const person of pending) {
      if (await this.resolve(person.id, person.tmdbId!)) resolved += 1;
    }

    return { resolved, checked: pending.length };
  }

  private async pump(): Promise<void> {
    if (this.running >= CONCURRENCY) return;

    const next = this.queued.values().next();
    if (next.done === true) return;

    const personId = next.value;
    this.queued.delete(personId);
    this.running += 1;

    try {
      const person = await this.prisma.person.findUnique({
        where: { id: personId },
        select: { tmdbId: true },
      });
      if (person?.tmdbId != null) await this.resolve(personId, person.tmdbId);
    } finally {
      this.running -= 1;
      if (!this.stopped) void this.pump();
    }
  }

  private async resolve(personId: string, tmdbId: number): Promise<boolean> {
    try {
      const imdbId = await this.tmdb.personImdbId(tmdbId);

      // `imdbCheckedAt` is written either way. Somebody with no IMDb id is a
      // real answer, and without recording it this asks again on every read.
      await this.prisma.person.update({
        where: { id: personId },
        data: { imdbId, imdbCheckedAt: new Date() },
      });

      return imdbId !== null;
    } catch (error) {
      // A failed lookup is left unchecked so it is retried later — this is a
      // nicety filling in behind a page, not something worth reporting.
      this.logger.debug(`Could not resolve an IMDb id: ${describe(error)}`);
      return false;
    }
  }
}

const describe = (error: unknown): string =>
  describeError(error);

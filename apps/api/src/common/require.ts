import { NotFoundException } from '@nestjs/common';

import type { Prisma } from '../prisma/generated/client';
import type { Role } from '../prisma/generated/enums';
import type { PrismaService } from '../prisma/prisma.service';
import { whereVisible } from './publishing';

/**
 * "Fetch it as this caller may see it, or 404."
 *
 * Ten services had written their own private version of this — `findFirst` with
 * `...whereVisible(role)` spread in, throwing `NotFoundException` otherwise.
 * `credits.requireVideo` and `comments.requireVideo` were the same function
 * apart from their `select`.
 *
 * **404 rather than 403, deliberately.** A caller who cannot see a record must
 * not be able to tell the difference between "not allowed" and "does not
 * exist" — otherwise an id becomes a way to confirm that a draft is there.
 *
 * The `select` stays at the call site: each caller needs different columns, and
 * that is the part that should differ. Typed through Prisma's own
 * `GetPayload`, so a caller still gets exactly the fields it asked for and
 * nothing wider.
 */

export async function requireVisibleVideo<S extends Prisma.VideoSelect>(
  prisma: PrismaService,
  id: string,
  role: Role,
  select: S,
): Promise<Prisma.VideoGetPayload<{ select: S }>> {
  const video = await prisma.video.findFirst({
    where: { id, ...whereVisible(role) },
    select,
  });
  if (!video) throw new NotFoundException('No such video');

  return video as Prisma.VideoGetPayload<{ select: S }>;
}

export async function requireVisibleCollection<S extends Prisma.CollectionSelect>(
  prisma: PrismaService,
  id: string,
  role: Role,
  select: S,
): Promise<Prisma.CollectionGetPayload<{ select: S }>> {
  const collection = await prisma.collection.findFirst({
    where: { id, ...whereVisible(role) },
    select,
  });
  if (!collection) throw new NotFoundException('No such collection');

  return collection as Prisma.CollectionGetPayload<{ select: S }>;
}

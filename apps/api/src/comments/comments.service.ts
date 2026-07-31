import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  toPage,
  type CreateCommentInput,
  type ListCommentsQuery,
  type Page,
  type UpdateCommentInput,
} from '@video/shared';

import type { AuthUser } from '../auth/auth.types';
import { whereVisible } from '../common/publishing';
import { PrismaService } from '../prisma/prisma.service';
import { toCommentView, type CommentView } from './serialize';

const COMMENT_SELECT = {
  id: true,
  videoId: true,
  body: true,
  timestampSec: true,
  editedAt: true,
  deletedAt: true,
  createdAt: true,
  user: { select: { id: true, username: true, displayName: true } },
} as const;

@Injectable()
export class CommentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Newest first, deleted ones included as tombstones so the thread still reads
   * around the gap.
   */
  async list(
    videoId: string,
    role: AuthUser['role'],
    query: ListCommentsQuery,
  ): Promise<Page<CommentView>> {
    await this.requireVideo(videoId, role);

    const where = { videoId };

    const [comments, total] = await this.prisma.$transaction([
      this.prisma.comment.findMany({
        where,
        select: COMMENT_SELECT,
        // `id` last makes the order total; two comments can share a timestamp.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.comment.count({ where }),
    ]);

    return toPage(comments.map(toCommentView), total, query);
  }

  async create(
    videoId: string,
    user: AuthUser,
    dto: CreateCommentInput,
  ): Promise<CommentView> {
    const video = await this.requireVideo(videoId, user.role);

    // Bounded by the runtime when there is one, so the "2:14" link the UI
    // renders has somewhere to seek to. An unprobed video keeps the schema's
    // absolute cap and nothing more — a probe failure must not block a comment.
    if (
      dto.timestampSec !== null &&
      dto.timestampSec !== undefined &&
      video.durationSec !== null &&
      video.durationSec > 0 &&
      dto.timestampSec > video.durationSec
    ) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: [
          {
            field: 'timestampSec',
            message: `Must be within the video, which is ${Math.round(video.durationSec)} seconds long.`,
          },
        ],
      });
    }

    const comment = await this.prisma.comment.create({
      data: {
        videoId,
        userId: user.id,
        body: dto.body,
        timestampSec: dto.timestampSec ?? null,
      },
      select: COMMENT_SELECT,
    });

    return toCommentView(comment);
  }

  /**
   * Editing is the **author's alone**, admin or not.
   *
   * Deleting someone else's comment is moderation; rewriting their words and
   * leaving their name on it is not, and `editedAt` would make it look like
   * they had done it themselves.
   */
  async update(id: string, user: AuthUser, dto: UpdateCommentInput): Promise<CommentView> {
    const comment = await this.require(id, user.role);

    if (comment.userId !== user.id) {
      throw new ForbiddenException('You can only edit your own comments');
    }
    if (comment.deletedAt !== null) {
      throw new BadRequestException('That comment has been deleted');
    }

    const updated = await this.prisma.comment.update({
      where: { id },
      data: { body: dto.body, editedAt: new Date() },
      select: COMMENT_SELECT,
    });

    return toCommentView(updated);
  }

  /**
   * Soft delete: the row stays, holding who removed it and when.
   *
   * The author may remove their own; an admin may remove anyone's. Deleting
   * twice is not an error — the second caller wanted it gone, and it is.
   */
  async remove(id: string, user: AuthUser): Promise<void> {
    const comment = await this.require(id, user.role);

    if (comment.userId !== user.id && user.role !== 'ADMIN') {
      throw new ForbiddenException('You can only delete your own comments');
    }
    if (comment.deletedAt !== null) return;

    await this.prisma.comment.update({
      where: { id },
      data: { deletedAt: new Date(), deletedById: user.id },
    });
  }

  private async require(id: string, role: AuthUser['role']) {
    const comment = await this.prisma.comment.findFirst({
      // Through the video's visibility, so a comment is not a way to learn that
      // a draft video exists.
      where: { id, video: { is: whereVisible(role) } },
      select: { id: true, userId: true, deletedAt: true },
    });
    if (!comment) throw new NotFoundException('No such comment');

    return comment;
  }

  private async requireVideo(id: string, role: AuthUser['role']) {
    const video = await this.prisma.video.findFirst({
      where: { id, ...whereVisible(role) },
      select: { id: true, durationSec: true },
    });
    if (!video) throw new NotFoundException('No such video');

    return video;
  }
}

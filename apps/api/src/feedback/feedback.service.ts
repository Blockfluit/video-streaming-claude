import { createReadStream } from 'node:fs';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import {
  MAX_FEEDBACK_SCREENSHOT_BYTES,
  toPage,
  type CreateFeedbackInput,
  type ListFeedbackQuery,
  type Page,
} from '@video/shared';

import type { AuthUser } from '../auth/auth.types';
import { StorageService } from '../common/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { feedbackScreenshotKey } from './keys';
import { toFeedbackView, type FeedbackView } from './serialize';

const FEEDBACK_SELECT = {
  id: true,
  message: true,
  pageUrl: true,
  userAgent: true,
  viewportWidth: true,
  viewportHeight: true,
  hasScreenshot: true,
  createdAt: true,
  user: { select: { id: true, displayName: true } },
} as const;

@Injectable()
export class FeedbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** Any signed-in user. The screenshot is optional — a failed capture still submits. */
  async create(user: AuthUser, dto: CreateFeedbackInput): Promise<FeedbackView> {
    const buffer = decodeScreenshot(dto.screenshot);

    const row = await this.prisma.feedback.create({
      data: {
        userId: user.id,
        message: dto.message,
        pageUrl: dto.pageUrl,
        userAgent: dto.userAgent,
        viewportWidth: dto.viewportWidth,
        viewportHeight: dto.viewportHeight,
        hasScreenshot: buffer !== null,
      },
      select: FEEDBACK_SELECT,
    });

    if (buffer) {
      await this.storage.save('derived', feedbackScreenshotKey(row.id), buffer);
    }

    return toFeedbackView(row);
  }

  /** Every submission, newest first. No visibility filter — this whole resource is ADMIN-only. */
  async listForAdmin(query: ListFeedbackQuery): Promise<Page<FeedbackView>> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.feedback.findMany({
        select: FEEDBACK_SELECT,
        // `id` last so the order is total — two submissions can share a timestamp.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.feedback.count(),
    ]);

    return toPage(rows.map(toFeedbackView), total, query);
  }

  /**
   * A genuine 404 here, unlike video/collection artwork: this route is never
   * reached by a client that does not already know the row exists via the
   * admin list, so there is no "ordinary missing artwork" case to soften.
   */
  async sendScreenshot(id: string, response: Response): Promise<void> {
    const row = await this.prisma.feedback.findUnique({
      where: { id },
      select: { hasScreenshot: true },
    });
    if (!row || !row.hasScreenshot) throw new NotFoundException('No such screenshot');

    const key = feedbackScreenshotKey(id);
    const stat = await this.storage.statOf('derived', key);
    if (!stat) throw new NotFoundException('No such screenshot');

    const etag = `W/"${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}"`;
    response.setHeader('Content-Type', 'image/png');
    response.setHeader('ETag', etag);
    response.setHeader('Cache-Control', 'private, no-cache');

    if (response.req.headers['if-none-match'] === etag) {
      response.status(304).end();
      return;
    }

    response.setHeader('Content-Length', stat.size);
    const stream = createReadStream(this.storage.resolvePath('derived', key));
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  }

  /** Hard delete — there's no audit/soft-delete requirement here, unlike comments. */
  async remove(id: string): Promise<void> {
    const row = await this.prisma.feedback.findUnique({
      where: { id },
      select: { hasScreenshot: true },
    });
    if (!row) throw new NotFoundException('No such feedback');

    await this.prisma.feedback.delete({ where: { id } });

    if (row.hasScreenshot) {
      // `force: true` inside StorageService.delete already no-ops on a missing
      // file, so there is nothing further to guard here.
      await this.storage.delete('derived', feedbackScreenshotKey(id));
    }
  }
}

function decodeScreenshot(input: string | undefined): Buffer | null {
  if (!input) return null;

  const base64 = input.includes(',') ? input.slice(input.indexOf(',') + 1) : input;
  const buffer = Buffer.from(base64, 'base64');

  if (buffer.length > MAX_FEEDBACK_SCREENSHOT_BYTES) {
    throw new BadRequestException('That screenshot is too large.');
  }

  return buffer;
}

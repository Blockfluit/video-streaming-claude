import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { listJobsSchema, toPage, type ListJobsQuery, type Page } from '@video/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { validate } from '../common/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { JobsService } from './jobs.service';

@Controller('admin/jobs')
@Roles('ADMIN')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  /** The admin UI polls this every couple of seconds for a live progress bar. */
  @Get()
  async list(@Query(validate(listJobsSchema)) query: ListJobsQuery): Promise<Page<unknown>> {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.videoId ? { videoId: query.videoId } : {}),
    };

    const [jobs, total] = await this.prisma.$transaction([
      this.prisma.mediaJob.findMany({
        where,
        // Newest first, with `id` breaking ties so paging stays stable.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.mediaJob.count({ where }),
    ]);

    return toPage(jobs, total, query);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.jobs.get(id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id') id: string) {
    return this.jobs.cancel(id);
  }

  /** Re-queues a failed or cancelled job as a new one, leaving the old record intact. */
  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  retry(@Param('id') id: string, @CurrentUser() admin: AuthUser) {
    return this.jobs.retry(id, admin.id);
  }
}

import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { listJobsSchema, toPage, type ListJobsQuery, type Page } from '@video/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { ThrottleExpensive } from '../common/throttling';
import { validate } from '../common/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { ConvertedRelocationService } from './converted-relocation.service';
import { JobsService } from './jobs.service';

@Controller('admin/jobs')
@Roles('ADMIN')
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
    private readonly relocation: ConvertedRelocationService,
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

  /**
   * Moves converted files out of `derived/converted/` and in beside their
   * sources — the one-shot for an install that predates that layout.
   *
   * Declared before `:id/…`, as the literal routes always are here: Express
   * matches in order, and the other way round makes `relocate-conversions` a
   * job id.
   *
   * An endpoint rather than a migration, because SQL cannot move a file, and
   * rather than a boot hook, because copying a library across two filesystems
   * with the whole bootstrap held open is how a healthcheck turns a slow start
   * into a restart loop.
   */
  @Post('relocate-conversions')
  @HttpCode(HttpStatus.OK)
  @ThrottleExpensive()
  relocateConversions() {
    return this.relocation.run();
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

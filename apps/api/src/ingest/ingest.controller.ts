import { Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { listIngestIssuesSchema, toPage, type ListIngestIssuesQuery, type Page } from '@video/shared';

import { Roles } from '../auth/decorators';
import { validate } from '../common/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { ReconcileService, type ReconcileSummary } from './reconcile.service';
import { WatcherService } from './watcher.service';
import { ThrottleExpensive } from '../common/throttling';

@Controller('admin/ingest')
@Roles('ADMIN')
export class IngestController {
  constructor(
    private readonly reconcile: ReconcileService,
    private readonly watcher: WatcherService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Runs a scan and waits for it.
   *
   * Joins an in-flight pass rather than starting a second one, so an impatient
   * admin clicking twice gets one scan and two identical answers.
   */
  /** Walks the whole media tree and queues probes for what it finds. */
  @ThrottleExpensive()
  @Post('scan')
  @HttpCode(HttpStatus.OK)
  scan(): Promise<ReconcileSummary> {
    return this.reconcile.run();
  }

  @Get('status')
  async status() {
    const [openIssues, drafts, missing] = await this.prisma.$transaction([
      this.prisma.ingestIssue.count({ where: { resolvedAt: null } }),
      this.prisma.video.count({ where: { state: 'DRAFT' } }),
      this.prisma.video.count({ where: { state: 'MISSING' } }),
    ]);

    return {
      scanning: this.reconcile.isRunning,
      watching: this.watcher.isWatching,
      lastScan: this.reconcile.last,
      openIssues,
      drafts,
      missing,
    };
  }

  @Get('issues')
  async issues(
    @Query(validate(listIngestIssuesSchema)) query: ListIngestIssuesQuery,
  ): Promise<Page<unknown>> {
    // Open issues by default — a resolved one is history, not a to-do.
    const where = query.includeResolved ? {} : { resolvedAt: null };

    const [issues, total] = await this.prisma.$transaction([
      this.prisma.ingestIssue.findMany({
        where,
        orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.ingestIssue.count({ where }),
    ]);

    return toPage(issues, total, query);
  }
}

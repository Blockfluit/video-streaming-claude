# Feedback Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any signed-in user open a floating "send feedback" dialog, annotate a screenshot of the current page (pen/shapes/text), and submit it; let admins view submissions on a new `/admin/feedback` page.

**Architecture:** A new `Feedback` module on the API (Prisma model, service, controller) mirroring the `comments` module's shape but with no soft-delete/moderation workflow — a plain create/list/delete resource. On the frontend, a globally-mounted button captures a DOM screenshot (`html2canvas`), a Konva-based (`vue-konva`) canvas lets the user draw on it, and the flattened result plus a text message are POSTed as JSON (base64 image inline). Admins get a page built on the same `useApiData<Page<T>>` pattern as `comments.vue`/`requests.vue`.

**Tech Stack:** NestJS 11, Prisma 7/PostgreSQL, Zod (`packages/shared`), Nuxt 4/Vue 3/`@nuxt/ui`, `html2canvas`, `konva` + `vue-konva`.

**Spec:** `docs/superpowers/specs/2026-09-06-feedback-widget-design.md`

## Global Constraints

- Any signed-in user (`USER` or `ADMIN`) may submit feedback; only `ADMIN` may list, view screenshots, or delete.
- No status/moderation workflow on feedback rows — a plain list with delete for cleanup (explicit user decision).
- The floating button sits fixed at the bottom-right corner.
- The feedback dialog is dismissible by clicking outside it (Nuxt UI `UModal`'s default behaviour — do not set `dismissible: false` or `preventClose`).
- Screenshot capture uses in-browser DOM capture (`html2canvas`), not the Screen Capture API.
- The annotated screenshot is stored as a file under `DERIVED_ROOT` (`feedback/<id>.png`), never as bytea/base64 in Postgres.
- Annotation tool: `konva` + `vue-konva` (declarative Vue components), not fabric.js, not a hand-rolled `<canvas>`.
- Auto-captured with every submission: page URL/route, browser user agent + viewport size, and the submitting user's identity (via the session, not a form field).
- A missing/failed screenshot degrades to a text-only submission — it never blocks the dialog from being usable.
- `MAX_FEEDBACK_MESSAGE_LENGTH = 2000`, `MAX_FEEDBACK_SCREENSHOT_BYTES = 5 * 1024 * 1024` (both in `packages/shared`).
- Nest's default Express body parser caps a JSON body at 100kb; `main.ts` must raise this globally (`bodyParser: false` + manual `express.json({ limit: '7mb' })`/`urlencoded`) or every submission with a screenshot 413s before validation ever runs. Nothing else in this API sends a JSON body anywhere near that size, and multipart uploads (posters, subtitles) go through multer, which never touches this parser.
- Never name a local binding `ref`, `computed`, `watch`, etc. — shadows the Vue auto-import and only fails in a production build (see CLAUDE.md's `auto-imports.spec.ts` note).
- Shape ids in the annotator are a plain incrementing counter, never `crypto.randomUUID()` — that API is unavailable on an insecure context (e.g. `http://192.168.x.x:3100`, exactly how this app gets opened from a phone on the LAN), and there's no reason to risk it for a purely local, disposable id.

---

## Task 1: Shared schemas — feedback validation and the screenshot size cap

**Files:**
- Create: `packages/shared/src/schemas/feedback.ts`
- Modify: `packages/shared/src/schemas/library.ts` (add `MAX_FEEDBACK_SCREENSHOT_BYTES` beside `MAX_THUMBNAIL_BYTES`)
- Modify: `packages/shared/src/index.ts` (add the re-export, alphabetically between `comments.js` and `library.js`)

**Interfaces:**
- Produces: `createFeedbackSchema` (zod), `CreateFeedbackInput` (type), `listFeedbackSchema` (= `pageQuerySchema`), `ListFeedbackQuery` (type), `MAX_FEEDBACK_MESSAGE_LENGTH`, `MAX_FEEDBACK_SCREENSHOT_BYTES` — all consumed by Task 4 (service) and Task 5 (controller).

This package has no test runner (`packages/shared/package.json` only has `build`/`typecheck`/`clean`) — every other schema file here is exercised indirectly, through the API's own tests. The verification step for this task is `typecheck`, not a unit test.

- [ ] **Step 1: Write the schema file**

```ts
// packages/shared/src/schemas/feedback.ts
import { z } from 'zod';

import { pageQuerySchema } from '../pagination.js';
import { nonEmptyText } from '../primitives.js';

/**
 * Feedback submitted from the floating button: a message, plus everything the
 * page can tell about itself so an admin does not have to ask. No status
 * workflow — this is a plain list, unlike comments or requests.
 */

export const MAX_FEEDBACK_MESSAGE_LENGTH = 2000;

export const createFeedbackSchema = z.object({
  message: nonEmptyText(MAX_FEEDBACK_MESSAGE_LENGTH),
  pageUrl: z.string().trim().min(1).max(2048),
  userAgent: z.string().trim().min(1).max(512),
  viewportWidth: z.number().int().positive(),
  viewportHeight: z.number().int().positive(),
  /** A `data:image/png;base64,...` URL. Optional — capture can fail or be skipped. */
  screenshot: z.string().optional(),
});
export type CreateFeedbackInput = z.infer<typeof createFeedbackSchema>;

export const listFeedbackSchema = pageQuerySchema;
export type ListFeedbackQuery = z.infer<typeof listFeedbackSchema>;
```

- [ ] **Step 2: Add the screenshot size cap beside `MAX_THUMBNAIL_BYTES`**

In `packages/shared/src/schemas/library.ts`, immediately after the existing line:

```ts
export const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;
```

add:

```ts

/** The decoded byte length of a feedback screenshot, checked server-side after base64 decoding. */
export const MAX_FEEDBACK_SCREENSHOT_BYTES = 5 * 1024 * 1024;
```

- [ ] **Step 3: Export the new schema module**

In `packages/shared/src/index.ts`, insert between the `comments.js` and `library.js` lines:

```ts
export * from './schemas/comments.js';
export * from './schemas/feedback.js';
export * from './schemas/library.js';
```

- [ ] **Step 4: Typecheck the package**

Run: `npm run typecheck -w packages/shared`
Expected: exits 0, no errors.

- [ ] **Step 5: Build the package**

Run: `npm run build -w packages/shared`
Expected: exits 0. This regenerates `packages/shared/dist`, which `apps/api` and `apps/web` import from — Task 3 onward will fail to find the new exports without this.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/schemas/feedback.ts packages/shared/src/schemas/library.ts packages/shared/src/index.ts
git commit -m "Add feedback request schemas to packages/shared"
```

---

## Task 2: Prisma — the `Feedback` model and its migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`

**Interfaces:**
- Produces: the `Feedback` table (`id`, `userId`, `message`, `pageUrl`, `userAgent`, `viewportWidth`, `viewportHeight`, `hasScreenshot`, `createdAt`) and `Prisma.FeedbackGetPayload`/`prisma.feedback.*` client methods, consumed by Task 4.

`hasScreenshot` is a boolean, not a stored key — the screenshot's storage key is always `feedback/<id>.png` (Task 3's `feedbackScreenshotKey`), the same way `artworkKey()` derives poster/banner keys from a video id alone. Nothing ever needs to update the row after create.

- [ ] **Step 1: Add the relation on `User`**

In `apps/api/prisma/schema.prisma`, in the `User` model's relations block (around line 141-149), add `feedback Feedback[]` after `comments Comment[]`:

```prisma
  uploads          Video[]
  progress         WatchProgress[]
  events           WatchEvent[]
  comments         Comment[]
  feedback         Feedback[]
  watchlist        WatchlistItem[]
```

- [ ] **Step 2: Add the `Feedback` model**

Append to the end of `apps/api/prisma/schema.prisma`:

```prisma

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

/// Submitted from the floating feedback button. No status workflow — admins
/// read this as a plain list and delete what they've dealt with.
model Feedback {
  id             String   @id @default(cuid())
  userId         String
  user           User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  message        String
  /// Where the submitter was when they opened the dialog.
  pageUrl        String
  userAgent      String
  viewportWidth  Int
  viewportHeight Int
  /// True means a file exists at `feedbackScreenshotKey(id)` under DERIVED_ROOT.
  /// Not a stored key — the key is deterministic from the id alone.
  hasScreenshot  Boolean  @default(false)
  createdAt      DateTime @default(now())

  @@index([createdAt])
}
```

- [ ] **Step 3: Generate and apply the migration**

Ensure Postgres is running (`docker compose up -d` from the repo root if it is not already). Then run:

Run: `npm run db:migrate -w apps/api -- --name add_feedback`
Expected: Prisma reports the new migration applied and regenerates the client (`apps/api/src/prisma/generated`) with no errors. A new folder appears under `apps/api/prisma/migrations/` named `<timestamp>_add_feedback`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "Add the Feedback model and its migration"
```

---

## Task 3: API — pure helpers (`feedbackScreenshotKey`, `toFeedbackView`)

**Files:**
- Create: `apps/api/src/feedback/keys.ts`
- Create: `apps/api/src/feedback/keys.spec.ts`
- Create: `apps/api/src/feedback/serialize.ts`
- Create: `apps/api/src/feedback/serialize.spec.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `feedbackScreenshotKey(id: string): string`, `toFeedbackView(row: StoredFeedback): FeedbackView`, `StoredFeedback`/`FeedbackView` types — all consumed by Task 4's `FeedbackService`.

- [ ] **Step 1: Write the failing test for the key helper**

```ts
// apps/api/src/feedback/keys.spec.ts
import { feedbackScreenshotKey } from './keys';

describe('feedbackScreenshotKey', () => {
  it('namespaces the id under feedback/ as a png', () => {
    expect(feedbackScreenshotKey('abc123')).toBe('feedback/abc123.png');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w apps/api -- feedback/keys.spec.ts`
Expected: FAIL — `Cannot find module './keys'`.

- [ ] **Step 3: Implement the key helper**

```ts
// apps/api/src/feedback/keys.ts
/**
 * Where a feedback screenshot lives under DERIVED_ROOT.
 *
 * Deterministic from the id alone — mirrors `artworkKey()` deriving
 * poster/banner keys from a video id — so nothing needs to be stored beyond
 * the `hasScreenshot` boolean on the row.
 */
export function feedbackScreenshotKey(id: string): string {
  return `feedback/${id}.png`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -w apps/api -- feedback/keys.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the serializer**

```ts
// apps/api/src/feedback/serialize.spec.ts
import { toFeedbackView, type StoredFeedback } from './serialize';

describe('toFeedbackView', () => {
  const row: StoredFeedback = {
    id: 'fb-1',
    message: 'The player is broken on this page',
    pageUrl: '/watch/heat',
    userAgent: 'Mozilla/5.0',
    viewportWidth: 1280,
    viewportHeight: 800,
    hasScreenshot: true,
    createdAt: new Date('2026-09-06T00:00:00.000Z'),
    user: { id: 'user-1', displayName: 'Ada' },
  };

  it('exposes exactly the intended fields', () => {
    expect(toFeedbackView(row)).toEqual({
      id: 'fb-1',
      message: 'The player is broken on this page',
      pageUrl: '/watch/heat',
      userAgent: 'Mozilla/5.0',
      viewportWidth: 1280,
      viewportHeight: 800,
      hasScreenshot: true,
      createdAt: row.createdAt,
      user: { id: 'user-1', displayName: 'Ada' },
    });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -w apps/api -- feedback/serialize.spec.ts`
Expected: FAIL — `Cannot find module './serialize'`.

- [ ] **Step 7: Implement the serializer**

```ts
// apps/api/src/feedback/serialize.ts
/**
 * Turning a stored feedback row into what a client is allowed to see.
 *
 * Built field by field, like `toCommentView` — even though there is no
 * tombstone case here, a column added to the row later must not ride along
 * into the response unnoticed.
 */

export interface StoredFeedback {
  id: string;
  message: string;
  pageUrl: string;
  userAgent: string;
  viewportWidth: number;
  viewportHeight: number;
  hasScreenshot: boolean;
  createdAt: Date;
  user: { id: string; displayName: string };
}

export type FeedbackView = StoredFeedback;

export function toFeedbackView(row: StoredFeedback): FeedbackView {
  return {
    id: row.id,
    message: row.message,
    pageUrl: row.pageUrl,
    userAgent: row.userAgent,
    viewportWidth: row.viewportWidth,
    viewportHeight: row.viewportHeight,
    hasScreenshot: row.hasScreenshot,
    createdAt: row.createdAt,
    user: row.user,
  };
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npm test -w apps/api -- feedback/serialize.spec.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/feedback/keys.ts apps/api/src/feedback/keys.spec.ts apps/api/src/feedback/serialize.ts apps/api/src/feedback/serialize.spec.ts
git commit -m "Add feedback's pure helpers: screenshot key and view serializer"
```

---

## Task 4: API — `FeedbackService`

**Files:**
- Create: `apps/api/src/feedback/feedback.service.ts`
- Create: `apps/api/src/feedback/feedback.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (from `../prisma/prisma.service`), `StorageService` (from `../common/storage.service`, `save(root, key, data): Promise<string>`, `statOf(root, key): Promise<{size, mtime} | null>`, `resolvePath(root, key): string`, `delete(root, key): Promise<void>`), `AuthUser` (from `../auth/auth.types`), `feedbackScreenshotKey`/`toFeedbackView`/`StoredFeedback`/`FeedbackView` (Task 3), `CreateFeedbackInput`/`ListFeedbackQuery`/`MAX_FEEDBACK_SCREENSHOT_BYTES`/`toPage`/`Page` (`@video/shared`).
- Produces: `FeedbackService` with `create(user, dto): Promise<FeedbackView>`, `listForAdmin(query): Promise<Page<FeedbackView>>`, `sendScreenshot(id, response): Promise<void>`, `remove(id): Promise<void>` — consumed by Task 5's `FeedbackController`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/feedback/feedback.service.spec.ts
import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';

import type { AuthUser } from '../auth/auth.types';
import type { StorageService } from '../common/storage.service';
import type { PrismaService } from '../prisma/prisma.service';
import { FeedbackService } from './feedback.service';
import { feedbackScreenshotKey } from './keys';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('FeedbackService', () => {
  const user: AuthUser = {
    id: 'user-1',
    username: 'ada',
    displayName: 'Ada',
    role: 'USER',
    isActive: true,
  };

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'fb-1',
    message: 'Broken player',
    pageUrl: '/watch/heat',
    userAgent: 'Mozilla/5.0',
    viewportWidth: 1280,
    viewportHeight: 800,
    hasScreenshot: false,
    createdAt: new Date('2026-09-06T00:00:00.000Z'),
    user: { id: 'user-1', displayName: 'Ada' },
    ...overrides,
  });

  let create: jest.Mock;
  let findMany: jest.Mock;
  let count: jest.Mock;
  let findUnique: jest.Mock;
  let deleteRow: jest.Mock;
  let $transaction: jest.Mock;
  let save: jest.Mock;
  let statOf: jest.Mock;
  let deleteFile: jest.Mock;
  let resolvePath: jest.Mock;
  let service: FeedbackService;

  beforeEach(() => {
    create = jest.fn().mockResolvedValue(row());
    findMany = jest.fn().mockReturnValue('findMany-promise');
    count = jest.fn().mockReturnValue('count-promise');
    findUnique = jest.fn();
    deleteRow = jest.fn().mockResolvedValue(undefined);
    $transaction = jest.fn().mockResolvedValue([[row()], 1]);
    save = jest.fn().mockResolvedValue('/derived/feedback/fb-1.png');
    statOf = jest.fn().mockResolvedValue({ size: 100, mtime: new Date() });
    deleteFile = jest.fn().mockResolvedValue(undefined);
    resolvePath = jest.fn().mockReturnValue('/derived/feedback/fb-1.png');

    const prisma = {
      feedback: { create, findMany, count, findUnique, delete: deleteRow },
      $transaction,
    } as unknown as PrismaService;

    const storage = {
      save,
      statOf,
      delete: deleteFile,
      resolvePath,
    } as unknown as StorageService;

    service = new FeedbackService(prisma, storage);
  });

  describe('create', () => {
    it('creates the row with hasScreenshot false and never touches storage when no screenshot is sent', async () => {
      await service.create(user, {
        message: 'Broken player',
        pageUrl: '/watch/heat',
        userAgent: 'Mozilla/5.0',
        viewportWidth: 1280,
        viewportHeight: 800,
      });

      expect(create.mock.calls[0][0].data).toMatchObject({ userId: 'user-1', hasScreenshot: false });
      expect(save).not.toHaveBeenCalled();
    });

    it('decodes a data-URL screenshot and saves it under the deterministic key', async () => {
      create.mockResolvedValue(row({ hasScreenshot: true }));

      await service.create(user, {
        message: 'Broken player',
        pageUrl: '/watch/heat',
        userAgent: 'Mozilla/5.0',
        viewportWidth: 1280,
        viewportHeight: 800,
        screenshot: `data:image/png;base64,${TINY_PNG_BASE64}`,
      });

      expect(create.mock.calls[0][0].data.hasScreenshot).toBe(true);
      expect(save).toHaveBeenCalledWith(
        'derived',
        feedbackScreenshotKey('fb-1'),
        Buffer.from(TINY_PNG_BASE64, 'base64'),
      );
    });

    it('rejects a screenshot over the size cap, before writing anything', async () => {
      const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 1).toString('base64');

      await expect(
        service.create(user, {
          message: 'Broken player',
          pageUrl: '/watch/heat',
          userAgent: 'Mozilla/5.0',
          viewportWidth: 1280,
          viewportHeight: 800,
          screenshot: `data:image/png;base64,${oversized}`,
        }),
      ).rejects.toThrow('too large');

      expect(create).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    });
  });

  describe('listForAdmin', () => {
    it('returns a Page ordered newest first', async () => {
      const page = await service.listForAdmin({ limit: 50, offset: 0 });

      expect($transaction).toHaveBeenCalled();
      expect(findMany.mock.calls[0][0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(page).toMatchObject({ total: 1, limit: 50, offset: 0 });
      expect(page.items[0].id).toBe('fb-1');
    });
  });

  describe('sendScreenshot', () => {
    const response = { setHeader: jest.fn(), req: { headers: {} } } as unknown as Response;

    it('404s when the row has no screenshot', async () => {
      findUnique.mockResolvedValue(row({ hasScreenshot: false }));

      await expect(service.sendScreenshot('fb-1', response)).rejects.toThrow(NotFoundException);
    });

    it('404s when the row does not exist', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.sendScreenshot('fb-1', response)).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes the row and the screenshot file when one exists', async () => {
      findUnique.mockResolvedValue(row({ hasScreenshot: true }));

      await service.remove('fb-1');

      expect(deleteRow).toHaveBeenCalledWith({ where: { id: 'fb-1' } });
      expect(deleteFile).toHaveBeenCalledWith('derived', feedbackScreenshotKey('fb-1'));
    });

    it('skips the storage delete when there was never a screenshot', async () => {
      findUnique.mockResolvedValue(row({ hasScreenshot: false }));

      await service.remove('fb-1');

      expect(deleteFile).not.toHaveBeenCalled();
    });

    it('404s an unknown id', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.remove('nope')).rejects.toThrow(NotFoundException);
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w apps/api -- feedback/feedback.service.spec.ts`
Expected: FAIL — `Cannot find module './feedback.service'`.

- [ ] **Step 3: Implement the service**

```ts
// apps/api/src/feedback/feedback.service.ts
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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -w apps/api -- feedback/feedback.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/feedback/feedback.service.ts apps/api/src/feedback/feedback.service.spec.ts
git commit -m "Add FeedbackService"
```

---

## Task 5: API — controller, module, and the JSON body-size fix

**Files:**
- Create: `apps/api/src/feedback/feedback.controller.ts`
- Create: `apps/api/src/feedback/feedback.module.ts`
- Modify: `apps/api/src/app.module.ts` (register `FeedbackModule`)
- Modify: `apps/api/src/main.ts` (raise the JSON body-parser limit)

**Interfaces:**
- Consumes: `FeedbackService` (Task 4), `validate` (`../common/zod-validation.pipe`), `CurrentUser`/`Roles` (`../auth/decorators`), `ThrottleAuthoring` (`../common/throttling`), `createFeedbackSchema`/`listFeedbackSchema`/`CreateFeedbackInput`/`ListFeedbackQuery` (`@video/shared`).
- Produces: `POST /feedback`, `GET /admin/feedback`, `GET /admin/feedback/:id/screenshot`, `DELETE /admin/feedback/:id` — consumed by Task 6 (db-spec) and every frontend task from Task 9 onward.

- [ ] **Step 1: Write the controller**

```ts
// apps/api/src/feedback/feedback.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  createFeedbackSchema,
  listFeedbackSchema,
  type CreateFeedbackInput,
  type ListFeedbackQuery,
} from '@video/shared';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { ThrottleAuthoring } from '../common/throttling';
import { validate } from '../common/zod-validation.pipe';
import { FeedbackService } from './feedback.service';

@Controller()
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  /** Any signed-in user — no `@Roles`, the session guard alone is enough. */
  @ThrottleAuthoring()
  @Post('feedback')
  create(
    @CurrentUser() user: AuthUser,
    @Body(validate(createFeedbackSchema)) dto: CreateFeedbackInput,
  ) {
    return this.feedback.create(user, dto);
  }

  @Get('admin/feedback')
  @Roles('ADMIN')
  list(@Query(validate(listFeedbackSchema)) query: ListFeedbackQuery) {
    return this.feedback.listForAdmin(query);
  }

  @Get('admin/feedback/:id/screenshot')
  @Roles('ADMIN')
  screenshot(@Param('id') id: string, @Res() response: Response) {
    return this.feedback.sendScreenshot(id, response);
  }

  @Delete('admin/feedback/:id')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string): Promise<void> {
    return this.feedback.remove(id);
  }
}
```

- [ ] **Step 2: Write the module**

```ts
// apps/api/src/feedback/feedback.module.ts
import { Module } from '@nestjs/common';

import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';

@Module({
  controllers: [FeedbackController],
  providers: [FeedbackService],
})
export class FeedbackModule {}
```

- [ ] **Step 3: Register the module in `AppModule`**

In `apps/api/src/app.module.ts`, add the import near the other feature modules (alphabetically, after `CreditsModule` and before `IngestModule` fits the existing rough grouping — exact position doesn't matter, just add it):

```ts
import { CreditsModule } from './credits/credits.module';
import { FeedbackModule } from './feedback/feedback.module';
import { IngestModule } from './ingest/ingest.module';
```

And in the `imports` array:

```ts
    CreditsModule,
    FeedbackModule,
    CommentsModule,
```

- [ ] **Step 4: Raise the JSON body-parser limit in `main.ts`**

Nest's default Express body parser caps a JSON body at 100kb. A feedback screenshot (`MAX_FEEDBACK_SCREENSHOT_BYTES` = 5MB raw, ~6.7MB once base64-encoded) blows past that before `createFeedbackSchema` — let alone the service's own size check — ever runs; the request 413s at the parser. Fix by disabling Nest's automatic parser and installing one with a higher limit, in `apps/api/src/main.ts`:

```ts
import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { SessionStoreService } from './auth/session-store.service';
import { bigIntReplacer } from './common/json';
import { describeError } from './common/errors';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });

  /*
   * Nest's default body parser caps a JSON body at Express's stock 100kb,
   * which a feedback screenshot blows straight past — a base64-encoded PNG
   * runs ~1.33x its raw byte size, before MAX_FEEDBACK_SCREENSHOT_BYTES
   * (5MB) even gets a chance to reject it, so the request would 413 before
   * validation ever runs. Raised globally rather than per-route: nothing
   * else in this API sends a JSON body anywhere near this size, and every
   * multipart upload (posters, subtitles) goes through multer, which never
   * touches this parser at all.
   */
  app.use(json({ limit: '7mb' }));
  app.use(urlencoded({ extended: true, limit: '7mb' }));

  // `Video.sizeBytes` is a BigInt, and JSON.stringify throws on those. Express
  // hands this replacer to every res.json(), so it is handled once at the real
  // response boundary rather than remembered at each call site.
  app.set('json replacer', bigIntReplacer);
```

(The rest of `bootstrap()` — helmet, trust proxy, the session middleware, shutdown hooks, `listen()` — is unchanged; only the `NestFactory.create` call and the two lines above it move/change.)

- [ ] **Step 5: Verify it compiles**

Run: `npm run build -w apps/api`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/feedback/feedback.controller.ts apps/api/src/feedback/feedback.module.ts apps/api/src/app.module.ts apps/api/src/main.ts
git commit -m "Wire up the feedback API and raise the JSON body limit for screenshots"
```

---

## Task 6: API — integration tests against a real database

**Files:**
- Create: `apps/api/test/feedback.db-spec.ts`

**Interfaces:**
- Consumes: `DbHarness` (`./db/harness`), the live `POST /feedback`, `GET /admin/feedback`, `GET /admin/feedback/:id/screenshot`, `DELETE /admin/feedback/:id` routes from Task 5.

This is where the auth boundary is actually proven end-to-end (comments/requests follow the same convention — role checks live in the `.db-spec.ts`, not a separate stubbed e2e-spec).

- [ ] **Step 1: Write the test file**

```ts
// apps/api/test/feedback.db-spec.ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import request from 'supertest';

import { PrismaService } from '../src/prisma/prisma.service';
import { DbHarness } from './db/harness';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/**
 * Feedback submitted from the floating button.
 *
 * No status workflow, unlike comments or requests — the tests here cover who
 * may do what (any signed-in user submits, only an admin reads or removes)
 * and the screenshot's storage round trip, which nothing else exercises.
 */
describe('Feedback (real database)', () => {
  const harness = new DbHarness({ name: 'feedback', workspace: true });

  let prisma: PrismaService;
  let admin: request.Agent;
  let ada: request.Agent;

  const body = (overrides: Record<string, unknown> = {}) => ({
    message: 'The player controls overlap on a phone.',
    pageUrl: '/watch/heat',
    userAgent: 'Mozilla/5.0',
    viewportWidth: 375,
    viewportHeight: 812,
    ...overrides,
  });

  beforeEach(async () => {
    await harness.start();
    ({ prisma, admin } = harness);
    ada = await harness.invite('ada');
  });

  afterEach(() => harness.stop());

  describe('submitting', () => {
    it('accepts a text-only submission from an ordinary user', async () => {
      const response = await ada.post('/feedback').send(body()).expect(201);

      expect(response.body).toMatchObject({
        message: body().message,
        hasScreenshot: false,
        user: { id: expect.any(String), displayName: 'ada' },
      });
    });

    it('accepts one from an admin too', async () => {
      await admin.post('/feedback').send(body()).expect(201);
    });

    it('refuses a signed-out submission', async () => {
      await harness.agent().post('/feedback').send(body()).expect(401);
    });

    it('refuses an empty message', async () => {
      await ada.post('/feedback').send(body({ message: '   ' })).expect(400);
    });

    it('decodes and stores a screenshot, and it streams back byte-for-byte', async () => {
      const response = await ada
        .post('/feedback')
        .send(body({ screenshot: `data:image/png;base64,${TINY_PNG_BASE64}` }))
        .expect(201);

      expect(response.body.hasScreenshot).toBe(true);

      const image = await admin
        .get(`/admin/feedback/${response.body.id}/screenshot`)
        .expect(200);

      expect(image.headers['content-type']).toBe('image/png');
      expect(Buffer.from(image.body).equals(Buffer.from(TINY_PNG_BASE64, 'base64'))).toBe(true);
    });
  });

  describe('the admin list', () => {
    it('is admin-only', async () => {
      await ada.get('/admin/feedback').expect(403);
      await admin.get('/admin/feedback').expect(200);
    });

    it('returns a Page, newest first', async () => {
      await ada.post('/feedback').send(body({ message: 'First' })).expect(201);
      await ada.post('/feedback').send(body({ message: 'Second' })).expect(201);

      const response = await admin.get('/admin/feedback').expect(200);

      expect(response.body).toMatchObject({ total: 2, limit: 50, offset: 0 });
      expect(response.body.items.map((f: { message: string }) => f.message)).toEqual([
        'Second',
        'First',
      ]);
    });
  });

  describe('the screenshot route', () => {
    it('is admin-only', async () => {
      const created = await ada
        .post('/feedback')
        .send(body({ screenshot: `data:image/png;base64,${TINY_PNG_BASE64}` }))
        .expect(201);

      await ada.get(`/admin/feedback/${created.body.id}/screenshot`).expect(403);
    });

    it('404s a submission with no screenshot', async () => {
      const created = await ada.post('/feedback').send(body()).expect(201);

      await admin.get(`/admin/feedback/${created.body.id}/screenshot`).expect(404);
    });

    it('404s an unknown id', async () => {
      await admin.get('/admin/feedback/nope/screenshot').expect(404);
    });
  });

  describe('deleting', () => {
    it('is admin-only', async () => {
      const created = await ada.post('/feedback').send(body()).expect(201);

      await ada.delete(`/admin/feedback/${created.body.id}`).expect(403);
    });

    it('removes the row and its screenshot file', async () => {
      const created = await ada
        .post('/feedback')
        .send(body({ screenshot: `data:image/png;base64,${TINY_PNG_BASE64}` }))
        .expect(201);

      const filePath = join(harness.workspace, 'derived', 'feedback', `${created.body.id}.png`);
      expect(existsSync(filePath)).toBe(true);

      await admin.delete(`/admin/feedback/${created.body.id}`).expect(204);

      expect(existsSync(filePath)).toBe(false);
      await expect(
        prisma.feedback.findUnique({ where: { id: created.body.id } }),
      ).resolves.toBeNull();
    });

    it('removes a submission with no screenshot too', async () => {
      const created = await ada.post('/feedback').send(body()).expect(201);

      await admin.delete(`/admin/feedback/${created.body.id}`).expect(204);
    });

    it('404s an unknown id', async () => {
      await admin.delete('/admin/feedback/nope').expect(404);
    });
  });
});
```

- [ ] **Step 2: Run it**

Ensure Postgres is running. Since this worktree may run alongside other checkouts (see CLAUDE.md's note on `test:db` isolation), set a private database and temp dir for this run:

Run: `TEST_DATABASE_URL="${TEST_DATABASE_URL:-}postgresql://postgres:postgres@localhost:5432/video_test_feedback_widget" TMPDIR=$(mktemp -d) npm run test:db -w apps/api -- feedback.db-spec.ts`

Expected: all tests PASS. (Adjust the `TEST_DATABASE_URL` credentials/host to match this environment's actual Postgres connection if it differs from the default — check `apps/api/.env` or `docker-compose.yml` for the real ones if the above fails to connect.)

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/feedback.db-spec.ts
git commit -m "Add integration tests for the feedback API"
```

---

## Task 7: Web — dependencies and the `vue-konva` plugin

**Files:**
- Modify: `apps/web/package.json` (add `html2canvas`, `konva`, `vue-konva`)
- Create: `apps/web/app/plugins/vue-konva.client.ts`

**Interfaces:**
- Produces: the global `<v-stage>`/`<v-layer>`/`<v-line>`/`<v-rect>`/`<v-arrow>`/`<v-text>`/`<v-image>` components, consumed by Task 8's `FeedbackAnnotator.vue`.

- [ ] **Step 1: Add the dependencies**

In `apps/web/package.json`, add to `dependencies` (alphabetically):

```json
    "html2canvas": "^1.4.1",
    "konva": "^10.3.3",
```

and, after `nuxt`:

```json
    "vue-konva": "^4.0.1",
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: exits 0, `package-lock.json` updates to include the three new packages.

- [ ] **Step 3: Register the `vue-konva` plugin, client-only**

Konva touches `window`/canvas at load time and must never be evaluated during SSR — the annotator only ever mounts after a user click, so a client-only plugin costs nothing.

```ts
// apps/web/app/plugins/vue-konva.client.ts
import VueKonva from 'vue-konva'

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.use(VueKonva)
})
```

- [ ] **Step 4: Verify the dev server still boots**

Run: `npm run dev -w apps/web` (in the background, or in a separate terminal), then check it serves `http://localhost:3000` without a console error, and stop it. (No component uses `<v-stage>` yet, so this step only proves the plugin itself doesn't break startup.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json package-lock.json apps/web/app/plugins/vue-konva.client.ts
git commit -m "Add html2canvas and vue-konva for the feedback widget"
```

---

## Task 8: Web — `FeedbackAnnotator.vue`

**Files:**
- Create: `apps/web/app/components/FeedbackAnnotator.vue`

**Interfaces:**
- Consumes: `screenshot: string` prop (a `data:image/png;base64,...` URL), `vue-konva`'s global components (Task 7).
- Produces: a component exposing `export(): string` (returns a flattened `data:image/png;base64,...` URL at the screenshot's original resolution) — consumed by Task 9's `FeedbackDialog.vue`.

- [ ] **Step 1: Write the component**

```vue
<!-- apps/web/app/components/FeedbackAnnotator.vue -->
<script setup lang="ts">
/**
 * Pen, rectangle, arrow and text on top of a captured screenshot.
 *
 * The stage is drawn at the screenshot's natural resolution and scaled down
 * with `scaleX`/`scaleY` to fit the dialog — Konva reports pointer positions
 * already converted into that natural coordinate space, so every shape is
 * stored and drawn in the same units the exported image uses. `export()`
 * asks for `pixelRatio: 1 / scale`, which renders the export back up to the
 * screenshot's original size regardless of how small the editor displayed it.
 *
 * Shape ids are a plain counter, not `crypto.randomUUID()` — that API does
 * not exist on an insecure context (this app is opened from a phone on the
 * LAN over plain HTTP), and a disposable local id has no reason to risk it.
 */
const props = defineProps<{
  screenshot: string
}>()

type Tool = 'pen' | 'rectangle' | 'arrow' | 'text'

interface LineShape { id: number, type: 'line', config: { points: number[], stroke: string, strokeWidth: number, lineCap: 'round', lineJoin: 'round' } }
interface RectShape { id: number, type: 'rect', config: { x: number, y: number, width: number, height: number, stroke: string, strokeWidth: number } }
interface ArrowShape { id: number, type: 'arrow', config: { points: number[], stroke: string, strokeWidth: number, fill: string, pointerLength: number, pointerWidth: number } }
interface TextShape { id: number, type: 'text', config: { x: number, y: number, text: string, fill: string, fontSize: number } }
type Shape = LineShape | RectShape | ArrowShape | TextShape

const STROKE_COLOR = '#ef4444'
const STROKE_WIDTH = 4
const MAX_DISPLAY_WIDTH = 640
const MAX_DISPLAY_HEIGHT = 480

const tool = ref<Tool>('pen')
const shapes = ref<Shape[]>([])
const currentShape = ref<Shape | null>(null)
const drawing = ref(false)
const dragStart = ref({ x: 0, y: 0 })

let nextId = 0
const newId = () => nextId++

const image = ref<HTMLImageElement | null>(null)
const naturalWidth = ref(0)
const naturalHeight = ref(0)

onMounted(() => {
  const img = new Image()
  img.onload = () => {
    naturalWidth.value = img.naturalWidth
    naturalHeight.value = img.naturalHeight
    image.value = img
  }
  img.src = props.screenshot
})

const scale = computed(() => {
  if (naturalWidth.value === 0) return 1
  return Math.min(1, MAX_DISPLAY_WIDTH / naturalWidth.value, MAX_DISPLAY_HEIGHT / naturalHeight.value)
})
const displayWidth = computed(() => naturalWidth.value * scale.value)
const displayHeight = computed(() => naturalHeight.value * scale.value)

const stageConfig = computed(() => ({
  width: displayWidth.value,
  height: displayHeight.value,
  scaleX: scale.value,
  scaleY: scale.value,
}))

const imageConfig = computed(() => ({
  image: image.value,
  x: 0,
  y: 0,
  width: naturalWidth.value,
  height: naturalHeight.value,
}))

/** Position placing an inline `<input>` for the text tool. `null` when not active. */
const textInput = ref<{ x: number, y: number, displayX: number, displayY: number } | null>(null)
const textValue = ref('')

interface KonvaPointerEvent { target: { getStage: () => { getPointerPosition: () => { x: number, y: number } | null } } }

function pointerPosition(event: KonvaPointerEvent): { x: number, y: number } | null {
  return event.target.getStage().getPointerPosition()
}

function onPointerDown(event: KonvaPointerEvent) {
  const pos = pointerPosition(event)
  if (!pos) return

  if (tool.value === 'text') {
    textInput.value = { x: pos.x, y: pos.y, displayX: pos.x * scale.value, displayY: pos.y * scale.value }
    textValue.value = ''
    return
  }

  drawing.value = true
  dragStart.value = pos

  if (tool.value === 'pen') {
    currentShape.value = {
      id: newId(),
      type: 'line',
      config: { points: [pos.x, pos.y], stroke: STROKE_COLOR, strokeWidth: STROKE_WIDTH, lineCap: 'round', lineJoin: 'round' },
    }
  } else if (tool.value === 'rectangle') {
    currentShape.value = {
      id: newId(),
      type: 'rect',
      config: { x: pos.x, y: pos.y, width: 0, height: 0, stroke: STROKE_COLOR, strokeWidth: STROKE_WIDTH },
    }
  } else {
    currentShape.value = {
      id: newId(),
      type: 'arrow',
      config: { points: [pos.x, pos.y, pos.x, pos.y], stroke: STROKE_COLOR, strokeWidth: STROKE_WIDTH, fill: STROKE_COLOR, pointerLength: 10, pointerWidth: 10 },
    }
  }
}

function onPointerMove(event: KonvaPointerEvent) {
  if (!drawing.value || !currentShape.value) return
  const pos = pointerPosition(event)
  if (!pos) return

  const shape = currentShape.value
  if (shape.type === 'line') {
    shape.config.points = [...shape.config.points, pos.x, pos.y]
  } else if (shape.type === 'rect') {
    shape.config.width = pos.x - dragStart.value.x
    shape.config.height = pos.y - dragStart.value.y
  } else if (shape.type === 'arrow') {
    shape.config.points = [dragStart.value.x, dragStart.value.y, pos.x, pos.y]
  }
}

function onPointerUp() {
  if (drawing.value && currentShape.value) {
    shapes.value.push(currentShape.value)
  }
  drawing.value = false
  currentShape.value = null
}

function commitText() {
  if (textInput.value && textValue.value.trim()) {
    shapes.value.push({
      id: newId(),
      type: 'text',
      config: { x: textInput.value.x, y: textInput.value.y, text: textValue.value, fill: STROKE_COLOR, fontSize: 24 },
    })
  }
  textInput.value = null
  textValue.value = ''
}

function undo() {
  shapes.value.pop()
}

const stageRef = useTemplateRef('stage')

function exportImage(): string {
  const stage = stageRef.value?.getNode()
  if (!stage) return props.screenshot
  return stage.toDataURL({ pixelRatio: scale.value > 0 ? 1 / scale.value : 1 })
}

defineExpose({ export: exportImage })
</script>

<template>
  <div class="space-y-2">
    <div class="flex gap-1">
      <UButton size="xs" :variant="tool === 'pen' ? 'solid' : 'subtle'" color="neutral" icon="i-lucide-pencil" aria-label="Pen" @click="tool = 'pen'" />
      <UButton size="xs" :variant="tool === 'rectangle' ? 'solid' : 'subtle'" color="neutral" icon="i-lucide-square" aria-label="Rectangle" @click="tool = 'rectangle'" />
      <UButton size="xs" :variant="tool === 'arrow' ? 'solid' : 'subtle'" color="neutral" icon="i-lucide-move-up-right" aria-label="Arrow" @click="tool = 'arrow'" />
      <UButton size="xs" :variant="tool === 'text' ? 'solid' : 'subtle'" color="neutral" icon="i-lucide-type" aria-label="Text" @click="tool = 'text'" />
      <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-undo-2" :disabled="shapes.length === 0" aria-label="Undo" class="ml-auto" @click="undo" />
    </div>

    <div class="relative inline-block" :style="{ width: `${displayWidth}px`, height: `${displayHeight}px` }">
      <v-stage
        v-if="image"
        ref="stage"
        :config="stageConfig"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
      >
        <v-layer>
          <v-image :config="imageConfig" />
          <template v-for="shape in shapes" :key="shape.id">
            <v-line v-if="shape.type === 'line'" :config="shape.config" />
            <v-rect v-else-if="shape.type === 'rect'" :config="shape.config" />
            <v-arrow v-else-if="shape.type === 'arrow'" :config="shape.config" />
            <v-text v-else :config="shape.config" />
          </template>
          <template v-if="currentShape">
            <v-line v-if="currentShape.type === 'line'" :config="currentShape.config" />
            <v-rect v-else-if="currentShape.type === 'rect'" :config="currentShape.config" />
            <v-arrow v-else-if="currentShape.type === 'arrow'" :config="currentShape.config" />
          </template>
        </v-layer>
      </v-stage>

      <input
        v-if="textInput"
        v-model="textValue"
        type="text"
        autofocus
        class="absolute rounded border border-(--ui-border) bg-(--ui-bg) px-1 text-sm"
        :style="{ left: `${textInput.displayX}px`, top: `${textInput.displayY - 12}px` }"
        @blur="commitText"
        @keydown.enter="commitText"
      >
    </div>
  </div>
</template>
```

- [ ] **Step 2: Manual verification**

There is no meaningful unit test here — every branch depends on Konva's canvas rendering and pointer geometry, which is exactly what Task 11's Playwright test exercises against the real thing. For now:

Run: `npm run dev -w apps/web` and `npm run dev -w apps/api` in separate terminals (per CLAUDE.md's note that `npm run dev` alone starves the API — use `dev:api`/`dev:web` if those scripts exist, otherwise the two dev servers separately).

This component has no page mounting it yet (that's Task 9), so full manual verification happens there — for now, just run `npm run typecheck -w apps/web` to confirm it compiles.

Run: `npm run typecheck -w apps/web`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/components/FeedbackAnnotator.vue
git commit -m "Add the Konva-based screenshot annotator"
```

---

## Task 9: Web — capture, button, dialog, and mounting it globally

**Files:**
- Create: `apps/web/app/utils/feedback-capture.ts`
- Create: `apps/web/app/components/FeedbackButton.vue`
- Create: `apps/web/app/components/FeedbackDialog.vue`
- Modify: `apps/web/app/app.vue` (mount the button)

**Interfaces:**
- Consumes: `captureScreenshot()` (this task), `FeedbackAnnotator` (Task 8, `export(): string`), `useApi`/`apiMessage`/`useSession` (existing composables/utils), `MAX_FEEDBACK_MESSAGE_LENGTH` (`@video/shared`, Task 1).
- Produces: `<FeedbackButton>` mounted globally; `POST /feedback` calls from the browser.

- [ ] **Step 1: Write the capture utility**

```ts
// apps/web/app/utils/feedback-capture.ts
/**
 * Snapshots the current page into a PNG data URL for the feedback dialog.
 *
 * Dynamically imported so html2canvas — which touches `document` at module
 * scope — is never pulled into the SSR bundle; this only ever runs from a
 * click. Cannot capture cross-origin iframes (the hero trailer) or reliably
 * capture <video>/live <canvas> content — those render blank or frozen. Not
 * worked around; the text message still describes what's wrong, and a failed
 * capture degrades to a text-only submission rather than blocking the dialog.
 */
export async function captureScreenshot(): Promise<string | null> {
  try {
    const { default: html2canvas } = await import('html2canvas')
    const canvas = await html2canvas(document.body, {
      ignoreElements: el => el.closest('[data-feedback-ui]') !== null,
    })
    return canvas.toDataURL('image/png')
  }
  catch {
    return null
  }
}
```

- [ ] **Step 2: Write the button**

The button is marked `data-feedback-ui` so `captureScreenshot`'s `ignoreElements` excludes it from the screenshot it takes of everything else on the page. (The dialog itself needs no such marker — it is not mounted yet at the moment capture runs; capture happens first, on click, and the dialog opens only once it resolves.)

```vue
<!-- apps/web/app/components/FeedbackButton.vue -->
<script setup lang="ts">
/**
 * The floating "send feedback" trigger, mounted once in app.vue for every
 * signed-in visitor.
 */
const open = ref(false)
const screenshot = ref<string | null>(null)
const capturing = ref(false)

async function openDialog() {
  capturing.value = true
  screenshot.value = await captureScreenshot()
  capturing.value = false
  open.value = true
}
</script>

<template>
  <button
    type="button"
    data-feedback-ui
    :disabled="capturing"
    class="fixed right-6 bottom-6 z-40 flex size-12 items-center justify-center rounded-full bg-(--ui-primary) text-(--ui-bg) shadow-lg transition-transform hover:scale-105 disabled:opacity-60"
    aria-label="Send feedback"
    @click="openDialog"
  >
    <UIcon name="i-lucide-message-circle-warning" class="size-5" />
  </button>

  <FeedbackDialog v-model:open="open" :screenshot="screenshot" />
</template>
```

- [ ] **Step 3: Write the dialog**

```vue
<!-- apps/web/app/components/FeedbackDialog.vue -->
<script setup lang="ts">
import { MAX_FEEDBACK_MESSAGE_LENGTH } from '@video/shared'

import FeedbackAnnotatorComponent from './FeedbackAnnotator.vue'

const props = defineProps<{
  screenshot: string | null
}>()

const open = defineModel<boolean>('open', { required: true })

const api = useApi()
const toast = useToast()
const route = useRoute()

const message = ref('')
const submitting = ref(false)
const annotator = ref<InstanceType<typeof FeedbackAnnotatorComponent> | null>(null)

watch(open, (value) => {
  if (!value) message.value = ''
})

async function submit() {
  if (!message.value.trim()) return

  submitting.value = true
  try {
    await api('/feedback', {
      method: 'POST',
      body: {
        message: message.value,
        pageUrl: route.fullPath,
        userAgent: navigator.userAgent,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        screenshot: annotator.value?.export() ?? props.screenshot ?? undefined,
      },
    })
    toast.add({ title: 'Thanks — feedback sent', color: 'success' })
    open.value = false
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not send that.'), color: 'error' })
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Send feedback">
    <template #body>
      <div class="space-y-4">
        <FeedbackAnnotator v-if="screenshot" ref="annotator" :screenshot="screenshot" />
        <p v-else class="text-sm text-(--ui-text-muted)">
          Couldn't capture a screenshot of this page — you can still describe what's wrong below.
        </p>

        <UTextarea
          v-model="message"
          :maxlength="MAX_FEEDBACK_MESSAGE_LENGTH"
          :rows="3"
          placeholder="What's wrong, or what could be better?"
          aria-label="Feedback message"
          class="w-full"
        />
      </div>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="open = false">Cancel</UButton>
        <UButton :loading="submitting" :disabled="!message.trim()" @click="submit">Send</UButton>
      </div>
    </template>
  </UModal>
</template>
```

(`UModal` is dismissible by clicking outside it by default, like every other modal in this app — nothing here overrides `dismissible`/`preventClose`, so closing that way just discards the draft, the same as Cancel.)

- [ ] **Step 4: Mount the button globally**

In `apps/web/app/app.vue`, gate it on `useSession().isSignedIn` — true on every ordinary page, false on `/login` and `/setup` (both `layout: 'auth'`), so no separate route check is needed:

```vue
<script setup lang="ts">
useHead({
  titleTemplate: title => (title ? `${title} · Library` : 'Library'),
})

const { isSignedIn } = useSession()
</script>

<template>
  <UApp :scroll-body="false">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
    <FeedbackButton v-if="isSignedIn" />
  </UApp>
</template>
```

- [ ] **Step 5: Manual verification in a browser**

Run `npm run dev -w apps/api` and `npm run dev -w apps/web` (separately, per CLAUDE.md's note that `npm run dev` alone starves the API). Sign in, confirm:
- The button appears bottom-right on an ordinary page and is absent on `/login`.
- Clicking it opens the dialog with an annotated-looking screenshot of the page (minus the button itself).
- Drawing with each tool (pen, rectangle, arrow, text) works, and Undo removes the last shape.
- Submitting with a message succeeds (toast, dialog closes); submitting with an empty message is refused (button disabled).
- Clicking outside the open dialog closes it.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/utils/feedback-capture.ts apps/web/app/components/FeedbackButton.vue apps/web/app/components/FeedbackDialog.vue apps/web/app/app.vue
git commit -m "Add the feedback button, dialog, and screenshot capture"
```

---

## Task 10: Web — the admin feedback page

**Files:**
- Create: `apps/web/app/pages/admin/feedback.vue`
- Modify: `apps/web/app/layouts/admin.vue` (add the nav entry)

**Interfaces:**
- Consumes: `useApiData<Page<FeedbackAdminView>>` against `GET /admin/feedback`, `DELETE /admin/feedback/:id` (Task 5).

- [ ] **Step 1: Add the nav entry**

In `apps/web/app/layouts/admin.vue`, in the `sections` array, add after `Requests`:

```ts
  { label: 'Requests', to: '/admin/requests', icon: 'i-lucide-ticket' },
  { label: 'Feedback', to: '/admin/feedback', icon: 'i-lucide-message-circle-warning' },
  { label: 'People', to: '/admin/people', icon: 'i-lucide-users' },
```

- [ ] **Step 2: Write the page**

```vue
<!-- apps/web/app/pages/admin/feedback.vue -->
<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * Everything submitted through the floating feedback button, newest first.
 *
 * No status workflow, unlike Comments or Requests — read it, act on it, and
 * delete it when you're done. The screenshot (when there is one) is served
 * from its own admin-only route rather than embedded in this response.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface FeedbackAdminView {
  id: string
  message: string
  pageUrl: string
  userAgent: string
  viewportWidth: number
  viewportHeight: number
  hasScreenshot: boolean
  createdAt: string
  user: { id: string, displayName: string }
}

const api = useApi()
const toast = useToast()

const { data, refresh } = await useApiData<Page<FeedbackAdminView>>(
  'admin-feedback',
  () => '/admin/feedback?limit=100',
  {},
)

const items = computed(() => data.value?.items ?? [])

const viewing = ref<FeedbackAdminView | null>(null)

async function remove(item: FeedbackAdminView) {
  try {
    await api(`/admin/feedback/${item.id}`, { method: 'DELETE' })
    await refresh()
    toast.add({ title: 'Feedback removed', color: 'success' })
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not remove that.'), color: 'error' })
  }
}

useHead({ title: 'Feedback' })
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Feedback</h1>
      <p class="text-sm text-(--ui-text-muted)">
        Everything submitted through the feedback button, newest first.
      </p>
    </div>

    <div v-if="items.length" class="space-y-2">
      <article
        v-for="item in items"
        :key="item.id"
        class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4"
      >
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <span class="font-medium">{{ item.user.displayName }}</span>
          <span class="text-(--ui-text-dimmed)">{{ dateTime(item.createdAt) }}</span>
          <a :href="item.pageUrl" target="_blank" rel="noopener" class="text-(--ui-text-muted) hover:text-(--ui-text-highlighted)">
            {{ item.pageUrl }}
          </a>

          <UButton
            class="ml-auto"
            size="xs"
            color="error"
            variant="subtle"
            icon="i-lucide-trash-2"
            :aria-label="`Remove feedback from ${item.user.displayName}`"
            @click="remove(item)"
          >
            Remove
          </UButton>
        </div>

        <p class="mt-2 text-sm whitespace-pre-wrap">{{ item.message }}</p>

        <p class="mt-1 text-xs text-(--ui-text-dimmed)">
          {{ item.viewportWidth }}×{{ item.viewportHeight }} · {{ item.userAgent }}
        </p>

        <button
          v-if="item.hasScreenshot"
          type="button"
          class="mt-2 block"
          @click="viewing = item"
        >
          <img
            :src="`/api/admin/feedback/${item.id}/screenshot`"
            alt="Submitted screenshot"
            class="h-24 rounded border border-(--ui-border) object-cover"
          >
        </button>
      </article>
    </div>

    <p v-else class="py-20 text-center text-(--ui-text-muted)">
      Nobody has submitted feedback yet.
    </p>

    <UModal :open="viewing !== null" title="Screenshot" @update:open="viewing = null">
      <template #body>
        <img
          v-if="viewing"
          :src="`/api/admin/feedback/${viewing.id}/screenshot`"
          alt="Submitted screenshot"
          class="w-full rounded"
        >
      </template>
    </UModal>
  </div>
</template>
```

- [ ] **Step 3: Manual verification**

With both dev servers running and signed in as an admin: visit `/admin`, click "Feedback" in the sidebar, confirm the page loads (empty state if nothing has been submitted yet). Submit one from the floating button on another page, refresh `/admin/feedback`, confirm it appears with its screenshot thumbnail, that clicking the thumbnail opens the lightbox, and that Remove deletes it.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/pages/admin/feedback.vue apps/web/app/layouts/admin.vue
git commit -m "Add the admin feedback page"
```

---

## Task 11: Web — end-to-end test

**Files:**
- Create: `apps/web/e2e/feedback.spec.ts`

**Interfaces:**
- Consumes: `visit`, `expectsRequest`, `toast` (`./fixtures`), the running dev servers.

Per the `requests.spec.ts` convention this mirrors: submission is text-only in the test (no screenshot), to keep it independent of `html2canvas`'s timing and DOM quirks under Playwright — the drawing tools themselves are exercised manually in Task 9's verification step, not pixel-tested here.

- [ ] **Step 1: Write the test**

```ts
// apps/web/e2e/feedback.spec.ts
import { expect, expectsRequest, test, toast, visit } from './fixtures'

/**
 * The floating feedback button and its dialog.
 *
 * Submission is asserted through `expectsRequest` — a button that renders
 * perfectly and never calls the API looks identical from the outside. Text
 * only: html2canvas's own behaviour is exercised by hand, not here.
 */
test.describe('feedback', () => {
  test('is available on an ordinary page and absent on login', async ({ page }) => {
    await visit(page, '/')
    await expect(page.getByRole('button', { name: 'Send feedback' })).toBeVisible()

    await page.context().clearCookies()
    await page.goto('/login')
    await expect(page.getByRole('button', { name: 'Send feedback' })).not.toBeVisible()
  })

  test('submitting sends a message and closes the dialog', async ({ page }) => {
    await visit(page, '/')
    await page.getByRole('button', { name: 'Send feedback' }).click()

    await page.getByLabel('Feedback message').fill('The button overlaps the footer on this page.')

    await expectsRequest(page, /\/api\/feedback$/, 'POST', async () => {
      await page.getByRole('button', { name: 'Send' }).click()
    })

    await expect(toast(page, /feedback sent/i)).toBeVisible()
    await expect(page.getByRole('dialog')).not.toBeVisible()
  })

  test('clicking outside the dialog dismisses it', async ({ page }) => {
    await visit(page, '/')
    await page.getByRole('button', { name: 'Send feedback' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    // Click somewhere the overlay covers but the dialog content does not.
    await page.mouse.click(5, 5)

    await expect(page.getByRole('dialog')).not.toBeVisible()
  })

  test('is reachable from the admin sidebar', async ({ page }) => {
    await visit(page, '/admin')

    await page.getByRole('link', { name: 'Feedback' }).first().click()
    await page.waitForURL('**/admin/feedback')

    await expect(page.getByRole('heading', { name: 'Feedback', level: 1 })).toBeVisible()
  })
})
```

- [ ] **Step 2: Run it**

Ensure both dev servers are running and Playwright's Chromium is installed (`npx playwright install --with-deps chromium` if not).

Run: `npm run test:e2e -w @video/web -- feedback.spec.ts`
Expected: all four tests PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/feedback.spec.ts
git commit -m "Add end-to-end tests for the feedback widget"
```

---

## Final check

Run the full suite once everything above is in place and passing individually:

Run: `npm run test:all` (from the repo root — API unit, e2e, and db tiers)
Run: `npm run test -w @video/web` (frontend unit)
Run: `npm run test:e2e -w @video/web` (full Playwright suite, not just `feedback.spec.ts`, to catch any regression the new global button introduces on other pages)

All three must be green before considering this feature done.

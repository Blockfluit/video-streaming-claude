# Feedback widget — design

## Summary

A floating button, visible on every page to any signed-in user, opens a dialog
where they can write a text message and optionally annotate a screenshot of
the current page (pen, shapes, text) to point at what's wrong. Submissions
are viewable by admins on a new `/admin/feedback` page. No status workflow —
a simple list with delete for cleanup.

## Data model

New Prisma model, `apps/api/prisma/schema.prisma`:

```prisma
model Feedback {
  id             String   @id @default(cuid())
  userId         String
  user           User     @relation(fields: [userId], references: [id])
  message        String
  pageUrl        String
  userAgent      String
  viewportWidth  Int
  viewportHeight Int
  hasScreenshot  Boolean  @default(false)
  createdAt      DateTime @default(now())

  @@index([createdAt])
}
```

Add `feedback Feedback[]` to `User`'s relations.

`hasScreenshot` is a boolean, not a stored key — the screenshot's storage key
is deterministic (`feedback/<id>.png`), the same way `artworkKey()` derives
poster/banner keys from a video id. Nothing needs updating after create; the
row and the file are both written once, in the same request.

## Shared schemas (`packages/shared/src/schemas/feedback.ts`)

```ts
export const MAX_FEEDBACK_MESSAGE_LENGTH = 2000;

export const createFeedbackSchema = z.object({
  message: nonEmptyText.max(MAX_FEEDBACK_MESSAGE_LENGTH),
  pageUrl: z.string().max(2048),
  userAgent: z.string().max(512),
  viewportWidth: z.number().int().positive(),
  viewportHeight: z.number().int().positive(),
  screenshot: z.string().optional(), // base64 data URL, "data:image/png;base64,..."
});
export type CreateFeedbackInput = z.infer<typeof createFeedbackSchema>;

export const listFeedbackSchema = pageQuerySchema;
```

`MAX_FEEDBACK_SCREENSHOT_BYTES` (a new constant, `5 * 1024 * 1024`, matching
`MAX_THUMBNAIL_BYTES`'s value) lives beside `MAX_THUMBNAIL_BYTES` in
`packages/shared/src/schemas/library.ts` — it isn't part of the zod schema
(size is checked on the decoded buffer, not the string), but it's a limit the
service and, if ever needed, the frontend both read.

Re-export everything from `packages/shared/src/index.ts` the way
`comments.js` is re-exported.

## API (`apps/api/src/feedback/`)

Module shape mirrors `comments/`: `feedback.module.ts`,
`feedback.controller.ts`, `feedback.service.ts`, `serialize.ts`.

**`feedbackScreenshotKey(id: string)`** (pure helper, `feedback/keys.ts`) →
`` `feedback/${id}.png` ``, alongside a unit test.

**Service**

- `create(user, input: CreateFeedbackInput)`:
  1. If `input.screenshot` is present, strip the `data:image/...;base64,`
     prefix and `Buffer.from(base64, 'base64')`. Reject (`BadRequestException`)
     if the decoded length exceeds `MAX_FEEDBACK_SCREENSHOT_BYTES`.
  2. `prisma.feedback.create({ data: { userId, message, pageUrl, userAgent,
     viewportWidth, viewportHeight, hasScreenshot: Boolean(input.screenshot) } })`.
  3. If there's a screenshot buffer, `storage.save('derived',
     feedbackScreenshotKey(row.id), buffer)`.
  4. Return the row.
- `listForAdmin(query: PageQuery)` — `$transaction([findMany, count])` ordered
  `createdAt desc, id desc`, joined with `user: { select: { id, displayName } }`,
  mapped through `toFeedbackView`, wrapped in `toPage`.
- `remove(id)` — `prisma.feedback.delete`, and if `hasScreenshot`,
  `storage.delete('derived', feedbackScreenshotKey(id))` (best-effort: log and
  continue if the file is already gone, don't fail the delete on it).
- `getScreenshotPath(id)` — looks up the row, throws `NotFoundException` if
  missing or `hasScreenshot` is false, else returns the resolved path for the
  controller to stream.

**Serializer** `toFeedbackView(row)` — explicit field list (`id`, `message`,
`pageUrl`, `userAgent`, `viewportWidth`, `viewportHeight`, `hasScreenshot`,
`createdAt`, `user: { id, displayName }`), built the same defensive way
`toCommentView` is, even though there's no tombstone case here — new columns
added later shouldn't ride along into the response for free.

**Controller**

- `POST /feedback` — no `@Roles`, any authenticated user (session guard
  alone). `@ThrottleAuthoring()`. Body validated with `createFeedbackSchema`.
  Returns `201` with the created row's view.
- `GET /admin/feedback` — `@Roles('ADMIN')`. Query validated with
  `listFeedbackSchema`. Returns `Page<FeedbackView>`.
- `GET /admin/feedback/:id/screenshot` — `@Roles('ADMIN')`. Streams the file
  the same way `ImagesService.send()` does (weak ETag from size+mtime,
  `Cache-Control: private, no-cache`, 304 on conditional match). A missing
  row or a row with no screenshot is a genuine 404 here — this route is never
  reached by a client that doesn't already know the row exists via the admin
  list, so the "artwork never 404s" rule (which exists to keep an ordinary
  "no picture yet" state off the console for every viewer-facing card) does
  not apply.
- `DELETE /admin/feedback/:id` — `@Roles('ADMIN')`. `204 No Content`.

## Frontend

**`FeedbackButton.vue`** — fixed `bottom-6 right-6`, circular, an icon
(`i-lucide-message-circle-warning`), `aria-label="Send feedback"`. Mounted
once in `app.vue`, gated on `useSession().isSignedIn`, as a sibling of
`<NuxtLayout>` inside `<UApp>` — so it appears above both `default` and
`admin` layouts and never on the signed-out `auth` layout (login/setup),
without a route-meta check. Marked `data-feedback-ui` (and so is the dialog
below), which is what the capture step excludes from the screenshot.

Click handler:
1. `const dataUrl = await captureScreenshot()` — wraps `html2canvas` in a
   `try/catch`; on failure, `dataUrl` is `null` rather than throwing.
2. Open `FeedbackDialog` with `dataUrl` as a prop (`null` means text-only).

`captureScreenshot()` lives in `app/utils/feedback-capture.ts`:
```ts
export async function captureScreenshot(): Promise<string | null> {
  try {
    const canvas = await html2canvas(document.body, {
      ignoreElements: (el) => el.closest('[data-feedback-ui]') !== null,
    })
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}
```
Documented limitation: `html2canvas` cannot capture cross-origin iframes
(the hero trailer) or reliably capture `<video>`/live `<canvas>` content —
those render blank or frozen in the captured image. Not worked around; the
text message still describes what's wrong.

**`FeedbackDialog.vue`** (`UModal`, `data-feedback-ui`) — dismissible by
clicking outside it, like every other `UModal` in this app (none override
`dismissible`/`preventClose`, so this one shouldn't either): closing this
way discards the draft, the same as Cancel. If `screenshot` prop
is non-null, renders `FeedbackAnnotator` with it; otherwise shows a note that
no screenshot was captured. Below that, a message `UTextarea` (required,
capped client-side at `MAX_FEEDBACK_MESSAGE_LENGTH`), Cancel/Submit buttons.
Submit:
1. If the annotator is present, `const finalImage = annotator.value.export()`
   (Konva stage `toDataURL()`, image + annotations flattened).
2. `POST /feedback` via `useApi()` with `{ message, pageUrl: route.fullPath,
   userAgent: navigator.userAgent, viewportWidth: window.innerWidth,
   viewportHeight: window.innerHeight, screenshot: finalImage ?? undefined }`.
3. Toast on success/failure (`apiMessage`), close dialog on success.

**`FeedbackAnnotator.vue`** — `vue-konva`'s `<v-stage>`/`<v-layer>`, sized to
the screenshot's natural dimensions (capped to fit the modal, scaled down
with a `scale` ratio applied to the stage so exported coordinates still match
the original image). A `<v-image>` base layer holds the screenshot. Toolbar:
pen / rectangle / arrow / text, each a small icon-button row above the
canvas.

- **Pen**: on `pointerdown` start a new point array bound to a `v-line`
  (`stroke`, `strokeWidth`, `lineCap: round`, `lineJoin: round`); on
  `pointermove` push points; on `pointerup` commit it to a `shapes` array and
  push an undo entry.
- **Rectangle / arrow**: on `pointerdown` record the start point and push a
  live-updating `v-rect`/`v-arrow` bound to current pointer position; on
  `pointerup` commit.
- **Text**: on stage click in text mode, place an absolutely-positioned
  `<input>` at that screen position; on blur/Enter, if non-empty, commit a
  `v-text` at that stage position with the typed content and remove the
  input.
- **Undo**: a stack of committed shape ids; a plain "Undo" button pops the
  last one out of the `shapes` array powering the layer.

`export()` calls `stage.getStage().toDataURL({ pixelRatio: 1 / scale })` so
the exported PNG is the screenshot's original resolution regardless of how
much the editor scaled it down to fit the modal.

**Admin page** `apps/web/app/pages/admin/feedback.vue` — same shape as
`comments.vue`/`requests.vue`: `useApiData<Page<FeedbackView>>('admin-feedback',
() => \`/admin/feedback?${query.value}\`, { watch: [query] })` with a paged
`limit`/`offset` query built the way those pages already build one. Each
entry renders as a card: submitter `displayName`, relative timestamp, the
page URL as a link (opens in a new tab), the message, and — if
`hasScreenshot` — a thumbnail (`<img :src="\`/admin/feedback/${id}/screenshot\`" />`
via the `/api` proxy) that opens full-size in a lightbox `UModal` on click. A
delete button per card, confirmed with a native `confirm()` given this is a
destructive, admin-only, low-frequency action with no soft-delete to fall
back on — calls `DELETE /admin/feedback/:id` then `refresh()`.

New entry in `apps/web/app/layouts/admin.vue`'s `sections` array: `{ label:
'Feedback', to: '/admin/feedback', icon: 'i-lucide-message-circle-warning' }`.

## Dependencies

Two additions to `apps/web/package.json`: `html2canvas` (screenshot capture)
and `konva` + `vue-konva` (annotation editor). No API-side dependency
additions — `storage.save`/`storage.delete` already exist.

## Error handling

- Oversized screenshot payload → `400` from the service's explicit length
  check, before any Prisma write.
- `html2canvas` throwing (cross-origin content, unsupported CSS) → caught,
  degrades to text-only submission, never blocks the dialog from opening.
- `POST /feedback` failing → toast via `apiMessage`, dialog stays open so the
  message isn't lost.
- Deleting a row whose screenshot file is already gone → logged, not thrown;
  the row still deletes.

## Testing

- `apps/api/src/feedback/keys.spec.ts` — `feedbackScreenshotKey` pure unit
  test.
- `apps/api/src/feedback/feedback.service.spec.ts` — base64 decode, the size
  cap rejecting an oversized buffer, `toFeedbackView`'s explicit field set.
- `apps/api/test/feedback.e2e-spec.ts` — `POST /feedback` 401 signed-out, 201
  for `USER` and `ADMIN`; `GET /admin/feedback` and the screenshot/delete
  routes 403 for `USER`, 200/204 for `ADMIN`.
- `apps/api/test/feedback.db-spec.ts` — create with a screenshot → row has
  `hasScreenshot: true` → `GET .../screenshot` streams the exact bytes sent →
  `DELETE` removes both the row and the file (assert the file no longer
  exists on disk).
- `apps/web/e2e/feedback.spec.ts` — clicking the button opens the dialog;
  submitting (text-only, to keep the test independent of `html2canvas`
  timing) fires the expected `POST /feedback` request
  (`expectsRequest` convention). Not a pixel test of the Konva drawing itself.
- Button/dialog are absent when signed out (assert on the login page) and
  present on an ordinary signed-in page.

## Out of scope

- Any status/moderation workflow on feedback rows (explicitly declined).
- Editing a submitted message after the fact.
- Rate-limiting beyond the existing `@ThrottleAuthoring()` bucket.
- Capturing `<video>` frames or cross-origin iframe content in the
  screenshot.

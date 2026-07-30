# Video Streaming App — Nuxt + NestJS

## Context

`c:\Users\nwbva\Git\video-streaming-claude` is empty. This is a greenfield build of a **private, invite-only Netflix-style video library** with two ways in: browser uploads, and a **PIM-style ingest pipeline** where files dropped into the media folder are auto-discovered from their folder structure, staged as drafts, enriched by an admin, and published.

Decisions settled during planning:

| Area | Decision |
|---|---|
| Layout | npm workspaces monorepo — `apps/web`, `apps/api`, `packages/shared` |
| Frontend | **Nuxt 4.5** + Vue 3.5 + `@nuxt/ui` 4 (Tailwind 4) |
| Backend | NestJS 11.1 on Express |
| Database | PostgreSQL 17 (Docker) + Prisma 7.9 |
| Runtime | **Node 24 LTS** — user is upgrading from 22.14 (Nuxt 4.5 needs `^22.19 \|\| ^24.11 \|\| >=26`) |
| Storage | Local disk, served over HTTP Range (206) requests |
| Auth | Server-side sessions (`express-session` + `connect-pg-simple`); **login required for everything** |
| Accounts | Invite-only. First run mints a single-use master token → first admin |
| Roles | `ADMIN` = full CRUD + curation + moderation. `USER` = view + comment |
| Structure | Collection → optional Season → Video. Every video belongs to a collection |
| Curation | `CuratedList` rows whose items are **either** a collection or a video |
| Ingest | chokidar watcher + startup reconcile + manual "Scan now" |
| Workflow | `DRAFT → PUBLISHED`, plus `ARCHIVED` and auto-set `MISSING` |
| Thumbnails | Auto-generated at 10% of duration; manual upload overrides and is never clobbered |
| Credits | Shared `Person` table; credits attach to **collections and videos**, merged on display |
| Subtitles | Sidecar files discovered on ingest; embedded MKV tracks extracted; non-VTT converted |
| Transcoding | Browser-triggered MKV→MP4 (H.264/AAC, faststart), manual with auto-flagging |
| Quality badge | Shown only at 1080p and above — `HD` / `QHD` / `4K` / `8K` |
| Chapters | Per-video intro/outro markers driving Skip Intro / Skip Outro buttons |
| Comments | Flat, optionally pinned to a playback timestamp, own-edit + admin moderation |
| My List | One save-for-later list per user, holding videos **and** collections |
| URLs | Slug-based and nested: `/c/south-park/season-1/cartman-gets-an-anal-probe` |
| Tracking | Heartbeats → resume playback + per-video stats |

**Why sessions and not JWT.** Beyond revocability, there's a hard blocker: a `<video>` element cannot attach an `Authorization` header to its own byte-range requests, and neither can a `<track>` element. Both *do* send cookies. A cookie session is the only mechanism that authenticates streaming and subtitles without resorting to signed URLs.

**Why the browser only talks to port 3000.** Nuxt `routeRules` proxies `/api/**` → `http://localhost:4000/**`. Everything is same-origin: no CORS, no `SameSite=None`, and no `crossorigin` attribute — which also matters because a cross-origin `<track>` silently fails to load. *Fallback if proxied streaming buffers badly under load:* point `<video src>` at `:4000` with CORS `credentials: true` and `crossorigin="use-credentials"`.

**Why uploads write into the media tree.** Both entry paths converge on one representation: an upload picks a collection/season, the file lands at `media/<Collection>/<Season>/<file>`, and reconcile is idempotent by `storageKey` so the watcher confirms rather than duplicates.

**Why generated assets live outside `MEDIA_ROOT`.** Thumbnails, converted `.vtt` files, posters, and person photos are written to a separate `DERIVED_ROOT`. If they landed inside the watched tree, the watcher would fire on the app's own output — a feedback loop that is genuinely hard to debug after the fact.

This is a large build. The phases below are ordered so each ends at a checkpoint you can actually exercise.

---

## Repository layout

```
video-streaming-claude/
├── docker-compose.yml            # postgres:17
├── package.json                  # workspaces + root scripts
├── .gitignore                    # .bootstrap-token, media/, derived/, .env
├── media/                        # MEDIA_ROOT   — the watched library tree
├── derived/                      # DERIVED_ROOT — thumbs, posters, converted subs
├── packages/shared/              # DTO + response types imported by both apps
└── apps/
    ├── api/
    │   ├── prisma/schema.prisma
    │   └── src/
    │       ├── prisma/           # PrismaService (global)
    │       ├── auth/             # sessions, login, redeem, guards, bootstrap
    │       ├── users/  invites/  # admin account + token management
    │       ├── collections/      # collections, seasons, slug resolution
    │       ├── videos/           # CRUD + upload + Range streaming + markers
    │       ├── subtitles/        # discovery, conversion, serving
    │       ├── people/           # persons + credits
    │       ├── comments/         # posting, editing, moderation
    │       ├── lists/            # curated rows
    │       ├── watchlist/        # per-user My List
    │       ├── ingest/           # scanner, watcher, path parsing, reconcile
    │       ├── media/            # ffprobe/ffmpeg probe + thumbnail queue
    │       ├── transcode/        # MKV→MP4 jobs, subtitle extraction, progress
    │       ├── watch/            # heartbeats, progress, stats
    │       └── storage/          # StorageService (media + derived roots)
    └── web/                      # Nuxt 4 (srcDir = app/)
```

`packages/shared` exports **types only**. NestJS `class-validator` DTOs stay the validation source of truth.

---

## Media folder convention

Every video lives inside a folder — nothing at the root. Exactly two shapes:

```
media/
  Harry Potter/                                  <- collection with direct videos
    01 - Philosopher's Stone.mp4
    01 - Philosopher's Stone_en_English.vtt      <- subtitle sidecars
    Philosopher's Stone_nl_Nederlands.srt        <- title-form also matches
    02 - Chamber of Secrets.mp4
  Inception/                                     <- a single film is a collection of one
    Inception.mp4
  South Park/                                    <- collection with seasons
    Season 01/
      01 - Cartman Gets an Anal Probe.mp4
      01 - Cartman Gets an Anal Probe_en_English (SDH).vtt
    Season 02/
      01 - Terrance and Phillip.mp4
```

Parsing lives in `apps/api/src/ingest/path-parser.ts` as **pure functions with unit tests** — the highest-risk logic in the app and the cheapest to test in isolation.

| Depth | Meaning |
|---|---|
| `media/<X>/` | Collection, `folderKey = "X"` |
| `media/<X>/file.mp4` | Video directly in collection, `seasonId = null` |
| `media/<X>/<Y>/` | Season of collection X |
| `media/<X>/<Y>/file.mp4` | Video in season Y |
| `media/file.mp4` | **Flagged as an issue**, not ingested |
| depth > 3 | Flagged as an issue |

- **Season number:** `/^(?:season|series|s)[\s._-]*(\d{1,3})$/i` → `number`. No match → `number = null`, title = folder name, flagged for admin correction.
- **Order + title:** `/^(\d{1,3})\s*[-._)]\s*(.+)$/` on the basename → `orderIndex` + `title`.
- **Title cleanup:** underscores/dots → spaces, collapse whitespace, strip release tags (`1080p`, `x264`, `WEB-DL`, `BluRay`, …).
- Ignored: dotfiles, `.part` / `.crdownload` / `.tmp`, unknown extensions.

### Subtitle sidecars

Pattern `<video_name>_<lang>_<label>.<ext>` via `/^(?<stem>.+)_(?<lang>[a-z]{2,3})_(?<label>.+)$/`, matched against sibling files.

Matching is **exact-stem first, cleaned-title second**: for `01 - Philosopher's Stone.mp4`, both `01 - Philosopher's Stone_en_English.vtt` and `Philosopher's Stone_en_English.vtt` bind to it. Ambiguity (two videos in a folder cleaning to the same title) resolves to the exact match and is otherwise flagged rather than guessed. Unmatched subtitle files land in Issues.

- `lang` is validated against ISO 639-1/639-2; unknown codes are accepted but flagged.
- `label` becomes the `<track label>` the viewer picks — `English`, `English (SDH)`, `Forced`.
- `.srt` / `.ass` are converted to WebVTT with the ffmpeg already required (`subrip`/`ass` decoders → `webvtt` encoder), written into `DERIVED_ROOT`. Browsers accept only WebVTT in `<track>`, so this is mandatory, not a nicety.
- *Optional extension:* `ffprobe` also reports subtitle streams embedded in `.mkv`/`.mp4`, which could be extracted the same way. Deferred.

---

## Data model — `apps/api/prisma/schema.prisma`

```prisma
enum Role            { ADMIN USER }
enum TokenKind       { BOOTSTRAP INVITE }
enum PublishState    { DRAFT PUBLISHED ARCHIVED MISSING }
enum MediaOrigin     { UPLOAD INGEST EXTRACTED }
enum ThumbnailSource { AUTO MANUAL }
enum CreditRole      { ACTOR DIRECTOR WRITER PRODUCER COMPOSER CINEMATOGRAPHER EDITOR OTHER }
enum JobType         { PROBE THUMBNAIL TRANSCODE SUBTITLE_EXTRACT }
enum JobStatus       { QUEUED RUNNING SUCCEEDED FAILED CANCELLED }
```

### Accounts

```prisma
model User {
  id           String   @id @default(cuid())
  username     String   @unique               // login identity, stored lowercase
  passwordHash String                          // argon2id
  displayName  String                          // seeded from the username as typed
  role         Role     @default(USER)
  isActive     Boolean  @default(true)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  uploads    Video[]
  progress   WatchProgress[]
  events     WatchEvent[]
  comments   Comment[]
  watchlist  WatchlistItem[]
  jobs       MediaJob[]
  mintedBy   InviteToken[] @relation("Minter")
  redeemedBy InviteToken[] @relation("Redeemer")
}

model InviteToken {
  id           String    @id @default(cuid())
  tokenHash    String    @unique                // sha256(plaintext); shown once
  kind         TokenKind @default(INVITE)
  grantsRole   Role      @default(USER)
  expiresAt    DateTime
  redeemedAt   DateTime?
  revokedAt    DateTime?
  createdById  String?
  createdBy    User?     @relation("Minter",   fields: [createdById],  references: [id])
  redeemedById String?   @unique
  redeemedUser User?     @relation("Redeemer", fields: [redeemedById], references: [id])
  createdAt    DateTime  @default(now())
}

// Owned by migrations so connect-pg-simple's manual table.sql isn't needed
model Session {
  sid    String   @id
  sess   Json
  expire DateTime
  @@index([expire])
  @@map("session")
}
```

Accounts are keyed on **username**, not email. The library is invite-only and has nothing to send mail
about, so an email column would be 100% NULL until a mailer exists — at which point it can be added as a
nullable, optional field without touching the login path. Usernames are stored lowercase, which makes
uniqueness and lookups case-insensitive without needing `citext` or a functional index; `displayName` is
seeded from the username as typed at redemption, so changing how your name renders never changes how you
log in. Redeeming a token therefore asks for **username + password only**.

### Library

```prisma
model Collection {
  id          String       @id @default(cuid())
  slug        String       @unique
  title       String
  description String?
  year        Int?
  tags        String[]     @default([])
  posterKey   String?
  folderKey   String       @unique             // relative folder path
  state       PublishState @default(DRAFT)
  origin      MediaOrigin  @default(INGEST)
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt

  seasons       Season[]
  videos        Video[]
  credits       Credit[]
  listItems     ListItem[]
  watchlistedBy WatchlistItem[]

  @@index([state])
}

model Season {
  id           String     @id @default(cuid())
  collectionId String
  collection   Collection @relation(fields: [collectionId], references: [id], onDelete: Cascade)
  number       Int?                             // null when folder name didn't parse
  slug         String                           // "season-1", or slugified folder name
  title        String
  description  String?
  posterKey    String?
  folderKey    String     @unique
  videos       Video[]

  @@unique([collectionId, number])              // Postgres permits repeated NULLs
  @@unique([collectionId, slug])
  @@index([collectionId])
}

model Video {
  id           String       @id @default(cuid())
  slug         String                           // unique within its collection
  collectionId String
  collection   Collection   @relation(fields: [collectionId], references: [id], onDelete: Cascade)
  seasonId     String?
  season       Season?      @relation(fields: [seasonId], references: [id], onDelete: SetNull)
  orderIndex   Int?
  title        String
  description  String?
  tags         String[]     @default([])
  state        PublishState @default(DRAFT)
  origin       MediaOrigin  @default(INGEST)

  storageKey   String    @unique                // SOURCE file, relative to MEDIA_ROOT
  contentTag   String                           // partial hash, for move detection
  originalName String
  mimeType     String
  sizeBytes    BigInt
  fileMtime    DateTime
  durationSec  Float?
  width        Int?
  height       Int?
  videoCodec   String?
  audioCodec   String?
  audioTracks  Int?                             // surfaced so multi-audio loss is visible
  probedAt     DateTime?
  probeError   String?
  missingSince DateTime?

  playbackKey     String?                       // converted MP4 in DERIVED_ROOT
  playbackMime    String?
  needsConversion Boolean   @default(false)
  sourceDeletedAt DateTime?                     // source reclaimed after conversion

  thumbnailKey    String?
  thumbnailSource ThumbnailSource @default(AUTO)

  introStartSec Float?                          // all four independently optional
  introEndSec   Float?
  outroStartSec Float?
  outroEndSec   Float?

  uploadedById String?
  uploadedBy   User?    @relation(fields: [uploadedById], references: [id])
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  subtitles     Subtitle[]
  jobs          MediaJob[]
  credits       Credit[]
  comments      Comment[]
  progress      WatchProgress[]
  events        WatchEvent[]
  listItems     ListItem[]
  watchlistedBy WatchlistItem[]

  @@unique([collectionId, slug])
  @@index([collectionId, seasonId, orderIndex])
  @@index([state])
  @@index([contentTag])
}
```

`thumbnailSource` exists for one reason: **a reprobe or re-ingest must never overwrite a manually uploaded thumbnail.** Auto-generation only runs when the value is `AUTO`.

`storageKey` and `playbackKey` are deliberately separate. `storageKey` is the archival source in `media/` (your `.mkv`); `playbackKey` is the converted MP4 in `derived/`. The stream endpoint serves `playbackKey ?? storageKey`, so the same URL keeps working before and after conversion, and re-converting with different settings never touches the original.

### Jobs

```prisma
model MediaJob {
  id          String    @id @default(cuid())
  videoId     String
  video       Video     @relation(fields: [videoId], references: [id], onDelete: Cascade)
  type        JobType
  status      JobStatus @default(QUEUED)
  progress    Float     @default(0)             // 0..1, parsed from ffmpeg -progress
  etaSeconds  Int?
  message     String?
  error       String?
  outputKey   String?
  createdById String?
  createdBy   User?     @relation(fields: [createdById], references: [id])
  startedAt   DateTime?
  finishedAt  DateTime?
  createdAt   DateTime  @default(now())

  @@index([status, createdAt])
  @@index([videoId])
}
```

On API startup, any job still marked `RUNNING` is a crash orphan — mark it `FAILED` and delete its temp output, or nothing will ever clean it up.

### Subtitles

```prisma
model Subtitle {
  id         String      @id @default(cuid())
  videoId    String
  video      Video       @relation(fields: [videoId], references: [id], onDelete: Cascade)
  language   String                              // lowercase ISO code, "en"
  label      String                              // "English (SDH)"
  storageKey String      @unique                 // the .vtt actually served
  sourceKey  String?                             // original .srt/.ass, if converted
  sourceFormat String                            // vtt | srt | ass
  isDefault  Boolean     @default(false)
  origin     MediaOrigin @default(INGEST)
  createdAt  DateTime    @default(now())

  @@unique([videoId, language, label])
  @@index([videoId])
}
```

### People and credits

```prisma
model Person {
  id        String   @id @default(cuid())
  slug      String   @unique
  name      String   @unique
  bio       String?
  photoKey  String?
  credits   Credit[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Credit {
  id            String      @id @default(cuid())
  personId      String
  person        Person      @relation(fields: [personId], references: [id], onDelete: Cascade)
  role          CreditRole
  characterName String?                          // for ACTOR
  position      Int         @default(0)          // billing order
  collectionId  String?
  collection    Collection? @relation(fields: [collectionId], references: [id], onDelete: Cascade)
  videoId       String?
  video         Video?      @relation(fields: [videoId], references: [id], onDelete: Cascade)

  @@index([collectionId])
  @@index([videoId])
  @@index([personId])
}
```

A video's credits panel shows its own credits **merged with its collection's**, so a series' main cast is entered once and an episode only carries its guest stars. Duplicate prevention (same person + role + parent) is enforced in the service — Postgres treats NULLs as distinct, so a composite unique index would not actually catch it.

### Comments

```prisma
model Comment {
  id           String    @id @default(cuid())
  videoId      String
  video        Video     @relation(fields: [videoId], references: [id], onDelete: Cascade)
  userId       String
  user         User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  body         String
  timestampSec Float?                            // optional pin to a playback position
  editedAt     DateTime?
  deletedAt    DateTime?                         // soft delete
  deletedById  String?
  createdAt    DateTime  @default(now())

  @@index([videoId, createdAt])
  @@index([userId])
}
```

Soft delete keeps thread context and an audit trail; deleted rows serialize with a tombstone body and no author.

### My List

```prisma
model WatchlistItem {
  id           String      @id @default(cuid())
  userId       String
  user         User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  collectionId String?
  collection   Collection? @relation(fields: [collectionId], references: [id], onDelete: Cascade)
  videoId      String?
  video        Video?      @relation(fields: [videoId], references: [id], onDelete: Cascade)
  createdAt    DateTime    @default(now())

  @@unique([userId, collectionId])
  @@unique([userId, videoId])
  @@index([userId, createdAt])
}
```

Same polymorphic shape as `ListItem`, so it needs the same CHECK constraint. The two partial uniques make "add" idempotent — a double-click cannot create a duplicate entry.

The two lists are deliberately different things and both are shown on the home page: **Continue Watching** is derived automatically from `WatchProgress` (implicit, in-progress), while **My List** is explicit and user-curated. A saved *collection* renders with its next unwatched episode, resolved from `WatchProgress` against `orderIndex`.

### Curated rows

```prisma
model CuratedList {
  id          String     @id @default(cuid())
  slug        String     @unique
  title       String
  description String?
  position    Int        @default(0)             // row order on the home page
  isVisible   Boolean    @default(true)
  items       ListItem[]
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt
}

model ListItem {
  id           String      @id @default(cuid())
  listId       String
  list         CuratedList @relation(fields: [listId], references: [id], onDelete: Cascade)
  position     Int
  collectionId String?
  collection   Collection? @relation(fields: [collectionId], references: [id], onDelete: Cascade)
  videoId      String?
  video        Video?      @relation(fields: [videoId], references: [id], onDelete: Cascade)

  @@unique([listId, collectionId])
  @@unique([listId, videoId])
  @@index([listId, position])
}
```

`position` is deliberately **not** unique — a unique index makes drag-reordering collide mid-swap. The application rewrites the whole row's positions in one transaction.

### Watch tracking

```prisma
// One rollup row per (user, video) — powers resume + continue-watching
model WatchProgress {
  id              String   @id @default(cuid())
  userId          String
  videoId         String
  user            User     @relation(fields: [userId],  references: [id], onDelete: Cascade)
  video           Video    @relation(fields: [videoId], references: [id], onDelete: Cascade)
  lastPositionSec Float    @default(0)
  maxPositionSec  Float    @default(0)
  secondsWatched  Float    @default(0)
  viewCount       Int      @default(0)
  completed       Boolean  @default(false)
  firstWatchedAt  DateTime @default(now())
  lastWatchedAt   DateTime @updatedAt

  @@unique([userId, videoId])
  @@index([videoId])
  @@index([userId, lastWatchedAt])
}

model WatchEvent {
  id            String   @id @default(cuid())
  userId        String
  videoId       String
  user          User     @relation(fields: [userId],  references: [id], onDelete: Cascade)
  video         Video    @relation(fields: [videoId], references: [id], onDelete: Cascade)
  playSessionId String                            // uuid per page-load
  positionSec   Float
  deltaSec      Float
  createdAt     DateTime @default(now())

  @@index([videoId, createdAt])
  @@index([playSessionId])
}
```

Two notes that will otherwise cost an afternoon each:
- `BigInt` (`sizeBytes`) does not survive `JSON.stringify` — register a global serializer in `main.ts` or map it to `string` in the response DTO.
- Prisma cannot express CHECK constraints. Hand-edit the generated migration for all three polymorphic tables:

```sql
ALTER TABLE "ListItem"      ADD CONSTRAINT list_item_exactly_one
  CHECK (("collectionId" IS NULL) <> ("videoId" IS NULL));
ALTER TABLE "Credit"        ADD CONSTRAINT credit_exactly_one
  CHECK (("collectionId" IS NULL) <> ("videoId" IS NULL));
ALTER TABLE "WatchlistItem" ADD CONSTRAINT watchlist_item_exactly_one
  CHECK (("collectionId" IS NULL) <> ("videoId" IS NULL));
```

---

## URLs and slug resolution

```
/browse
/c/harry-potter
/c/harry-potter/philosophers-stone
/c/south-park
/c/south-park/season-1
/c/south-park/season-1/cartman-gets-an-anal-probe
/people/alan-rickman
```

Slugs are generated with `slugify` from the title on create, deduplicated within their scope (`-2`, `-3`). They're **stable once published**: renaming a title does not silently break shared links; the admin UI offers an explicit "regenerate slug" action.

`/c/<collection>/<a>` is ambiguous — `<a>` could be a season or a video. Rather than guessing in the router, the web app uses a catch-all `app/pages/c/[collection]/[...path].vue` backed by one endpoint, `GET /collections/:slug/resolve?path=…`, which returns a discriminated `{ type: 'collection' | 'season' | 'video', data }`. Season slugs are checked before video slugs. One round trip, no ambiguity, and the rule lives in the API where it can be tested.

---

## Bootstrap flow (the master token)

`apps/api/src/auth/bootstrap.service.ts`, on `OnApplicationBootstrap`:

1. Count users with `role = ADMIN`. If ≥ 1, do nothing and delete any stale `.bootstrap-token`.
2. Otherwise reuse an existing unredeemed, unexpired `BOOTSTRAP` token if one exists.
3. Otherwise mint one: `crypto.randomBytes(32).toString('base64url')`. Persist **only** `sha256(plaintext)` with `kind=BOOTSTRAP`, `grantsRole=ADMIN`, `expiresAt = now + 24h`.
4. Print a boxed banner to the API console, and write the plaintext to `.bootstrap-token` at the repo root (gitignored, mode `600`).
5. On redemption: set `redeemedAt`/`redeemedById` in the same transaction that creates the user, then unlink the file.

Restarting while no admin exists reissues an expired token — you can never get permanently locked out.

`sha256` is correct for tokens rather than argon2: these are 256-bit random values, not guessable secrets, so a slow KDF buys nothing. Passwords use **argon2id**. Redemption runs as one `$transaction` with a conditional update (`WHERE redeemedAt IS NULL`) so two concurrent redemptions can't both win.

---

## Ingest pipeline

`apps/api/src/ingest/`

### Reconcile (startup, manual scan, and after watcher events)

1. Walk `MEDIA_ROOT` → `{ relPath, size, mtime }` for every video file.
2. **New on disk** (no row with that `storageKey`): compute `contentTag` = `sha256(first 1MB + last 1MB + size)` — cheap and stable, never reads a whole 4 GB file.
   - A row with the same `contentTag` whose own `storageKey` is gone from disk → **it moved**. Update `storageKey`, re-derive collection/season/order, keep the row id and all watch history, progress, and comments.
   - Otherwise → create as `DRAFT`, creating the parent collection/season if needed.
3. **Row whose file is gone**, unmatched as a move → `state = MISSING`, `missingSince = now`. **Never deleted** — history survives; a reappearing file restores its previous state. Videos whose source was deliberately reclaimed after conversion (`sourceDeletedAt` set, `playbackKey` valid) are **exempt** from this sweep — otherwise reclaiming disk space would mark half the library missing.
4. Scan sibling subtitle files, bind them by the rules above, convert non-VTT into `DERIVED_ROOT`, and reconcile removals.
5. Structural problems (root-level files, depth > 3, unparseable season folders, orphan subtitles) are recorded as issues, not silently dropped.

Reconcile is idempotent and keyed on `storageKey`, which is exactly why uploads writing into the same tree cannot produce duplicates.

### Watcher

chokidar 5 on `MEDIA_ROOT` with:
- `awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 }` — **essential**, or a half-copied 4 GB file gets ingested mid-write.
- `ignoreInitial: true` — the startup reconcile owns the first pass.
- Events debounced into a serial queue so a folder drop of 20 files doesn't race.
- Gated behind `INGEST_WATCHER_ENABLED` so only one instance watches if the API is ever replicated.

### Probing — `apps/api/src/media/`

New or moved videos are queued (in-process, concurrency 2 — no Redis at this scale; BullMQ is the upgrade path):
- `ffprobe` → `durationSec`, `width`, `height`, `videoCodec`, `audioCodec`, `audioTracks`, sets `probedAt` and evaluates `needsConversion`
- `ffmpeg` → thumbnail JPEG at **10% of duration** → `thumbnailKey`, **only when `thumbnailSource = AUTO`**
- Failures write `probeError` and surface in Issues; values can be corrected by hand and retried via `POST /videos/:id/reprobe`

Binaries resolve from system `ffmpeg`/`ffprobe` (present: 7.1.1), falling back to `ffmpeg-static` / `ffprobe-static` so a fresh clone works anywhere.

### Publish gating

`POST /videos/:id/publish` requires `title`, `description`, `durationSec`, `thumbnailKey`. The API returns `missingFields[]` on rejection **and** on every draft read, so the admin UI renders a live checklist instead of guessing. A collection needs `title`, `description`, `posterKey`, and ≥1 publishable video; publishing a collection offers to cascade-publish its ready videos. Credits, subtitles, and markers are never required.

`USER` sees only `PUBLISHED` records. Enforced by a shared Prisma `where` helper in the service layer — never in the UI alone.

---

## Transcoding and subtitle extraction

`apps/api/src/transcode/`. The problem this solves: an `.mkv` with H.265 video or embedded subtitle tracks plays on almost nothing natively, and `<video>` will simply show a black box with no useful error.

### Detecting what needs converting

Probe results set `needsConversion` automatically, so nothing has to be hunted for by hand:

| Signal | Verdict |
|---|---|
| Container `.mkv`, `.avi`, `.wmv`, `.flv`, `.mpg`, `.ts`, `.m2ts`, `.vob` | Needs conversion |
| Video codec not in `h264`, `vp8`, `vp9`, `av1` | Needs conversion |
| Audio codec not in `aac`, `mp3`, `opus`, `vorbis` | Needs conversion |
| Pixel format 10-bit (`yuv420p10le`) or H.264 profile above High | Needs conversion — this is exactly what `-pix_fmt yuv420p` fixes |
| `.mp4`/`.webm` with compatible codecs | Playable as-is |

Flagged videos surface in the admin UI with a **Convert** button and appear in a "Needs conversion" filter on the drafts inbox. **Nothing transcodes until you click** — a 200-file drop must not silently peg the CPU for a day.

### The conversion job

```bash
ffmpeg -hide_banner -y -i <source> \
  -c:v libx264 -crf 25 -pix_fmt yuv420p \
  -c:a aac -ac 2 \
  -movflags +faststart \
  -progress pipe:1 -nostats \
  <DERIVED_ROOT>/tmp/<jobId>.mp4
```

Output is written to `tmp/` and **renamed into place only on success**, so a partial file can never be served or picked up as finished. On success: set `playbackKey`, `playbackMime = video/mp4`, clear `needsConversion`, and re-probe the output to record its real dimensions.

Three properties of these settings are worth being explicit about, because each one prevents a specific failure:
- `-movflags +faststart` moves the moov atom to the front of the file. Without it, progressive HTTP playback can't begin until the whole file downloads — it would defeat the Range streaming this app is built on. It also means ffmpeg does a **final rewrite pass after reaching 100%**, so the progress bar sits at 100% for a moment before finishing. That's expected, not a hang.
- `-pix_fmt yuv420p` forces 8-bit 4:2:0, the only profile with universal hardware decode support.
- `-ac 2` downmixes to stereo, avoiding 5.1 tracks that play silently or centre-channel-only on many devices.

Two caveats to surface in the UI rather than discover later:
- **Subtitle streams are dropped** from the MP4 — correct, since they're extracted to VTT sidecars instead and become switchable tracks.
- With no `-map`, ffmpeg's default stream selection keeps **one** video and **one** audio stream. A multi-language MKV loses its alternate audio tracks. `audioTracks` is recorded during probe so the UI can warn "3 audio tracks — only the default will be kept" before you start. Adding `-map 0:v:0 -map 0:a` would preserve them all; the plan keeps your exact command as the default and leaves this a per-job toggle.
- `-preset` is unset, so libx264 uses `medium`. Exposed as `TRANSCODE_PRESET` for when you want to trade CPU time for file size.

### Progress, concurrency, cancellation

- `-progress pipe:1` emits `out_time_us` continuously; percent = `out_time_us / (durationSec * 1e6)`. Duration is already known from probe.
- **Concurrency 1** by default (`TRANSCODE_CONCURRENCY`) — transcoding is CPU-saturating, and running several at once makes them all slower, not faster. The cheap probe/thumbnail queue stays separate at concurrency 2.
- Cancel kills the child process and deletes the temp output.
- The admin UI polls `GET /admin/jobs?status=RUNNING` every 2s for a live progress bar and ETA. (SSE would be tidier and is an easy later upgrade; polling is not worth the extra machinery at this scale.)

### Extracting embedded subtitles

`ffprobe -show_streams -select_streams s` lists every subtitle track. For each **text-based** stream (`subrip`, `ass`, `mov_text`, `webvtt`):

```bash
ffmpeg -i <source> -map 0:s:<i> -c:s webvtt <DERIVED_ROOT>/subs/<videoId>_<lang>_<label>.vtt
```

- Language comes from `tags.language` (ISO 639-2, `eng`) mapped down to 639-1 (`en`); label from `tags.title`, falling back to the language name, with `(Forced)` / `(SDH)` appended from stream disposition flags.
- Each extraction creates a `Subtitle` row with `origin = EXTRACTED`, appearing in the player alongside sidecar files.
- **Bitmap subtitles (`hdmv_pgs_subtitle`, `dvd_subtitle`) cannot be converted to WebVTT** — they're images, and turning them into text needs OCR. These are skipped and reported per-file as "2 image-based tracks skipped" rather than failing the job or silently vanishing. If they matter, the honest options are burning them in or running OCR, both out of scope here.

Extraction can run on its own (`SUBTITLE_EXTRACT`) or as part of a conversion, so subtitles can be pulled from an MKV without transcoding it.

### Reclaiming source files

`DELETE /videos/:id/source` removes the original `.mkv`, and is refused unless `playbackKey` exists **and** the output verifies: it probes cleanly and its duration is within 1s of the source's. The UI shows the exact bytes reclaimed before you confirm. Deletion sets `sourceDeletedAt`.

This creates one interaction that must be handled deliberately: reconcile would otherwise see the missing `.mkv` and flip the video to `MISSING`. **Videos with `sourceDeletedAt` set and a valid `playbackKey` are exempt from the missing-file sweep.** `storageKey` is retained for provenance but no longer expected on disk.

---

## Quality badge

Derived from probe data by a pure `qualityLabel(width, height)` helper in `packages/shared`, used identically by API responses and UI so the two can't drift. Nothing is stored — there's no column to fall out of sync after a re-probe.

| Condition | Badge |
|---|---|
| `width ≥ 7680` or `height ≥ 4320` | `8K` |
| `width ≥ 3840` or `height ≥ 2160` | `4K` |
| `width ≥ 2560` or `height ≥ 1440` | `QHD` |
| `width ≥ 1920` or `height ≥ 1080` | `HD` |
| anything below | **no badge** |

Each tier checks **width or height**, not height alone. A 1080p film in 2.39:1 is `1920×800` — testing only `height ≥ 1080` would wrongly hide the badge on most actual movies. Checking either dimension also handles portrait video correctly.

The badge renders on library cards and next to the title on the video page, and is simply absent below 1080p — never shown as "SD" or "480p", per your requirement that only HD and above is called out. After conversion the badge reflects the **converted** file, since the output is re-probed.

---

## Range streaming — the core of the app

`apps/api/src/videos/videos.controller.ts`. Do **not** use `StreamableFile` alone; it doesn't handle `Range`, and without a `206` the browser cannot seek.

```
1. Load video (403 if DRAFT/ARCHIVED and caller is USER; 410 if MISSING).
2. Pick the file: playbackKey ?? storageKey  — converted MP4 wins when present.
   Resolve via StorageService (derived root or media root), fs.stat for size.
3. Always set: Accept-Ranges: bytes, Content-Type (playbackMime ?? mimeType),
   Cache-Control: private, no-store
4. No Range header  → 200 + Content-Length: size + createReadStream(path).pipe(res)
5. Range header     → parse "bytes=start-end"
     - malformed / start >= size → 416 + Content-Range: bytes */<size>
     - end omitted → min(start + CHUNK - 1, size - 1)   // CHUNK ≈ 1 MB
     - 206 + Content-Range: bytes <start>-<end>/<size>
            + Content-Length: end - start + 1
            + createReadStream(path, { start, end }).pipe(res)
6. res.on('close') → destroy the stream (seeking aborts requests constantly).
```

`StorageService` exposes `save`, `resolvePath`, `delete`, `exists` against **two** roots (`MEDIA_ROOT`, `DERIVED_ROOT`). Every key is `path.resolve`d and confirmed inside its root before use, so a crafted `storageKey` cannot traverse out. S3 slots in behind the same interface later.

Uploads use `FileInterceptor` with multer `diskStorage` writing directly into the target collection/season folder (streams to disk, never buffers), a 2 GB limit, a mime whitelist, and a sanitized filename. The client's `originalName` is metadata only, never a path component.

---

## Player features

### Subtitles
Served as `GET /videos/:id/subtitles/:subtitleId.vtt` with `text/vtt`, rendered as `<track>` elements with `srclang`, `label`, and `default` on the flagged one. Same-origin via the proxy — a cross-origin `<track>` fails silently, which is a miserable bug to chase.

### Skip intro / skip outro
The player watches `currentTime` against the four markers:
- inside `[introStartSec, introEndSec]` → **Skip Intro** button, seeks to `introEndSec`
- inside `[outroStartSec, outroEndSec]` → **Skip Outro**, or **Next Episode** when a next video exists in the same season/collection

Markers are independently optional — a video may define an intro and no outro. The API validates `start < end <= durationSec`.

The admin editor sets them **by scrubbing, not by typing seconds**: play to the position, click "Set intro start". A mini timeline renders the two ranges over the duration bar. Typing exact values stays available for fine adjustment.

### Thumbnails
- Auto-generated at 10% during probe when `thumbnailSource = AUTO`.
- `POST /videos/:id/thumbnail` (multipart image) → stores in `DERIVED_ROOT`, sets `MANUAL`. Never overwritten by a reprobe.
- `POST /videos/:id/thumbnail/capture { atSec }` → server extracts that exact frame with ffmpeg. Lets an admin scrub to a good frame and grab it, without leaving the browser or making an image by hand.
- `DELETE /videos/:id/thumbnail` → reverts to `AUTO` and regenerates.

### Comments
Flat list under the player, newest first, paginated. Posting optionally pins the current playback time; rendered comments show `2:14` as a link that seeks there. Users edit and soft-delete their own (`editedAt` shown); admins moderate any. Posting is rate-limited by `@nestjs/throttler`.

---

## Watch tracking

Client (`app/components/VideoPlayer.vue`):
- One `playSessionId` (uuid) per page load.
- On `loadedmetadata`, if `lastPositionSec` is > 5s and < 95% of duration, show a dismissible "Resume from 3:41" affordance rather than jumping silently.
- Accumulate watched time from `timeupdate` deltas, **discarding jumps > 2s** so scrubbing doesn't inflate the total.
- Heartbeat every 10s while playing, plus on `pause` / `ended` / `visibilitychange`.
- Final flush on unload uses `navigator.sendBeacon` — a normal `fetch` is killed mid-flight during teardown.

Server (`apps/api/src/watch/watch.service.ts`), per heartbeat in one transaction:
- Insert a `WatchEvent`.
- `upsert` `WatchProgress`: `lastPositionSec = positionSec`, `maxPositionSec = max(existing, positionSec)`, `secondsWatched += deltaSec`, `completed = maxPositionSec >= 0.9 * durationSec`.
- Increment `viewCount` only on the first beat of a new `playSessionId`.
- Clamp `deltaSec` server-side (reject > 30) so a buggy or hostile client can't inflate totals.

Per-video stats via `aggregate`/`groupBy` over `WatchProgress`: unique viewers, total watch time, average completion %, plus the caller's own progress. Collection pages roll the same figures up.

---

## API surface

All routes require an authenticated session except `POST /auth/login` and `POST /auth/redeem`. Admin routes use `RolesGuard` + `@Roles('ADMIN')`.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/redeem` · `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` |
| Accounts | `POST/GET /admin/invites` · `DELETE /admin/invites/:id` · `POST/GET /admin/users` · `PATCH/DELETE /admin/users/:id` |
| Collections | `GET /collections` · `GET /collections/:slug` · `GET /collections/:slug/resolve?path=` · `POST/PATCH/DELETE /collections` · `POST /collections/:id/publish\|archive` |
| Seasons | `POST/PATCH/DELETE /seasons` |
| Videos | `GET /videos` (filters: `state`, `collectionId`, `q`, `tag`) · `GET /videos/:id` · `POST /videos/upload` · `PATCH/DELETE /videos/:id` · `POST /videos/:id/publish\|archive\|reprobe` · `PATCH /videos/:id/markers` |
| Thumbnails | `POST /videos/:id/thumbnail` · `POST /videos/:id/thumbnail/capture` · `DELETE /videos/:id/thumbnail` |
| Subtitles | `GET /videos/:id/subtitles` · `GET /videos/:id/subtitles/:sid.vtt` · `POST /videos/:id/subtitles` (manual upload) · `PATCH/DELETE /subtitles/:id` |
| Streaming | `GET /videos/:id/stream` (Range) · `GET /videos/:id/thumbnail` · `GET /collections/:id/poster` |
| Conversion | `POST /videos/:id/convert` · `POST /videos/:id/extract-subtitles` · `DELETE /videos/:id/source` |
| Jobs | `GET /admin/jobs` (filter `status`, `videoId`) · `GET /admin/jobs/:id` · `POST /admin/jobs/:id/cancel` · `POST /admin/jobs/:id/retry` |
| People | `GET /people` (+ autocomplete) · `GET /people/:slug` (filmography) · `POST/PATCH/DELETE /people` |
| Credits | `POST /collections/:id/credits` · `POST /videos/:id/credits` · `PATCH /credits/:id` · `PATCH /credits/reorder` · `DELETE /credits/:id` |
| Comments | `GET /videos/:id/comments` · `POST /videos/:id/comments` · `PATCH/DELETE /comments/:id` |
| Curation | `GET /lists` · `POST/PATCH/DELETE /lists` · `POST /lists/:id/items` · `PATCH /lists/:id/reorder` · `DELETE /lists/:id/items/:itemId` |
| Ingest | `POST /admin/ingest/scan` · `GET /admin/ingest/status` · `GET /admin/ingest/issues` |
| Watch | `POST /videos/:id/heartbeat` · `GET /me/history` |
| My List | `GET /me/watchlist` · `POST /me/watchlist` (`{ videoId \| collectionId }`, idempotent) · `DELETE /me/watchlist` (same body) |

Self-lockout guard: refuse to demote, deactivate or delete the last active admin. A deactivated admin does
not count as cover, and the remaining-admin count is read `FOR UPDATE` so two simultaneous demotions cannot
both believe someone else is left.

`PATCH /admin/users/:id` also sets a password. With no mailer there is no "forgot password" link, so an
admin doing it by hand is the only recovery an account has. `DELETE` is a real delete — cascades take the
account's comments, watch history and watchlist; `PATCH { isActive: false }` is the reversible option.

---

## Frontend — `apps/web` (Nuxt 4, `srcDir: app/`)

| Route | Purpose |
|---|---|
| `login` / `setup` | Sign in; redeem a bootstrap or invite token |
| `index` | Netflix-style home: Continue Watching + My List + curated rows |
| `browse` | All collections, search + tag filter |
| `my-list` | Saved videos and collections, newest first, with a remove action |
| `c/[collection]/[...path]` | Catch-all resolving to collection, season, or video (player) |
| `people/[slug]` | Person detail + filmography |
| `history` | Watch history with completion bars |
| `admin/index` | Dashboard: draft counts, issues, last scan |
| `admin/drafts` | **The PIM inbox** — staged entries with missing-field checklists, bulk publish |
| `admin/collections/[id]` | Enrich collection + seasons, reorder videos, poster, credits |
| `admin/videos/[id]` | Enrich video: metadata, markers editor, thumbnail manager, subtitles, credits, conversion panel |
| `admin/people` | Person directory and merge |
| `admin/lists` | Build curated rows, drag to reorder, mix collections and videos |
| `admin/upload` | Upload targeting a collection/season |
| `admin/ingest` | Scan status, watcher state, issues |
| `admin/jobs` | Conversion queue: live progress bars, ETA, cancel, retry, failure logs |
| `admin/users` | Accounts + invite tokens (minted token shown once, copy button) |
| `admin/comments` | Moderation queue |

- **Proxy:** `routeRules: { '/api/**': { proxy: 'http://localhost:4000/**' } }` — works in dev and production, so the browser only ever sees one origin.
- **The bug you will hit first:** during SSR, `useFetch`/`$fetch` run inside Nitro and do **not** forward the browser's cookie. Every server-side call must pass `headers: useRequestHeaders(['cookie'])`. Wrap this once in a `useApi()` composable so no page has to remember.
- `app/middleware/auth.global.ts` redirects unauthenticated users to `/login`; the API remains the real authority on every request.
- `@nuxt/ui` 4 supplies the modals, tables, and form controls the admin screens lean on heavily. State via `useState` composables — Pinia is unnecessary at this size.
- Upload uses `XMLHttpRequest`, not `fetch` — `fetch` still gives no upload progress events.
- Person autocomplete when adding a credit, so the `Person` table doesn't fill with near-duplicates.
- A single `<AddToListButton>` used on cards, collection pages, and the player. It toggles optimistically and reconciles against the server response, so the icon never lags behind the click.
- A `<QualityBadge>` fed by the shared `qualityLabel()` helper, rendering nothing below 1080p rather than an empty chip.
- The conversion panel warns before starting when the source has multiple audio tracks, and streams live progress from the jobs endpoint.

---

## Build order

1. **Prereq** — upgrade to Node 24 LTS, verify `node -v`.
2. **Scaffold** — workspaces root, `docker compose up -d`, `nuxi init` + `nest new`, `packages/shared`, root scripts (`dev`, `build`, `db:migrate`, `db:studio`).
3. **Prisma + PrismaService** — schema above, first migration, hand-add both CHECK constraints.
4. **Sessions + auth** — `express-session` + `connect-pg-simple`, argon2, `SessionGuard` / `RolesGuard`, `@CurrentUser()`.
5. **Bootstrap + invites.** *Checkpoint: redeem the master token by curl; an admin exists.*
6. **Path + subtitle parsers** — pure functions and unit tests **first**, before anything touches the filesystem. *Checkpoint: tests green for every folder and sidecar shape.*
7. **Storage + collections/seasons/videos CRUD** — slug generation and resolution included.
8. **Range streaming.** *Checkpoint: `curl -r 0-1023` returns 206.*
9. **Ingest** — reconcile, watcher, issues, scan endpoints. *Checkpoint: drop a South Park folder; drafts appear with correct seasons and order.*
10. **Probing + thumbnails** — ffprobe/ffmpeg queue, auto thumbnail, manual upload and frame capture, `needsConversion` detection, `qualityLabel()` helper.
11. **Subtitles** — sidecar discovery, conversion, serving, manual upload.
12. **Transcoding** — `MediaJob` queue, MKV→MP4 with progress and cancel, embedded subtitle extraction, source reclaim. *Checkpoint: convert a real MKV, watch progress reach 100%, then play the MP4 with its extracted tracks.*
13. **Upload** — multipart into the media tree, dedupe against the watcher.
14. **Markers** — API validation + admin scrub editor.
15. **Watch tracking** — heartbeat, progress upsert, stats.
16. **People + credits**, then **comments**, then **My List**, then **curated lists**.
17. **Frontend** — auth → home/browse/collection → player (subtitles, markers, quality badge, comments) → My List → admin PIM screens → jobs → curation → users.
18. **Hardening** — `helmet`, `@nestjs/throttler` (tight on login, redeem, and comment posting), global `ValidationPipe` with `whitelist: true`, `README.md`.

## Configuration

`apps/api/.env` — `DATABASE_URL`, `SESSION_SECRET`, `MEDIA_ROOT`, `DERIVED_ROOT`, `PORT=4000`, `NODE_ENV`, `MAX_UPLOAD_BYTES`, `INGEST_WATCHER_ENABLED`, `TRANSCODE_CONCURRENCY=1`, `TRANSCODE_PRESET=medium`, `TRANSCODE_CRF=25`, `FFMPEG_PATH`, `FFPROBE_PATH`.
`.env.example` committed; `.env`, `.bootstrap-token`, `media/`, `derived/` gitignored.

Cookie: `httpOnly: true`, `sameSite: 'lax'`, `secure: NODE_ENV === 'production'`, `maxAge` 7 days, rolling.

---

## Verification

**Bootstrap and access control**
1. `docker compose up -d && npm install && npm run db:migrate && npm run dev` → banner prints, `.bootstrap-token` exists.
2. Redeem it → admin created. Repost the same token → 400, file gone. Restart → no new token minted.
3. Mint a `USER` invite, redeem in a private window. As `USER`: upload → **403**, a `DRAFT` video → **403**, `GET /collections` returns published only.
4. Logged out: every route → **401**; `/` redirects to `/login`.

**Ingest — exercise this hardest**
5. Drop `media/South Park/Season 01/01 - Cartman Gets an Anal Probe.mp4` while running → within seconds a collection, a season numbered 1, and a video with `orderIndex = 1` and the cleaned title, all `DRAFT`.
6. Drop `media/Inception/Inception.mp4` → collection of one, no season.
7. **Copy a large file slowly** (`dd` it in over ~10s) → nothing ingests until the write settles; no truncated file appears.
8. Stop the API, drop a folder, restart → the startup reconcile finds it.
9. **Rename** `01 - ….mp4` to `02 - ….mp4` → same row, updated `orderIndex`; watch history, comments, and credits preserved, no duplicate.
10. **Move** a file to another collection → row follows, history intact.
11. Delete a file → row flips to `MISSING`, is **not** deleted, history survives. Restore it → previous state returns.
12. Stray `media/loose.mp4` at the root → appears in Issues, not ingested.

**Subtitles**
13. Both `01 - Philosopher's Stone_en_English.vtt` and `Philosopher's Stone_nl_Nederlands.srt` bind to the same video; the `.srt` is converted to `.vtt` in `derived/` and **`media/` is not modified**.
14. The player's track menu lists English and Nederlands with correct labels, and captions actually render.
15. A subtitle whose stem matches nothing → Issues, no crash.
16. Confirm no watcher feedback loop: generating thumbnails and converting subs triggers **zero** new ingest events.

**Conversion — exercise with a real MKV**
17. Drop an `.mkv` with H.265 video and two embedded subtitle tracks → it ingests, and the admin UI flags it **Needs conversion** without being asked.
18. Click Convert → progress climbs, ETA shows, the bar pauses at 100% during the faststart rewrite, then completes. `playbackKey` is set and `needsConversion` clears.
19. The `.mkv` in `media/` is **byte-identical to before** — verify with a checksum. The MP4 lives in `derived/`, and the watcher produced **zero** new ingest events for it.
20. Verify the output: `ffprobe` shows `h264` / `yuv420p` / `aac` / 2 channels, and `moov` precedes `mdat` (`ffprobe -v trace` or a faststart check) so progressive playback works.
21. Both embedded subtitle tracks appear as switchable player tracks with correct language and label. If the file also has a PGS/bitmap track, the job reports it as skipped and still succeeds.
22. Cancel a running conversion → the process dies, the temp file is removed, and no `playbackKey` is set. Kill the API mid-convert and restart → the orphaned `RUNNING` job is marked `FAILED` and its temp file cleaned up, not left forever.
23. A source with 3 audio tracks warns before starting that only the default will be kept.
24. `DELETE /videos/:id/source` is refused while `playbackKey` is null. After conversion it succeeds, shows the bytes reclaimed, and — critically — **the next reconcile does not flag the video `MISSING`**. Playback still works.
25. Re-run Convert on an already-converted video → produces a fresh output and replaces the old one without orphaning files.

**Quality badge**
26. A `1920×1080` file shows `HD`; `3840×2160` shows `4K`; `1280×720` shows **nothing at all**.
27. A `1920×800` cinematic-aspect film shows `HD` — this is the case a height-only check gets wrong.
28. After converting a 4K source, the badge still reads `4K`, because the output is re-probed rather than inheriting stale values.

**Thumbnails and markers**
29. An ingested video gets duration, dimensions, and a 10% thumbnail with no manual input.
30. Upload a custom thumbnail → `thumbnailSource = MANUAL`; run `reprobe` → **the custom image survives**.
31. Set intro `0–45s` by scrubbing → Skip Intro appears during that window only and seeks to 45s. Set an outro on an episode with a following one → Next Episode appears.

**Streaming**
```bash
curl -i -b cookies.txt -r 0-1023 http://localhost:3000/api/videos/<id>/stream
#   → 206, Content-Range: bytes 0-1023/<size>, Content-Length: 1024
curl -i -b cookies.txt -H "Range: bytes=99999999999-" http://localhost:3000/api/videos/<id>/stream
#   → 416
```
32. In the browser, **drag the scrub bar into the middle of a long video** — it must seek near-instantly without downloading the whole file. Confirm `206`s in the Network tab. Repeat against a **converted** MP4 to prove `+faststart` did its job.

**Tracking, credits, comments, curation**
33. Watch ~30s, reload → the player offers to resume at the right spot.
34. Scrub wildly without watching → `secondsWatched` stays roughly flat (delta filter works).
35. Finish a video → `completed = true`, stats update, it appears in `/history`. Kill the tab mid-playback → the `sendBeacon` flush still lands.
36. Add a director to a collection and a guest actor to one episode → the episode page shows both, merged; `/people/<slug>` lists the filmography.
37. Post a comment pinned at `2:14` → clicking it seeks there. Edit shows `edited`; a `USER` cannot edit another's; an admin can remove any, and removal leaves a tombstone rather than a gap.
38. Build a row mixing a collection and a single video → renders in order on the home page; reordering persists. Archiving a collection hides it from `USER` but not `ADMIN`.
39. Slugs: `/c/south-park/season-1/cartman-gets-an-anal-probe` resolves; two collections may both contain a `pilot` without collision.
40. **My List:** add a film and a series → both appear on `/my-list` and in the home row. Double-click Add → still one entry (idempotent, no duplicate). Remove → gone from both places. The saved series shows its next unwatched episode, and that advances after you finish an episode. Each user's list is their own — a second account sees an empty list.

**Automated** — Jest unit tests for `path-parser.ts`, the subtitle matcher, `qualityLabel()` (including the `1920×800` letterbox case), and `needsConversion()` codec/container rules — all pure functions, all cheap to cover exhaustively. `supertest` e2e for the bootstrap-redeem-once invariant, role enforcement, publish gating, comment ownership rules, and Range responses (`206` / `416` / no-header `200`). Reconcile gets an integration test against a temp directory covering move, delete, restore, **and the `sourceDeletedAt` exemption** — these are the behaviours most likely to regress silently. Transcoding is verified manually against a real MKV; mocking ffmpeg would test the mock, not the pipeline.

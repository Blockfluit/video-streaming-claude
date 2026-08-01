# CLAUDE.md

Private, invite-only Netflix-style video library. **The full design is in [`docs/PLAN.md`](docs/PLAN.md) —
read it before implementing anything.** This file holds only what is easy to get wrong.

## Stack

Nuxt 4 + Vue 3 + `@nuxt/ui` (Tailwind 4) · NestJS 11 on Express · PostgreSQL 17 + Prisma 7 · ffmpeg/ffprobe
npm workspaces monorepo: `apps/web`, `apps/api`, `packages/shared`

## Environment

- WSL2 Ubuntu, repo on the **Linux filesystem** (`~/projects/...`). Never move it under `/mnt/c` — `inotify`
  does not fire reliably there and the ingest watcher depends on it.
- Node 24 via nvm (`.nvmrc`). Interactive shells load nvm automatically; **non-interactive shells do not**
  (Ubuntu's `.bashrc` returns early), so scripted commands need `. ~/.nvm/nvm.sh` first.
- Docker via Docker Desktop WSL integration — there is **no** Linux docker engine in the distro. The whole
  toolchain (`docker`, `docker compose`, the socket) only exists while Docker Desktop is running on Windows;
  when it is not, `docker` resolves to Docker Desktop's shim and reports *"could not be found in this WSL 2
  distro"*, which reads like a missing install but is not one. Check `wsl.exe -l -v` for a **Running**
  `docker-desktop` distro, and start it with `"/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe"`.
  A `permission denied` on `/var/run/docker.sock` is the different, rarer problem: it means the `docker`
  group is missing from the current shell's credentials (`id -nG`) and needs a new login, not a reinstall.
- ffmpeg 6.1.1 with libx264 is installed system-wide.

## Invariants — violating these causes bugs that are painful to trace

**Storage**
- `MEDIA_ROOT` (`media/`) holds source files and is watched. `DERIVED_ROOT` (`derived/`) holds thumbnails,
  posters and converted MP4/VTT and is **never** inside `media/` — generated output landing in the watched
  tree causes a watcher feedback loop.
- `storageKey` = archival source. `playbackKey` = converted MP4. Streaming serves `playbackKey ?? storageKey`.
- Videos with `sourceDeletedAt` set and a valid `playbackKey` are **exempt** from the missing-file sweep,
  or reclaiming disk space marks the library `MISSING`.
- Every storage key is `path.resolve`d and confirmed inside its root before use (path traversal). Only
  `StorageService` joins paths — nothing else should build one. Containment is tested with `path.relative`,
  **never** `startsWith`: `/srv/media-backup` starts with `/srv/media` and is a different directory.
  The check is lexical and does not follow symlinks; the roots are operator-controlled, and the threat is a
  crafted key rather than a hostile filesystem.
- `StorageService` refuses to start when `DERIVED_ROOT` resolves inside `MEDIA_ROOT` — that is the watcher
  feedback loop, checked at boot because it is configuration and configuration drifts.
- Writes go to a `.incoming` neighbour and are renamed into place, so a failed write cannot leave a
  truncated file for the watcher to ingest.
- Deleting a collection or season keeps its files unless `?deleteFiles=true`. Without the files gone,
  reconcile rebuilds the rows on the next scan — the default is the recoverable mistake, not the other one.
  **Creating a season creates a folder in `MEDIA_ROOT`**, so this cuts both ways: a browser test that makes a
  season and deletes only the row leaves the folder behind, and the suite's own "start a scan" test then
  resurrects every one of them. Test teardown has to pass `deleteFiles=true`; the admin UI deliberately does
  not offer it.

**Media**
- Streaming must return **HTTP 206** with `Content-Range` for `Range` requests. `StreamableFile` alone does
  not do this, and without it the browser cannot seek.
- `Content-Length` on a `206` is `end - start + 1` — both ends are inclusive. Off by one and every response
  is short by a byte, which stalls clients rather than erroring.
- An open-ended `bytes=0-` returns **one chunk**, not the rest of the file. A `<video>` element opens with
  exactly that, and answering it in full sends the whole file to fetch the metadata at the front.
- A range unit that is not `bytes`, or a multi-range request, is **ignored** (200 with the whole body) — not
  a 416. Answering one range of several needs `multipart/byteranges`, and claiming otherwise is a lie.
- `res.on('close')` must destroy the read stream. Seeking aborts requests constantly, and without it the
  process leaks a file descriptor per scrub.
- Streaming serves `playbackKey ?? storageKey` from `derived` or `media` respectively, so the URL is
  unchanged before and after conversion and survives the source being reclaimed.
- Stream responses are `Cache-Control: private, no-store`. A shared cache holding a range response as
  though it were the whole file corrupts playback for the next viewer.
- `thumbnailSource = MANUAL` is never overwritten by a reprobe. Auto-generation runs only when `AUTO`.
  Losing a hand-picked poster to a routine rescan loses an afternoon of curation.
- `qualityLabel()` compares by **edge, not axis**: long edge against the tier's width threshold, short edge
  against its height threshold. Height alone hides the badge on most films (a 1080p film in 2.39:1 is
  `1920×800`); either raw dimension against either threshold over-promotes portrait video (a 1080×1920 phone
  clip is HD, but its 1920 height clears QHD's 1440). The plan's table says the latter and also claims it
  handles portrait correctly — those conflict, and the edge comparison is what satisfies both intents.
- Badges render only at 1080p and above; below that, render nothing.
- `PATCH /videos/:id/markers` merges the patch onto the **stored** markers before validating. The editor
  saves one marker per click, so validating the patch alone would accept an end before a start it cannot
  see. A partial pair is legal — that is the state mid-edit — and the player ignores a range it cannot use.
- Markers are bounded by `durationSec` **when it is known**. An unprobed video still gets the ordering rules
  and the absolute 24-hour cap; refusing markers outright would mean a probe failure also blocks curation.
- `qualityLabel` lives in `packages/shared` — the API probes the dimensions, the web app renders the badge.
- ffmpeg and ffprobe are invoked with `execFile`, never `exec`. Every path reaching them came off a disk
  scan or a database row, so a filename containing `;` or `$(…)` must stay a filename.
- **There is no ffmpeg wrapper worth adopting** — checked, and worth not re-checking. `fluent-ffmpeg` (2M
  downloads/week) is formally **deprecated** and still depends on `async@0.2.9` from 2013; `fessonia` is
  abandoned; `@ffmpeg/ffmpeg` is WASM (wrong target); `bare-ffmpeg` targets the Bare runtime, not Node.
  `execa` would improve process handling but is ESM-only and **fails under ts-jest's CommonJS loader**,
  which is where all 558 tests run. The thin wrapper in `media/ffmpeg.service.ts` stays.
- **ffprobe reports failures as JSON**: `-show_error -of json` puts `{ "error": { "string": … } }` on
  **stdout**, even on a non-zero exit, and `promisify(execFile)` attaches that stdout to the rejection.
  It adds nothing to a successful probe, so it is always passed. Prefer it to reading stderr.
- The **encoder** has no equivalent — ffmpeg offers only text loglevels — so stderr summarising stays the
  fallback there. For progress, `-progress pipe:1` emits `key=value` lines, which is why step 12 must use it
  rather than scraping the status line.
- Failures go through `FfmpegError`, which keeps ffmpeg's diagnosis and drops the command line. `execFile`'s
  own message leads with the whole invocation, which pushes the real cause past where `probeError` is
  truncated and shows absolute server paths to an admin. Absolute paths in ffmpeg's output are reduced to
  the filename for the same reason. stderr and the structured message **overlap without containing each
  other** — stderr adds the specific cause (`moov atom not found`) that the structured message lacks — so
  the shared part is dropped and both halves are kept.
- Thumbnails are written to `DERIVED_ROOT`, never the watched media tree.
- A probe failure writes `probeError` on the row and moves on. One unreadable file must not stop a scan of
  two hundred, and the admin needs to see which file and why.
- `needsConversion` does **not** fire on nulls from a failed probe — that would queue CPU-saturating work on
  a guess. The container check still applies, since it needs no probe.
- Probe/thumbnail run at concurrency 2 (cheap, IO-bound). Transcoding is separate and runs one at a time —
  it saturates a CPU, so running several makes them all slower rather than finishing sooner.
- **Nothing transcodes on its own.** A 200-file drop flags what needs converting and stops; an admin decides
  when to spend the CPU.
- Transcode output goes to `derived/tmp/` and is renamed into place **only on success**. A partial file
  under its final name would be streamed to viewers and read by the next probe as finished.
- Cancel sends **SIGKILL**, not SIGTERM: ffmpeg handles SIGTERM by finalising the file it is writing, and a
  cancelled job must not leave something that looks complete.
- Progress writes to Postgres are throttled to ~1/s. ffmpeg reports several times a second, and a write per
  report would spend the whole transcode hammering the database.
- `-movflags +faststart` makes ffmpeg do a final rewrite pass **after** reaching 100%, so the bar sits at
  100% for a moment before finishing. Expected, not a hang.
- Reclaiming a source refuses unless a `playbackKey` exists **and the file is actually there** — deleting
  the only copy because a row says otherwise is unrecoverable.
- Extracted subtitles are `origin: EXTRACTED`, never `INGEST`, or reconcile's sidecar sweep would delete
  them for having no file in the media tree.
- `-map 0:<index>` uses the absolute stream index, not `0:s:<n>`. They are different things and only the
  first is unambiguous when a container mixes text and bitmap tracks.
- chokidar needs `awaitWriteFinish`, or half-copied large files get ingested mid-write.
- Reconcile is keyed on `storageKey` and must stay idempotent — that is what stops uploads double-creating.
- Uploads stage in `MEDIA_ROOT/.uploads/` and are **renamed** into place. Inside `MEDIA_ROOT` so the rename
  stays on one filesystem (across two mounts it fails with `EXDEV`), and dot-prefixed so both the scanner
  and the watcher skip it — a partial or abandoned transfer is never a candidate for ingestion.
- multer uses `diskStorage`, never memory: a 2 GB file buffered in the heap takes the process with it.
- An upload is accepted on its **extension alone**. The `mimetype` a browser attaches comes from the OS
  registry, not the file — Windows reports `.mkv` as `video/x-matroska`, `video/mkv`, or nothing depending
  on what claimed the extension — so ANDing it with the extension check refused real MKVs with a message
  nobody could act on. ffprobe is the only thing that can say whether a file is playable, and it records
  `probeError` on the next pass; a mislabelled upload becomes a draft with a diagnosis. (Shipped as a bug.)
- multer 2.2 strips **both** slash and backslash paths from `originalname`, but **not** a leading dot.
  `.hidden.mp4` arrives intact and would become a file the scanner skips, so `sanitizeFilename` doing that
  is load-bearing rather than belt-and-braces. Verified by mutation, not assumed.
- An upload picks a free `storageKey` by checking the **filesystem as well as the database** — a file can be
  on disk with no row yet, and overwriting it would destroy something nobody asked to replace.
- The missing-sweep must key on **row ids already accounted for**, not on `storageKey`. Its snapshot is
  taken before moves are applied, so keying on the path marks a row MISSING in the same pass that just
  followed it to a new one. (This shipped as a bug and `ingest.db-spec.ts` caught it.)
- `contentTag` is `sha256(first 1MB + last 1MB + size)` — a *move detector*, not a content hash. Files with
  identical ends and the same size collide by design. Never use it for deduplication or integrity.
- A row is never deleted because its file vanished. `stateBeforeMissing` remembers what it was, so a file
  that comes back is restored rather than silently demoted to `DRAFT`.
- `reconcile.run()` joins an in-flight pass rather than starting a second. A folder drop fires an event per
  file, and concurrent passes would race on the same rows.
- Ingest issues are upserted on `(kind, path)` and *resolved*, never deleted — a rescan must not pile up
  duplicates of the same complaint.
- Ignoring a file beats the structural rules in `parseMediaPath`: dotfiles, partials and unknown extensions
  are ignored at **any** depth. The other order files an issue for every `.DS_Store` and `.gitkeep`, which
  buries the problems that need a person. (`media/.gitkeep` did exactly this on the first real run.)

**Watch tracking** (`watch/progress.ts` is pure; `watch/watch.service.ts` is the IO around it)
- `lastPositionSec` is where the viewer **is** and goes backwards when they seek back — it is what resume
  restores. `maxPositionSec` is how far they ever got, is monotonic, and is what `completed` is judged on.
  Judging completion on the playhead instead would un-finish a video the moment someone rewound to rewatch
  a scene.
- Position is clamped to `durationSec`. Browsers report a `currentTime` a hair past `duration` at the end of
  playback and a container's declared duration is not exact, so storing it verbatim offers a resume that
  seeks past the end of the file.
- `completed` needs a duration that is known **and above zero**. A failed probe writes 0, and `x >= 0 * 0.9`
  marks every unprobed video complete.
- `deltaSec` is **capped** at 30s per beat, not rejected — the plan says "reject > 30", but a rejected beat
  throws away the viewer's resume position along with the excess seconds, and missing two beats is a normal
  network hiccup. The cap stops one bad number from rewriting a total; it is **not** a rate limit, since a
  client beating in a loop still accumulates. That is `@nestjs/throttler` in step 18.
- The `WatchEvent` row stores the **credited** delta, not the claimed one, so summing the log still
  reproduces the rollup. Both are written in one transaction for the same reason.
- `viewCount` increments only on the first beat carrying a given `playSessionId` — that lookup is why
  `WatchEvent` has `@@index([playSessionId])`. Two concurrent first beats can both count; a view miscounted
  by one is not worth a lock.
- `navigator.sendBeacon` sends a string as **`text/plain`**, which the global JSON parser ignores — the
  handler then sees an empty body and drops the one beat that carries where the viewer actually stopped. The
  heartbeat route gets its own `json({ type: [...] })` via `MiddlewareConsumer`; everywhere else a
  `text/plain` body stays a 400.
- `/me/history` filters visibility on the **nested video**, not just the progress row. A video archived
  after someone watched it must drop out of their history rather than leak its title back to them.
- Aggregate figures are ADMIN-only; `mine` is returned to any caller. Collection `viewers` is a distinct
  count over users — summing per-video viewer counts turns one person watching six episodes into six people.
  `averageCompletion` averages per-video fractions rather than dividing summed positions by summed
  durations, which would weight a feature film far above an episode.

**People, credits, comments and lists**
- A video's credits panel is its own credits **merged with its collection's** (`credits/merge.ts`, pure).
  On a `(personId, role)` clash the **episode's** credit wins outright — it is the more specific one and can
  carry an episode-specific character name. Role display order comes from `Object.values(CreditRole)`, never
  a hand-written array. The sort must be **total** (role, position, collection-before-video, name, id): the
  two parents number positions independently so ties are normal, and a panel that reshuffles between
  requests reads as a rendering bug for weeks.
- Credit duplicate prevention (same person + role + parent) lives in the **service**. The parent columns are
  nullable and Postgres compares NULLs as distinct, so a composite unique index would let every video credit
  duplicate freely.
- `PATCH /credits/reorder` is declared **before** `credits/:id` (Express matches in order, so the other way
  round makes `reorder` a credit id), names its parent explicitly, and requires the **complete** list exactly
  once. Taking ids on trust would make a reorder a way to renumber credits on a video nobody mentioned.
- A person's name is checked for clashes **case-insensitively**; the schema's unique index is not, and would
  hold "ada lovelace" and "Ada Lovelace" as two people.
- A filmography is filtered by the caller's visibility, or a director's page becomes a way to read the draft
  library.
- `GET /admin/comments` is the moderation queue and deliberately does **not** apply `whereVisible`. A
  comment worth removing is most likely on a video nobody is watching, so filtering it would mean the one
  screen that can find it is the one screen that hides it. It is ADMIN-only, which is what makes that safe.
  Removed comments are excluded by default — a tombstone is noise when you are looking for something to act
  on — and `includeDeleted` goes through `booleanParam`, so `?includeDeleted=false` is false.
- Comment deletion is **soft**, so `toCommentView` is the only thing between a deleted comment and its text.
  It builds the tombstone from nothing rather than spreading the row and overwriting — a column added later
  would otherwise ride along unnoticed. The tombstone keeps `createdAt` (its place in the thread is the only
  reason the row is served) and drops body, author and `timestampSec`.
- **Editing a comment is the author's alone, admin included.** An admin moderates by removing; rewriting
  someone's words and leaving their name on it is not moderation, and `editedAt` would make it look like
  they had done it themselves. Deleting is the author's or any admin's, and is idempotent.
- A comment is reached **through its video's visibility** — 404, not 403 — so a comment id is not a way to
  act on, or confirm the existence of, a video the caller cannot see.
- **My List** (explicit, per-user) and **curated rows** (admin-made, the same for everyone) are deliberately
  different things, and Continue Watching is neither — it falls out of `WatchProgress`. All three land on
  the home page.
- Both list adds are idempotent by **catching the unique violation**, not by checking first: check-then-write
  is not atomic and a double-click lands inside the gap. The partial uniques are what enforce it.
- `nextEpisode` (pure) picks the first **unfinished** episode — which also covers resuming a half-watched
  one, and does not skip an episode because a later one was finished — and returns to the first once the
  whole thing is done. A null `orderIndex` sorts **last**: it means "ingest could not tell", and treating it
  as episode zero offers an unnumbered extra ahead of a real episode one.
- Curated row items are visibility-filtered **per item**. A row is admin-made and can hold anything, so that
  filter is the only thing stopping a home-page shelf from advertising a draft. `includeHidden` does nothing
  at all for a non-admin.
- `DELETE /lists/:id/items/:itemId` is scoped to the list in the URL — an item id alone must not reach into
  another row.

**Parsing** (`ingest/path-parser.ts`, `ingest/subtitle-matcher.ts` — pure, no filesystem)
- `parseMediaPath` returns `storageKey` **verbatim**. Reconcile is keyed on it, so normalising the path here
  would silently break move detection.
- Only `/` separates path segments. A backslash is a legal character in a Linux filename and must never be
  treated as a separator.
- Release-tag stripping matches **whole tokens** — a substring match eats real titles (`aac` inside
  "Aachen"). `cleanTitle` also never returns empty, falling back to the raw name. That fallback masks
  substring bugs in single-token titles, so test tag stripping with **multi-word** titles or the test proves
  nothing.
- The sidecar regex's stem must stay **greedy**. Lazy would split `The_Big_Sky_en_English` at the first
  short word, reading `Big` as the language.
- Subtitle binding is exact-stem first, then title. Ambiguity is **reported, never guessed** — the wrong
  language on the wrong episode is worse than an issue in the admin list.
- Sidecars are matched **per folder**, never library-wide. Every show has a `Pilot`, so a wider scope makes
  all of them ambiguous.
- Everything served lives in `DERIVED_ROOT`, including sidecars that were already `.vtt` — copying a few
  kilobytes beats carrying a "which root?" question through every read, and it survives the source moving.
  `sourceKey` holds the media path the sidecar came from; without it, reconcile cannot notice a deletion.
- Decide a subtitle's charset **before** converting, not after. Legacy `.srt` is often Windows-1252, and
  ffmpeg either fails or emits mojibake — a conversion that already threw cannot be rescued by a retry.
- An uploaded subtitle is sniffed for the `WEBVTT` signature. An SRT accepted as a `.vtt` loads as an empty
  track: the viewer sees the language listed and nothing ever appears.
- Exactly one `isDefault` per video. `<track default>` on two tracks is undefined behaviour.
- An unrecognised season folder or language code is *accepted and flagged*, not rejected. Only structural
  problems (root-level file, depth > 3) refuse ingestion.
- Language codes go through `src/common/language.ts` (backed by `langs`), never a local list. A language can
  have two three-letter codes — `dut`/`nld`, `ger`/`deu` — and subtitle files in the wild use both.

**Data**
- Prisma cannot express CHECK constraints. `ListItem`, `Credit`, and `WatchlistItem` each need a hand-added
  `CHECK ((collectionId IS NULL) <> (videoId IS NULL))` in their migration. Regenerating the init migration
  drops them — re-append them.
- Prisma 7 differs from 6 in ways that bite: the connection URL lives in `prisma.config.ts`, **not** in the
  schema's datasource block; the client needs a driver adapter (`@prisma/adapter-pg`); and the generator
  emits **TypeScript**, not compiled JS.
- That generated TypeScript must stay under `src/` (`output = "../src/prisma/generated"`). Emitted anywhere
  else it drags tsc's inferred `rootDir` up to `apps/api`, silently moving the entrypoint to
  `dist/src/main.js`. `prisma.config.ts` is excluded from `tsconfig.build.json` for the same reason.
- `$connect()` is **lazy** behind a driver adapter — it resolves fine with no database listening. Only a real
  query proves the connection, which is why `PrismaService` runs `SELECT 1` at boot.
- `BigInt` (`sizeBytes`) does not survive `JSON.stringify` — handled once at the response boundary by
  Express's `json replacer` in `main.ts`, which renders it as a **string** (a number past
  `Number.MAX_SAFE_INTEGER` would round silently). A test app must set the same replacer or it will differ
  from production.
- Slugs are **stable once created**: renaming a title never moves the slug, because shared links would break.
  Regeneration is an explicit `regenerateSlug: true`. Uniqueness scope differs per entity — collections are
  unique library-wide, seasons and videos only within their collection, so two shows may both have a `pilot`.
- `GET /collections/:slug/resolve` checks **season slugs before video slugs**, and the literal `:slug/resolve`
  route is declared before `:slug` or Express matches `resolve` as a collection slug.
- Postgres treats NULLs as distinct, so composite uniques containing nullable columns do not prevent
  duplicates. Enforce those in the service layer.
- `ListItem.position` is deliberately not unique — a unique index collides during drag-reordering. `Video.orderIndex`
  is not unique for the same reason, which is why `PATCH /collections/:id/videos/order` rewrites a season's
  whole sequence in one transaction rather than swapping pairs. It sets `seasonId` **and** `orderIndex`
  together, because dragging an episode into a season changes both at once; `seasonId: null` is a real value
  meaning "directly in the collection", which is where films live. Like `credits/reorder` it names both
  parents — the collection in the URL, the season in the body — and refuses ids belonging to anything else,
  or a reorder becomes a way to pull episodes out of a show nobody mentioned.

**Frontend**
- During SSR, `useFetch`/`$fetch` run in Nitro and do **not** forward the browser cookie. Pass
  `headers: useRequestHeaders(['cookie'])` — wrap it once in a `useApi()` composable.
- Everything is same-origin via the Nuxt `/api/**` proxy. Keep it that way: a cross-origin `<track>` fails
  silently, and `<video>`/`<track>` cannot send `Authorization` headers (this is why auth is cookie-based).
- Upload progress needs `XMLHttpRequest`; `fetch` still gives no upload progress events.

**Frontend** (`apps/web`, in addition to the notes above)
- **Nothing talks to the API except `useApi` / `useApiData`** (`app/composables/useApi.ts`). During SSR a
  bare `$fetch` runs in Nitro with no cookie jar, so a call that works in the browser 401s the moment the
  same page renders on the server. One place that can forget is the point.
- `useApiData` is built on `useAsyncData`, **not** `useFetch`. `useFetch` is the obvious choice and was the
  first attempt: its generics do not survive being wrapped — the payload type collapses to `unknown` and
  every call site loses `.items`. The price is an explicit cache key per call.
- `auth.global.ts` is **navigation, not access control**. The API authorises every request; the middleware
  only spares someone a page of failed calls. Nothing there is a security boundary.
- The `?redirect=` a sign-in carries goes through `safeRedirect` — it arrives through the URL, so anyone can
  write it, and following it after authenticating is an open redirect. A leading `/` is not enough:
  `//evil.example` is protocol-relative and off-site, and some browsers normalise `/\evil.example` the same
  way.
- Artwork is `GET /videos/:id/thumbnail` and `GET /collections/:id/poster`, which **revalidate** (`ETag` +
  `private, no-cache`) rather than carrying a lifetime. The storage key is stable across replacements, so
  any `max-age` above zero serves the poster an admin has just replaced.
- A nav link to a route with no page is a broken app, not a placeholder — links land with their pages. The
  reverse is just as bad: `/admin/collections/[slug]` and `/admin/comments` are unreachable without their
  sidebar entries, and a page nobody can navigate to gets no use and no bug reports.
- The admin layout has a real `<main>`. It had none — only `<aside>` and a bare `<div>` — so there was no
  landmark to skip the nav to, and `main a[…]` (which every viewer-side test uses) matched nothing there.
- `refDebounced` is VueUse and **not a dependency**. Debounce with a `setTimeout` cleared in `watch`, the way
  `browse.vue` does; without one, every keystroke is a request and the answers can land out of order, so the
  list settles on whatever the *slowest* one returned.
- Helpers shared by two screens move to `app/utils/` (Nuxt auto-imports them) rather than being copied.
  `apiMessage` was private to the video editor until a second page needed it — two divergent copies of "what
  did the server actually say" is how one screen ends up silently swallowing errors.
- `packages/shared` emits **both** CJS and ESM, and needs to. NestJS and ts-jest `require()` the CJS half;
  Vite serves the package to the *browser* as a native ES module, where a CJS file exposes **no named
  exports at all** and `import { loginSchema }` fails at parse time. SSR hides this completely — Nitro can
  require CJS — so it only appears when a page is opened in a browser. Relative imports in `src` carry
  explicit `.js` extensions so one source tree emits both, and `dist/esm/package.json` marks that half as
  `type: module`.
- Nuxt Icon's runtime endpoint defaults to **`/api/_nuxt_icon`**, which the `/api/**` proxy swallows whole
  and forwards to NestJS. Moved to `/_icons` via `icon.localApiEndpoint`; otherwise any icon resolved at
  runtime silently fails to draw.
- The `/api/**` proxy owns that prefix entirely, so anything else wanting a server route has to move off
  it — Nuxt Icon's default `/api/_nuxt_icon` was the first casualty and will not be the last.
- A poster's storage key never changes, so replacing one leaves the browser showing the old picture. The
  admin screens append a cache-busting query after a capture or upload; the ETag alone cannot help an
  `<img>` that was never re-requested.
- Browser tests live in `apps/web/e2e` (`npm run test:e2e -w @video/web`). They assert controls **do
  something** — `expectsRequest` waits for the API call — because a button with no handler renders
  perfectly. Needs both dev servers plus `npx playwright install --with-deps chromium`.
- **`locator.count()` does not retry.** A guard written as `if (await x.count() === 0) test.skip(...)` runs
  before a client-side route has rendered and is therefore always true: the sidebar-navigation test skipped
  on every run since it was written, announcing "only one video in this collection" about a collection
  holding five. A skip that never runs reports green, which is worse than no test. Decide a skip from the
  **data** (fetch it) and wait for the DOM with `expect`, which retries.
- `waitForLoadState('networkidle')` is not a substitute either — after a client-side navigation it can
  resolve *before* the route's data request has even started.
- `visible.spec.ts` catches the two bugs every other test walks past: **an `opacity: 0` control** (Playwright
  clicks those happily and `toBeVisible()` does not check opacity, so a `group-hover` with no `group`
  ancestor passes everything while being invisible to a person) and **text below WCAG AA**. Contrast is
  measured by painting the colours on a canvas — Chromium returns `oklab()` for anything from the Tailwind
  palette, and parsing that as `rgb()` silently reports every ratio as ~1.
- Server-rendered markup accepts a click or a keystroke **before Vue hydrates**, and the interaction is then
  silently dropped. Tests go through `visit()`/`fillStable()` for this; it is also why a real user can lose
  the first character typed into a search box.
- **Never give a `USelect` an option whose value is `''`.** Reka UI reserves the empty string for "cleared"
  and throws during render — which takes the whole page down, not just the select. Use a sentinel.
- `GET /videos/:id/subtitles` returns a `Page` like every other list endpoint. It returned a bare array
  until the player's `<track>` list silently came back empty — the frontend read `.items` because
  everything else does, which is the whole point of the convention.
- `GET /videos/:id/credits` and `/collections/:id/credits` were the **same bug**, found the same way: both
  returned bare arrays and neither was caught, because no frontend called them until step 17b. A whole cast
  arrives in one response rather than a paged window — a credits panel that arrives in pages is not a credits
  panel — but it is still wrapped in a `Page`, capped at `MAX_CREDITS`. **An endpoint nothing calls has not
  been proven to honour any convention.**
- **curl proves SSR and nothing else.** Both faults above returned HTTP 200 to curl and broke on hydration.
  A frontend change is verified in a browser or it is not verified.
- **A WCAG ratio is necessary, not sufficient.** "I still cannot read this" was reported while every control
  on the page cleared AA — the worst was 5.78:1 and the `Edit` buttons measured 6.19:1. The formula weights
  red at 0.2126, so saturated red text on near-black scores well and reads badly at 12–14px. The fix was to
  stop using accent-coloured *text* for controls at all: `variant="subtle"` with no `color` renders the
  primary colour as text, so it gets `color="neutral"` (white on a raised surface) and the one real call to
  action on a screen gets `variant="solid"`. Accent colour marks things — a rule beside the active nav item,
  a bar under the eyebrow — and never sets type.
- Colour lives in five named tiers in `main.css` (`--ui-text` → `--ui-text-dimmed`, plus `--ui-border` and
  `--ui-border-accented`), each annotated with its measured ratio. They replaced 96 ad-hoc `white/N`
  utilities, two of which (`text-white/35` at 2.8:1 and `/40` at 3.5:1) were below AA. `--ui-border-accented`
  is measured against `--ui-bg-elevated`, **not** the page: a bordered control almost always sits on a raised
  surface, and measuring against the page flatters the value by half a point while the border still vanishes.
- `bg-white/N` is deliberately *not* part of that sweep — those are scrims over artwork and progress-bar
  tracks, where the alpha is the point.
- Gradients over artwork interpolate to `var(--ui-bg)`, never a hardcoded hex. The hero faded to `#08080a`
  after the page moved to `#0a0a0c`, so the scrim stopped landing on the colour behind it.
- **Reka UI teleports popovers to `<body>`.** An audit scoped to `main *, header *, aside *` therefore never
  sees a single dropdown, select or modal. `visible.spec.ts` walks the whole document for this reason.
- A `mask-image` icon's colour **is** its `background-color`, so an audit that treats the element's own
  background as the backdrop compares the colour against itself and reports a flat ~1:1 for every icon on
  the page. Text and borders paint *on top of* their own background and must include it; icons must not.
  Getting this wrong reported 56 fake problems out of 70.
- **`@nuxt/ui` control triggers carry their own `aria-label`, which shadows the visible text.** `USelectMenu`
  ships `aria-label="Show popup"` — so the accessible name of the control that picks a person was "Show
  popup". Pass an explicit `aria-label` naming the *job*, not the mechanism. (Same bug as `AddToListButton`.)

**Access control**
- `USER` sees only `PUBLISHED` records. Enforce with `whereVisible(role)` in services, never in the UI alone.
- A caller-supplied `state` filter must **intersect** `whereVisible(role)`, never replace it. Use
  `narrowToVisibleStates(role, requested)` and spread it **last** in the `where`, so nothing can overwrite
  it. Spreading `{ state }` after the visibility rule silently replaces it and `?state=DRAFT` hands a
  `USER` the whole draft library. Filters narrow; they never widen. (This shipped as a real bug and was
  caught by `library.db-spec.ts` — keep that test.) Paging is a window onto what a role may see, never a
  way past it.
- The visibility filter applies to **nested** reads too. A published collection may contain draft videos,
  so the `videos` relation needs its own `where`, not just the collection query.
- Refuse to demote, deactivate **or delete** the last active admin — all three strand the library equally.
  The count of remaining admins is read `FOR UPDATE` inside the transaction: read-then-write is not atomic,
  and without the lock two admins demoted at the same moment both see "one other remains" and both commit.
  A *deactivated* admin does not count as cover. There is deliberately no self-exemption — this one rule
  covers an admin demoting themselves and two admins stranding each other; "you can't edit yourself" would
  only catch the first.
- `SessionGuard` is registered globally, so access is fail-closed: a new route is protected the moment it
  exists. Opt out with `@Public()` — never by leaving a guard off.
- The session stores **only** `userId`; the user is re-read on every request. Do not cache the role in the
  session, or deactivating an account stops taking effect until the cookie expires.
- Login regenerates the session id (fixation) and `/auth/login` answers the same way for an unknown account
  as for a wrong password. Both are covered by `test/auth.e2e-spec.ts`.
- Invite and bootstrap tokens are hashed with **sha256, not argon2** — they are 256-bit random values, so
  a slow KDF buys nothing. Passwords are guessable and still use argon2id. Only the hash is ever stored, so
  a token's plaintext exists exactly once: in the mint response, or in `.bootstrap-token`.
- `.bootstrap-token` is a live credential. Mode `600`, deleted the moment it is redeemed and on any startup
  that finds an admin already present. A `BOOTSTRAP` row whose file is gone is unusable — nobody can present
  that plaintext again — so startup mints a replacement rather than "reusing" it.
- Redemption is one `$transaction` ending in a **conditional** `updateMany({ where: { id, redeemedAt: null } })`.
  Read-then-write is not atomic; without the condition two transactions can both redeem one token. A
  single-process API serialises requests enough that the earlier check usually catches the loser, which is
  why the HTTP-level test cannot prove this — `auth.service.spec.ts` pins the condition instead.
- Every way a token can fail — unknown, expired, revoked, spent — returns one identical 400. Distinguishing
  them turns a spent token into a probe for which tokens ever existed.
- Login identity is **username**, not email — there is no email column. Usernames are stored lowercase, so
  every lookup and every write must go through `normaliseUsername()`; querying the raw input makes login
  silently case-sensitive. `displayName` is what gets rendered and is seeded from the username as typed.

## Conventions

- Pure logic (`path-parser`, subtitle matcher, `qualityLabel`, `needsConversion`) lives in testable functions
  with unit tests written **before** the code that calls them. These are the highest-risk, cheapest-to-test parts.
- Three test tiers, and the split matters: `*.spec.ts` (unit), `*.e2e-spec.ts` (HTTP, Postgres stubbed) and
  `*.db-spec.ts` (HTTP against a real `video_test` database). Anything whose correctness *is* a database
  guarantee — transactions, conditional updates, constraints — belongs in the third; a stub cannot lose a
  race. `test:db` fails loudly with no database rather than skipping, so it can never go green testing nothing.
- Validation: **zod schemas in `packages/shared`** are the source of truth, so a form and the endpoint
  behind it cannot drift apart. Applied per parameter with `validate(schema)` — there is no global pipe,
  because the schema is what says *what* to validate. Zod objects strip unknown keys by default, which is
  what the old `whitelist: true` did; switching any schema to `.passthrough()` silently undoes it.
- **Every list endpoint returns a `Page<T>`**, never a bare array. `limit` defaults to 50 and is capped at
  100 — a limit above the cap is a 400, not a silent clamp, so the worst-case response size is a property
  of the API rather than of whoever is calling it.
- Any paged query must sort by a **unique** column last (`id`). Offset paging over a non-total order
  repeats and skips rows between pages, and `title`/`orderIndex`/`createdAt` all repeat.
- `z.coerce.boolean()` is wrong for query flags — it follows JS truthiness, so `"false"` becomes `true`.
  Use `booleanParam` from `@video/shared`.
- Standard reference data (ISO 639 codes, MIME types, country codes) comes from a **package**, not a
  hand-written table — a frozen standard transcribed by hand is where quiet errors live. Cross-cutting
  helpers live in `src/common/` (API-wide) or `packages/shared` (both apps), so a second caller imports
  them instead of reaching into a feature module.
- Commit at each checkpoint in the plan's build order, not in one large batch.

## Commands

```bash
docker compose up -d    # PostgreSQL
npm install
npm run db:migrate      # Prisma migrations
npm run db:studio       # Prisma Studio
npm run dev             # Nuxt :3000, NestJS :4000
npm test                # Jest unit tests (API)
npm run test:e2e        # supertest against stubbed Postgres — no database needed
npm run test:db         # supertest against a real Postgres; creates/migrates `video_test`
```

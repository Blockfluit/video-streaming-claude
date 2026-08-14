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
- **Every folder directly under `MEDIA_ROOT` is a drive**, a symlink to a physical disk in production. A
  drive is where bytes live and is never a collection. The convention is
  `media/<drive>/<item>/<season>/file`, and what an item folder *becomes* is decided by what is inside it
  (`ingest/structure.ts`): season folders or two videos make a collection, a lone video does not.
- The scanner follows a symlinked directory at the **drive level only**. `readdir` reports one as neither a
  file nor a directory, so without that every disk is skipped and the scan returns an empty library rather
  than an error. Deeper symlinks stay unfollowed, and `MAX_WALK_DEPTH` still bounds the walk.
- A video **loose in a drive root** is not ingested. It raises a `LOOSE_DRIVE_FILE` issue: a drive holds
  unrelated things, so there is no folder to take a suggestion from and nothing to say whether it stands
  alone or belongs with its neighbours.
- The folder layout is only an **initial suggestion**. A proposal is applied when a video is first
  discovered and never again — a move on disk follows the file and changes nothing else. Re-deriving would
  undo whatever an admin has arranged, on the strength of someone tidying up a disk.
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
- **Creating a season creates a folder in `MEDIA_ROOT`**, and that folder is what reconcile rebuilds the row
  from. Deleting a season therefore removes its directory when it is **empty** (`storage.deleteIfEmpty`,
  which is `rmdir` — the check and the action in one syscall, so there is no race between looking and
  removing). An empty directory holds nothing anyone can lose, and leaving it was what made a deleted season
  reappear on the next scan: the screen and the disk disagreed, and the disk won a few minutes later.
  A directory that still holds something is left alone, so nobody destroys a film with the same button that
  tidies up an empty folder — that still needs `deleteFiles`, and the admin UI confirms it by naming how many
  files go rather than asking "are you sure?".

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
- Every video has **two** pictures, both cut from the frame 10% in: a 16:9 `bannerKey` (the old
  `thumbnailKey`, renamed for what it is) and a 2:3 `posterKey`. The files stay under
  `derived/posters/` and `derived/banners/`, each named after what is in it.
- `posterSource`/`bannerSource` are `MANUAL` independently, and `MANUAL` is never overwritten by a
  reprobe. Auto-generation runs only when `AUTO`. Separate sources are what let an admin hand-pick a
  poster and still get a fresh banner; losing a hand-picked one to a routine rescan loses an afternoon
  of curation. Each shape is captured and reported on its own, or a poster that fails takes the banner
  with it and a probe ends with neither picture.
- The poster crop is `crop=min(iw\,ih*2/3):min(ih\,iw*3/2)`, **not** `crop=ih*2/3:ih`. The latter reads
  correctly, works on every landscape file — which is most of a library — and then fails outright on a
  portrait one by asking for a crop wider than the source. Both dimensions must be capped by what the
  frame can supply. The `\,` are escaped for ffmpeg's filter parser, never for a shell.
- A **trailer** is stored as the 11-character YouTube **id**, never the pasted URL, parsed by
  `parseYoutubeId` in `packages/shared` so the form and the endpoint cannot disagree about what is
  acceptable. Admins paste what is in their address bar — a watch URL with a playlist and a timestamp,
  a `youtu.be` link, an embed URL — and interpolating whichever arrived into an iframe `src` gives a
  player that silently shows nothing. Keeping the id also keeps the embed URL a *rendering* decision:
  privacy host, autoplay, mute. The id pattern is **anchored**; a playlist id is 34 characters of the
  same alphabet, so an unanchored match finds something id-shaped inside one and plays a video that
  does not exist.
- The hero's trailer starts **muted**, which is not a preference: a browser refuses to start an unmuted
  video nobody asked for, and it fails *silently* — the iframe loads and sits there. It is suppressed
  entirely under `prefers-reduced-motion`, and nothing is requested from YouTube until it starts. The
  iframe must be `pointer-events-none`: an iframe swallows every click that lands on it, so without
  that the Play button underneath stops working the moment the trailer fades in, and the page looks
  perfectly fine while doing it.
- **A collection's artwork is derived, not stored.** Its own `posterKey`/`bannerKey` are the *admin
  override*; null means "not overridden", and it then shows its **first video's** picture by
  `MEMBERSHIP_ORDER`, falling back to a stock image only when it holds nothing. Deriving on read is what
  makes it follow the episodes instead of snapshotting something that rots. The inherited candidate goes
  through `whereVisible(role)` like every other nested read — a published collection may hold draft
  episodes, and a draft's poster is not published art.
- **The artwork routes never 404 for a missing picture.** Absent artwork is an ordinary state, and every
  card used to pay a round trip to be told so; the browser suite fails any 4xx, so one collection nobody
  had postered turned whole pages red. A row the caller may not see is still a 404 — the fallback must
  not turn an invisible video into a 200 that confirms it exists.
- The stock image is an **SVG built in code**, not a file. `nest build` copies TypeScript and nothing
  else, so a `.jpg` needs an `assets` entry in `nest-cli.json` *and* a Dockerfile `COPY`, and missing
  either fails as a 500 in production and nowhere else.
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
  which is where every API test runs — 723 unit, 19 e2e and 572 db. The thin wrapper in
  `media/ffmpeg.service.ts` stays.
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
- Thumbnails are written to `DERIVED_ROOT`, never the watched media tree, and they are **renamed into place**
  from `derived/tmp/` like a transcode. ffmpeg truncates its output the moment it opens it, so capturing
  straight to `thumbnails/<id>.jpg` left the live poster missing for as long as the capture took — every card
  in the app requests that URL, so a routine re-probe made artwork flicker to a **404**, not a stale picture.
  Testing this needs a failure that happens *after* the output is opened: pointing ffmpeg at an unreadable
  source fails during input parsing, never touches the destination, and passes against the broken code too.
- A probe failure writes `probeError` on the row and moves on. One unreadable file must not stop a scan of
  two hundred, and the admin needs to see which file and why.
- **A poster failure is not a probe failure.** Thumbnail generation runs outside the probe's `catch` and is
  only logged: it used to sit inside, so a failed capture wrote `probeError` on a row whose probe had just
  succeeded, and the ingest list reported a file as broken while it played and edited perfectly well.
- **`captureFrame` checks that a frame was actually written.** ffmpeg exits **0** when the seek lands past
  the end — it says "Output file is empty, nothing was encoded" on stderr and writes nothing — so trusting
  the exit code left the *rename* to fail with an `ENOENT` naming neither the timestamp nor the file. A
  `NoFrameError` becomes a **400** on the capture endpoint, because the admin chose the moment.
- **A scan has no `awaitWriteFinish`; the watcher does.** A scan will therefore read a file that is still
  being copied, and ffprobe reports the whole duration from an MP4's leading moov atom while the bytes are
  still arriving — a 994 MB film was recorded at 8 MB, and its poster sought 813 seconds into it. Reconcile
  cannot tell mid-copy from finished while it looks, so it notices **next time**: a row whose file has a
  different size or mtime is updated and re-probed. Without that, nothing ever looked at the row again.
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
- The watcher's `ignored` predicate (`ingest/watch-ignore.ts`) judges a path **relative to `MEDIA_ROOT`**,
  never the absolute one. Matching a dot segment anywhere in the absolute path makes the verdict depend on
  where the library lives rather than what is in it: a root under any dot directory ignores **itself**, so
  chokidar watches nothing. Nothing is logged and no error is raised — a tree that never reacts looks
  exactly like a tree nobody has touched, and the only thing that still worked was the startup scan, so
  restarting the API "fixed" it every time. Every worktree checkout (`.claude/worktrees/<name>/media`) ran
  that way, which is how it was found: a symlinked drive that every scan ingested correctly appeared not to
  work. Segments split on the platform separator only, so a backslash stays a legal filename character.
- Only the **drive level** — a folder directly under `MEDIA_ROOT` — may be a symlink. `readdir` reports a
  symlinked directory as neither `isDirectory()` nor `isFile()`, so following it is explicit and deliberate.
  Deeper links are not followed and symlinked files are not ingested; `MAX_WALK_DEPTH` bounds the drive case
  in case a link points back up its own tree.
- A symlinked drive is resolved in the **container's** mount namespace, so a deployment has to mount the
  target at the same absolute path the link names (`DISKS_PATH` in `deploy/compose.yml`). Bind-mounting
  `MEDIA_PATH` alone leaves `media/disk1 -> /mnt/hdd1/videos` dangling, and the scan reports `ENOENT`
  against a disk that is plainly there on the host — which reads as broken symlink support and is the
  opposite: the link was followed correctly and there was nothing behind it. Mounting a disk *onto*
  `/media/disk1` instead does not work, because Docker resolves that mount point through the very symlink
  that is broken.
- A dangling drive is reported with the **target it could not reach**, not a bare errno. `ENOENT` alone
  sends an admin looking for a bug in the library rather than at their mounts. That message prints an
  absolute server path deliberately — the rule about reducing those to filenames is about ffmpeg output,
  where the path is incidental; here it is the entire diagnosis, and the ingest list is ADMIN-only.
- Reconcile is keyed on `storageKey` and must stay idempotent — that is what stops uploads double-creating.
- Uploads stage in `MEDIA_ROOT/.uploads/` and are **renamed** into place, dot-prefixed so both the scanner
  and the watcher skip it — a partial or abandoned transfer is never a candidate for ingestion. The rename
  now crosses filesystems, because each drive is its own disk: `StorageService.move` catches `EXDEV` and
  copies to a **dot-prefixed neighbour** in the target directory before renaming, so a file still appears
  under its final name only once it is complete.
- **Upload places files and creates no rows.** It writes them into the shape the convention expects on a
  drive the uploader picks — a single file gets a folder named after it, a folder tree lands as given — and
  reconcile makes of them exactly what it would make of the same folders copied there by hand. One rule for
  what the library is, not two. Attribution (`uploadedById`, `origin: UPLOAD`) is stamped afterwards on
  `storageKey`, or an upload would be indistinguishable from a copy.
- A directory upload's relative paths travel in a **parallel `paths` field**, one per file in order, because
  multer strips separators from `originalname`. Traversal segments are dropped **before** `sanitizeFilename`
  runs: it gives an unusable segment a fallback rather than an empty string, so filtering afterwards turned
  `../../escaped` into real folders called `upload`. (Caught by `uploads.db-spec.ts`.)
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
- **A stored `contentTag` must be refreshed wherever `sizeBytes` is.** The size is *in* the hash, so a row
  whose file changed holds a tag those bytes can never produce again, and move detection for that one row is
  then broken permanently. It fails silently and late: nothing looks wrong until the file is renamed months
  later, and then it is not recognised as itself — a second video is created and the original is swept to
  `MISSING`, stranding its title, artwork, markers, credits and watch history while the file sits in plain
  sight under a new name. The re-read branch is where this bit, and the trigger is ordinary: a scan has no
  `awaitWriteFinish`, so every file whose copy outlives one scan interval is tagged half-written and then
  re-read. Recompute on *any* change, not just a change of size — the tag samples the first and last
  megabyte, and those can be rewritten without the size moving. (Shipped as a bug; `ingest.db-spec.ts` now
  pins both the symptom and the mechanism.)
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
  client beating in a loop still accumulates. That is what the heartbeat limit in
  `common/throttling.ts` is for.
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
  the home page, and all three are now **rows** (`CuratedList.source`) rather than two of them being
  hardcoded above the third: the shelves every viewer sees first were the two an admin could not move.
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

**Home-page rows** (`lists/sources/rank.ts` is pure; `computed.ts` is the IO around it)
- A row is a **source, a kind, a limit and filters**. `MANUAL` reads its `ListItem`s; the computed sources
  rank the library; `CONTINUE_WATCHING` and `MY_LIST` delegate to `WatchService.history` and
  `WatchlistService.list` rather than restating either — both already resolve visibility on the nested video
  and which episode a saved show would play.
- A computed row applies `whereVisible(role)` **while scoring, before the limit**. A manual row can filter
  afterwards because its pool is small and admin-chosen; a computed one cannot, or asking for ten returns
  three because the other seven were drafts — which reads as an empty library rather than as a filter.
- A video whose every collection is hidden from the caller is **dropped**, not shown. It is not a film, it
  is an instalment of something they cannot see, and offering it as though it stood alone is the leak the
  visibility rule exists to prevent. A video with **no** memberships is the different, ordinary case and is
  kept. `whereNotOrphaned(role)` in `common/films.ts` is that rule; `isOrphaned` here is the same rule in
  memory, applied after the pool limit rather than in SQL.
- `AUTO` shows collections **and films with no shelf at all** in one shelf, and that is deliberately *not*
  the pairing `browse.vue` now searches. Browse lists a saga *and* the films on it, because both are true
  answers to one search; a ranked shelf rolls those films up into the saga instead, or one saga fills a
  ten-item row with nine of its own entries. One definition of *film* (`whereFilm`), two decisions about
  what a **shelf** should contain — the second is composition, not a second answer to the first.
- An episode's score counts towards **every** collection it is in. `CollectionVideo` is many-to-many on
  purpose, and there is no honest rule for picking one parent.
- Scores **total** for views and take the **max** for recency. Summing timestamps would rank a long-running
  show above a newer one for having more episodes, which is not what "recently added" means; a show *is* as
  recent as its newest episode, which is why a new season resurfaces it.
- `TRENDING` ranks on **seconds watched** in the window, not on plays. Counting distinct `playSessionId`s
  needs a row per session and scores a bounce level with a film watched through.
- Ties break on **id**. They are the norm rather than the exception — every entry in a fresh trending row
  scores the same — and a shelf that reshuffles between requests reads as a rendering bug for weeks.
- `ROW_SOURCE_SPECS` (in `packages/shared`) is the **one** table saying which settings a source reads, and
  the create schema, the service and the admin form all read it. A form offering a field the endpoint
  ignores is how those drift; a `windowDays` left on a row that stopped being TRENDING is the other half,
  which is why changing source clears what the new one cannot read.
- Items cannot be added to or reordered on a computed row — there is no items table behind one, so both
  would appear to succeed while doing nothing.
- A hand-picked row is filled from `RowEntryPicker`, which **searches the server** over collections *and*
  films — the same pairing `browse.vue` searches. It replaced a
  `USelect` over `/collections?limit=100`, which could not reach entry 101 at all and offered no films
  whatever, though `ListItem` has always had a column for one. It is deliberately **not** a `USelectMenu`
  with its search term bound to a refetch: `CreditsEditor` records what that does — replacing the options
  while the popover is open leaves it stuck open with its own search box focused, so the next thing typed
  lands in the search field. A plain input with results under it has no popover to get stuck.

**The catalogue** (`library/merge.ts` is pure; `library.service.ts` is the IO around it)
- `GET /library` is the union of the two things the library is made of — shelves and films — as one
  `Page`. It exists because `browse.vue` used to ask `/collections` and `/videos?film=true` separately and
  merge them in the browser, which **cannot page or sort**: each half was capped at 100, and the order was
  only ever right inside whichever window happened to load.
- Prisma cannot union two tables, so each side is queried and merged in memory. Deliberately **not** raw
  SQL: `whereFilm(role)` carries the orphan rule — a video whose every collection is hidden is not a film
  for that caller — and restating the most delicate rule in the codebase in a second language is how one
  copy of it quietly stops being true. Every filter here composes `whereFilm`, `whereVisible` and
  `narrowToVisibleStates` rather than re-deriving any of them.
- **Neither side may `skip`.** Row 1 of one table can be row 1 or row 900 of the merged order, and nothing
  short of looking says which, so the offset is applied after merging. `perSideWindow` takes
  `offset + limit` from each side, which is exactly enough: the first `offset + limit` rows of a merged
  order can only have come from the first that many of each source. That is also what `MAX_LIBRARY_OFFSET`
  bounds — the work scales with the offset, so an unbounded one reads the library several times over.
- **The sort key is `normalisedTitle`, not `title`**, and that is load-bearing. A page boundary is decided
  by the SQL order and the JS comparator *together* — the database picks the candidates, the merge picks
  the cut — so the two must agree, and `localeCompare` applies ICU rules no Postgres collation shares.
  A normalised title is lowercase ASCII alphanumerics, where they coincide. Checked rather than assumed,
  because the database is `en_US.utf8` rather than `C`: real-shaped titles (`10things`, `a1`, `ab`,
  `se7en`, `seven`) sort identically in both, as does `normaliseTitle`'s fallback for a name with no Latin
  alphanumerics, since glibc drops to code-point order there. The one live divergence is **astral-plane**
  characters — Postgres orders by code point, JS by UTF-16 code unit — which could show an emoji-titled
  film on the wrong side of a boundary. Not worth teaching this file a collation for.
- `LIBRARY_SORTS` declares the Prisma `orderBy` and the comparator **in one table**, so a sort cannot be
  changed in one place and not the other. Every order ends in the entry's kind and id: the two tables
  number themselves independently, so ties are the norm rather than the exception.
- A **collection sorts before a film** on an equal title. A saga and one of the films on it genuinely share
  a name, both are right answers, and the shelf is the more general one. Postgres cannot express it — each
  query sees one kind — so it is the one comparison that exists only in `merge.ts`.
- `kind` **partitions** the grid rather than filtering half of it away: `FILM` is the films *and* the
  shelves holding no seasons (a saga of eight films is films, and its chip says so), `SHOW` is the shelves
  that do. Between them they cover everything, so nothing becomes unreachable the moment the filter is on.
  There is no `kind` column and there must not be — it is a fact about the seasons behind the join.
- Searching matches **cast and crew**, not just title and description — every one of them is a `Person` row
  created on import precisely so a name can be looked up. A film also matches on the credits of a shelf it
  stands on, because `credits/merge.ts` shows those on its page: searching less than the panel displays
  means a cast member you can plainly read is one you cannot find. Both nested reads carry
  `whereVisible(role)`, or a draft episode's credit becomes a way to learn who is in something unpublished.
- On the film side the search `OR` goes **inside** `whereFilm`'s `AND` array, never beside it. Two `OR`
  keys spread into one object leave only the last — the same trap `films.ts` documents from the other side.
- `genre` narrows with `hasEvery` and is repeatable; `tag` stays a single value, because the chips on a
  collection page link here as `?tag=…` and those links keep meaning what they meant. The two vocabularies
  stay apart for the same reason the columns do.
- `GET /library/genres` tallies in memory rather than in SQL. Unnesting an array column needs raw SQL, and
  that would mean a second copy of `whereFilm` again; one narrow column off a private library is the
  cheaper thing to spend. If it stops being, `unnest` goes here and the endpoint's shape does not change.

**Imported metadata** (`metadata/tmdb.mapper.ts`, `crew-role.ts`, `diff.ts` are pure; the client is the seam)
- **The source is TMDB, not IMDb.** IMDb has no public API and its terms forbid scraping. TMDB returns the
  IMDb id for titles and people, so the deep-links still work and are sourced legitimately.
- **Search, preview, apply, with a person in between.** That gate is the whole provenance story: there is
  deliberately *no* per-field source column anywhere, because somebody looked at a diff and ticked boxes.
  An importer that wrote on its own would need one on every column it touches.
- The descriptive columns live on **both** `Collection` and `Video`. A film here is a video belonging to no
  collection, so putting them only on the collection leaves half the library unable to carry any of them.
  `Video.year` exists for the same reason and is editable by hand, not only by an import.
- **A proposal with nothing to say about a field never empties it** (`diff.ts`). TMDB not knowing a tagline
  is not a reason to delete the one somebody wrote, and without the rule, ticking everything on a
  well-curated title empties half of it. The rule is enforced twice — in the diff and again at the write —
  because the second is what a stale preview would otherwise get past.
- The **title** is the one field never ticked by default. It is usually the first thing an admin fixes, and
  a slug does not follow a rename, so an accepted rename leaves the shared link and the name disagreeing.
- Any title an import writes goes through `titleUpdate()`, or `normalisedTitle` rots and the "already in the
  library?" matching behind `/requests` silently stops seeing the row.
- TMDB writes **`""`, not null**, for everything it does not know. `new Date('')` is an Invalid Date that
  survives all the way into a column, and an empty tagline is a blank line under the title. Television also
  renames the same ideas — `name`, `original_name`, `first_air_date` — so reading only the film spelling
  gives a show with no title and no year and **no error**.
- `vote_average` is `0` for anything nobody has rated. Stored, that is a confident "0.0 ★" on every obscure
  title, so a rating with no votes behind it is dropped.
- `crew-role.ts` matches **whole job strings, never substrings** — the same trap as release-tag stripping.
  TMDB's crew is full of jobs *containing* a key one ("Assistant Director", "Second Unit Director", "Music
  Editor", "Casting Director"), and a loose match puts the first assistant director's name at the top of
  the panel. Everything unmapped becomes `OTHER` **and keeps its `jobTitle`**.
- **Every cast and crew member is stored; the panel trims.** A person row that was never created can never
  be searched for, and `GET /people/:slug` already returns a filmography. `MAX_CREDITS` is 500 and the whole
  list arrives in one response, so collapsing is purely a rendering decision.
- Because all but six jobs collapse to `OTHER`, a credit's identity is `(personId, role, jobTitle)`. On
  `(personId, role)` alone somebody credited as Costume Designer on a show and Stunt Coordinator on an
  episode **collides with themselves** and the show's credit vanishes from that episode — `mergeCredits`
  keys on the job title for exactly this. Acting credits have none and key as they always did.
- A re-import is **additive**: it never rewrites `Credit.position`, which is dragged into place by hand, and
  never deletes a credit an admin added.
- `PeopleService.resolveMany` exists because the per-row path cannot do this — `create` loads *every*
  person's slug and probes for a duplicate name separately, so a 250-credit film is 500 queries and 250
  full-table scans. It also adds each new slug to its own snapshot, or two people named the same in one
  cast both take the same slug.
- **A person's IMDb id is not returned with credits.** It is `/person/{id}/external_ids`, one request each,
  so resolving eagerly costs 250 requests per film for links most people never click. They fill in behind
  the read on the same in-memory queue `MediaService` uses for probes, and `imdbCheckedAt` records the ask
  so somebody who genuinely has no id is not asked about on every page view.
- `TmdbError` is an **`HttpException` (502), not a plain `Error`**. As a plain Error it became a 500
  "Internal server error" and the one message an admin could act on never left the process. 502 because the
  failure is upstream. (Shipped that way; caught the first time the page was opened in a browser.)
- The **token never reaches a message or a log line**. A fetch failure can carry the request and the request
  carries the token, so failures are described rather than interpolated — same reason `FfmpegError` drops
  the command line.
- Artwork goes in as `MANUAL`, reusing `ArtworkSource`, so the next reprobe cannot replace a real poster
  with a frame grabbed 10% into the file. The preview *says* it would replace hand-chosen artwork rather
  than skipping quietly.
- Everything that talks to TMDB happens **before** any write. Holding a transaction open across a network
  call ties a database connection to somebody else's latency.
- Episodes are matched on `orderIndex` within a season. An episode with none is one ingest could not number,
  and guessing would put the wrong synopsis on the wrong episode — it is left alone.
- Genres are their own column, never `tags`. `tags` is curator-authored, and sharing one column means a
  re-import cannot tell which entries it owns and may replace.
- The imported fields are **editable by hand**, which means each one appears in the zod schema *and*
  in `update()`'s `data` block. A field added to only the first is silently dropped and the PATCH still
  answers 200 — `library.db-spec.ts` asserts the round trip for every one of them, not the status.
- `imdbIdField` parses rather than validates, like `trailerField`: an admin pastes
  `imdb.com/title/tt…/?ref_=nv_sr_1`, and `parseImdbId` (in `packages/shared`, beside `parseYoutubeId`)
  normalises it. Titles are `tt` and people are `nm`, and the two are **not** interchangeable — a person
  id in a title field is refused rather than stored to become a dead link that looks deliberate.
- **Unmatching clears only `tmdbId`/`tmdbType`/`metadataUpdatedAt`.** Every descriptive field stays: an
  admin approved those one at a time, and "this is not that title" is not "throw away my work". It
  exists because the 409 already told people to unmatch and there was no way to.
- The credits panel collapses to the **cast plus one line of crew** (`headlineCrew` in
  `app/utils/credits.ts`, pure). Capping only the cast left seven role headings each holding one chip,
  which took more room than the cast did. The line **deduplicates names within a role**: Story and
  Screenplay both map to WRITER, so a writer credited for both was named twice in one breath.
- `CreditsEditor`'s person picker **searches the server**. It filtered `/people?limit=100` in the
  browser on the reasoning that a private library's cast list is small; one import made it 111, and 100
  is `MAX_PAGE_LIMIT`, so the people the import had just created were exactly the ones that could not be
  picked. Still a plain input with results underneath, never a `USelectMenu` — see the note above.
- Its reorder arrows are **hidden while a filter is active**. `move()` works on positions in the whole
  list, so "down" in a filtered view means a place the reader cannot see.
- Both admin forms re-seed from the record when **`updatedAt`** changes, not on every refresh and not
  once at setup. The collection's seed-once meant an import refreshed the page while the form still held
  the old values, so Save wrote them back over the import; the video's `watchEffect` threw away whatever
  was being typed. One rule fixes both, and imports made refreshes frequent enough to matter.

**Requests** (`requests/serialize.ts` is pure; `packages/shared/src/title.ts` is the comparison key)
- `toRequestView` is the **only** thing between a request row and the name of whoever wrote it. Non-admins
  get the title, year, comment, status and admin note — hiding those would leave a page listing nothing —
  and never `requestedBy` or `statusChangedBy`. It is built field by field rather than spread from the row,
  so a column added to `VideoRequest` later cannot ride along into a viewer's response; `serialize.spec.ts`
  pins the exact key set for that reason. `mine` is the deliberate exception: it tells you which entry is
  yours, which you already knew, and without it a page that has hidden every name has also hidden yours.
- The existence check is scoped to **`whereVisible(role)`**. Refusing a USER because a DRAFT matches would
  tell them the draft exists — the leak the whole visibility rule exists to prevent. Their request is
  created instead, and the admin (who can see both) gets a `libraryMatch` hint putting the two side by side.
  That hint is computed over the *whole* library, so handing it to a non-admin undoes the same protection.
- `normalisedTitle` on `Video` and `Collection` is derived from `normaliseTitle()` and written **only**
  through `titleData()`/`titleUpdate()` in `common/title.ts`. A derived column is worth nothing while it
  disagrees with its source, and the way that rots is a new write site setting `title` alone.
- It is deliberately **not** the slug. A slug is stable once created and drifts away from the title it came
  from, so matching on one would miss every record that was ever renamed.
- `normaliseTitle` drops a **trailing bracketed** year (`The Matrix (1999)`), never a bare one — `Blade
  Runner 2049` and `2001: A Space Odyssey` *are* their numbers. It keeps leading articles: dropping them
  matches `The Thing` to `Thing`, which is usually right, and `The Others` to `Others`, which is not, and a
  false match refuses a legitimate request. It never returns `''` for a title with any content, because `''`
  is the "not comparable" sentinel that an unbackfilled row holds and that must match nothing.
- One **open** request per normalised title, enforced by a hand-written partial unique index
  (`WHERE status IN ('NEW','SEEN','PROCESSING')`) that Prisma cannot express — re-append it if the migration
  is regenerated, like the polymorphic CHECK constraints. The service **catches** the violation rather than
  checking first: check-then-write has a gap and two people submitting the same title land inside it.
  Reopening a settled request while another is open hits the same index, and that is not a fault.
- Asking again for something rejected a year ago is a fair question, which is why the index filters on
  status rather than being unique outright.
- `adminNote` omitted leaves the stored note alone; an explicit empty value clears it. Without that
  distinction, moving a request from SEEN to PROCESSING silently discards the explanation attached to it.

**Parsing** (`ingest/path-parser.ts`, `ingest/subtitle-matcher.ts` — pure, no filesystem)
- `parseMediaPath` returns `storageKey` **verbatim**. Reconcile is keyed on it, so normalising the path here
  would silently break move detection.
- A dot on **any** segment hides the whole branch, not just a file — upload staging is `<drive>/.uploads/`.
- The collection-or-not decision cannot be made one path at a time, which is why `structure.ts` exists: "one
  video in a folder" and "two videos in a folder" differ only in what else is there.
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
- Prisma cannot express **partial (filtered) unique indexes** either, and there are now **two**. `VideoRequest`
  needs `UNIQUE ("normalisedTitle") WHERE status IN ('NEW','SEEN','PROCESSING')`; `CuratedList` needs
  `UNIQUE ("source") WHERE source IN ('CONTINUE_WATCHING','MY_LIST')`, which is what stops a second personal
  row being the same shelf twice. The same warning applies to both — re-append them.
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
  Regeneration is an explicit `regenerateSlug: true`. Collections and **videos** are unique library-wide —
  a video is addressed at `/v/<slug>` on its own, so there is no collection for a scope to mean — and
  seasons only within their collection.
- A video belongs to any number of collections through **`CollectionVideo`**, which carries `seasonId` and
  `orderIndex`: those say where it sits *in one collection*, and the same episode can be episode 3 of a show
  and item 1 of a best-of row. `seasonId` must belong to `collectionId`; Prisma cannot say that across a
  relation, so the service does. Deleting a collection takes its seasons and memberships and **leaves the
  videos standing** — a shelf is not the books.
- Every "which collection" filter on `GET /videos` is built as **one** clause (`membershipFilter`). They all
  constrain the same relation, so spread separately they overwrite each other rather than combining —
  `?collectionId=X&seasonId=Y` silently dropped the collection and answered about the season alone.
  `?film=true` is the odd one: it is a fact about the *seasons behind* the join, so it is `none`/`some`
  across two relations and cannot be folded into that membership object at all. There is no column saying a
  video is a film, and there must not be — it is a fact about the join, and a column would be a second
  answer to drift. It is returned under **`AND`**, not as bare keys: the clause contains an `OR`, `?q=`
  builds another, and two `OR` keys spread into one object leave only the last.
- **A film is a video that no season-holding collection claims** (`common/films.ts`). Seasons are the only
  thing in the model that says "instalment of something": ingest turns season folders into a collection
  *with* seasons and a folder of eight films into a collection with none. It used to mean "a video in no
  collection at all", which made every film on a shelf unfindable — the shelf was one card and the films
  were on it, so they were nowhere. Deliberately **not** "the membership has no `seasonId`": a special filed
  straight under a show is an extra of that show, and a null season says only that nobody filed it. The
  season half is **role-blind** — a video that is an episode of a show one caller cannot see and an item on
  a shelf they can is not a film for anybody, and narrowing that half per role could only ever leak.
  `?film=false` is the rule's opposite (the episodes), **not** `whereFilm`'s complement, which would make it
  a way to enumerate the episodes of shows the caller cannot see.
- The word `standalone` survives in `ingest/structure.ts`, `uploads.service.ts` and `admin/media.vue`, where
  it still means the true, different thing: a folder holding one video becomes no collection. Leave it.
- `Collection.seasonCount` is **TMDB's** count of the whole show; `seasonsHere`/`videosHere` on the API
  response count our own rows. Two numbers is what makes "3 of 5 seasons here" a sentence, and it is the
  second that decides whether a shelf is a series or a saga of films.
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
- A video is shown at **`/v/<slug>`**, its own page. `videoPath` therefore cannot return null any more — it
  used to, for a video that arrived without a collection, which is now simply what a standalone film is.
  `/c/<collection>/…` still resolves so shared links do not rot, and redirects a video to its canonical URL.
- `videoPath` (`/v/<slug>`, describes) and `playPath` (`/watch/<slug>`, plays) are picked between on a rule,
  not by feel: **inside a collection it plays** — an episode row, a collection's grid, the "more from"
  shelf — as do Continue Watching and History, because the choice was already made. **Browse, My List and
  curated rows describe**, because there the question is still what to watch. `videoPath` was called
  `watchPath`, which named the one route it does *not* build while `playPath` sat beside it building exactly
  that; every bug here is "which of the two did I call", so the names have to point at their own routes.
- **`browse.vue` lists collections *and* films**, merged into one grid. It listed only collections, so a
  film could never appear there however often it was published — a folder of eight films is one shelf, and
  the films are *on* it rather than on none. Reported twice: "I published it and browse does not show it",
  then "browse does not return individual movies when they are part of a collection". Episodes stay out
  deliberately: they are reachable through their show, and listing them would bury four films under forty
  episodes of one of them. It asks **`GET /library`** for both halves at once; it used to fetch
  `/collections` and `/videos?film=true` separately and stitch them together here, which is why the merge
  moved to the API — see **The catalogue** above.
- Every filter lives in the **URL**, mapped by `app/utils/browse-filters.ts` (pure, specced). A narrowed
  library is something you share and come back to, and none of that survives state held only in a `ref`.
  The search box is the one control that types locally, debounced 250ms into the URL. Changing any filter
  resets `offset`, or narrowing while on page seven lands on an empty page that looks exactly like an empty
  library.
- The genre control is filled from **`GET /library/genres`**, never a hardcoded list: `genres` is free text
  as far as Postgres is concerned, so a control offering a vocabulary the library does not use is a control
  that mostly returns nothing.
- A saga and the films on it **both** match one search, on purpose — two different right answers — and the
  count chip is what separates them. `collectionChip` (`app/utils/kinds.ts`) says what a shelf holds
  ("1 season", "8 films", "Collection" when empty); a film carries **no** chip, because most of the library
  is films and a chip on every card distinguishes nothing. It renders **bottom-left** of the poster: the
  top-right is the publish state and quality, and the top-left is My List's remove button — the only way
  off that list, and not worth displacing for a chip.
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
- Artwork is `GET /{videos,collections}/:id/{poster,banner}`, which **revalidate** (`ETag` +
  `private, no-cache`) rather than carrying a lifetime. The storage key is stable across replacements, so
  any `max-age` above zero serves the poster an admin has just replaced.
- **Posters go on cards, banners go in wide slots.** `MediaCard` shows 2:3 everywhere — home shelves,
  browse, My List, a collection's grid — and the exceptions are `EpisodeRow` (inside a show you are
  choosing a moment, not a title) and every `HeroBackdrop`. `MediaCard`'s `shape` prop existed for months
  with **no caller ever passing it**, so every card rendered 16:9 and half the design was dead code; a
  wrong shape fills its box and merely looks badly framed, which is why `viewer.spec.ts` asserts the
  *request* rather than the rendered element.
- Card hover is a **border**, never an overlay. A centred play/info glyph covered the one thing a card
  exists to show, on the card being pointed at. Removing it has to delete the element, not hide it —
  `visible.spec.ts` fails a control that is `opacity: 0` and still focusable.
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
- **A media event can fire before hydration too, and nothing replays it.** On a hard load the `<video>` and
  its `<source>` are in the server-rendered HTML, so the browser starts fetching before Vue attaches
  `@loadedmetadata` — the event lands on nothing. `VideoPlayer` therefore *asks* in `onMounted`
  (`readyState >= 1`) as well as listening, and `onLoadedMetadata` is idempotent because both can happen on
  one load. Without the ask, a refresh of `/watch/:slug` opens at 0:00 while clicking through to the same
  page resumes correctly — and every test that reached the player by clicking a link walked past it.
- **The player resumes; it does not offer to.** `resumePoint` (`app/utils/resume.ts`) is the one rule for
  where playback opens, shared with `/v/:slug` so the second named on "Resume from 12:34" is the second it
  lands on. The seek must set `lastTick`, or `onTimeUpdate`'s first delta credits the whole resume offset as
  time watched. What is offered instead is **"Start from the beginning"**. Nothing announces the position in
  words — the player's own timeline sits directly under the button already saying it.
- **The offer's timer is the `offer-wipe` animation in `main.css`, not a `setTimeout`.** Grey sweeps across
  the button and `@animationend` is what removes it, so there is one clock rather than two to drift apart,
  and hover/`focus-within` pausing the sweep pauses the disappearance exactly with it. It is drawn as an
  animated **background image**: a positioned `::before` paints above in-flow content, so it would cover the
  label instead of passing behind it, and the label is a bare text node that cannot be given a `position` to
  lift it back out.
- **That animation is exempt from the `prefers-reduced-motion` reset**, and the exemption is load-bearing.
  The blanket `animation-duration: 0.01ms` would end the sweep on its first frame and take the control with
  it, leaving those viewers no way to restart a video at all. Removing the exemption as tidy-up reintroduces
  exactly that.
- The sweep's grey is measured against the **button's** foreground (7.2:1), not against the page, so none of
  the `:root` tiers describe it. `visible.spec.ts` cannot check it either — it reads an element's computed
  background and never sees a background image — so that pairing is verified by hand. Paint it on a canvas
  to measure it: that foreground computes to `oklch(...)`, and parsing those three numbers as r/g/b reports
  a confident 2.97:1 for a pairing that is really 7.2:1. The palette trap in `visible.spec.ts` is the same
  one, and it catches people writing *new* checks, not just the old one.
- Playback opening past 0:00 is now normal, so a test about anything *positioned* — intro markers, outro
  markers — must anchor to where the player actually opened rather than assuming zero, and must assert
  against the marker rather than against `> 0`, which a resumed video satisfies before the button is pressed.
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
- **Never name a local binding after an auto-imported Vue API.** A parameter called `ref` in
  `admin/lists.vue` made the **production** build emit that page's chunk with no `import { ref }` in it, so
  `ref('')` called a free global and setup threw `ReferenceError: ref is not defined`. A component whose
  setup throws renders **nothing**, so the screen was a blank content area inside an intact admin sidebar —
  no heading, no error, nothing to click, and an API and database that were both fine. Isolated by building
  it each way round: the name of the *template's* arrow parameter makes no difference (it is minified away,
  and both builds are byte-identical); the *script* binding is the whole of it. `auto-imports.spec.ts`
  parses every SFC for this and is verified by mutation. It is parsed rather than grepped because the two
  cases genuinely differ and a regex cannot separate them — `{ watch: [q, tag] }` in `browse.vue` is an
  option key and is fine, `(row, ref: T)` is a binding and is not.
- **`npm run dev` and the browser suite cannot see a production-only build fault.** The one above appeared
  solely in `nuxt build` output, and `apps/web/e2e` runs against the **dev servers** — so its `pageerror`
  watchdog, which is exactly the right assertion, never ran against the code that was broken. Anything that
  depends on how the bundle is *built* needs either a source-level check or a run against `.output`.
- A blank screen and an empty library must not look alike. `useApiData` returns `null` for both a failed
  request and no results, so a page that destructures only `{ data }` renders an outage as "No rows yet" or
  "Nothing here yet" — which sends whoever reads it looking in entirely the wrong place. Take `error` too
  and check it **before** the empty state.
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

**Rate limiting** (`common/throttling.ts`)
- There is exactly **one** throttler, named `default`, overridden per route with `@Throttle({ default: … })`.
  Declaring several *named* throttlers reads better and is wrong: the guard evaluates **every** named
  throttler on **every** request, so a `credentials` bucket of 10/min governs the whole API, and
  `@SkipThrottle()` — which skips only the throttler literally named `default` — exempts one of them. The
  e2e tests caught this; browsing would have died after ten requests.
- Keys are `class + handler + throttler + tracker`, so each route counts separately. The tracker is the
  **signed-in user**, falling back to IP. IP alone throttles a whole household behind one NAT and misses one
  account misbehaving from several addresses; this library is invite-only, so almost every request has an
  identity. The IP fallback is what covers `/auth/login` and `/auth/redeem`, which have no session yet.
- Streaming, video thumbnails, collection posters, subtitle tracks and `/auth/me` are **exempt**, and must
  stay exempt. One `<video>` issues a range request per seek and a shelf issues a poster request per card —
  a limit there protects nothing and breaks playback. `throttling.e2e-spec.ts` asserts this by hammering
  each one past every bucket, because a decorator on the wrong method is exactly the mistake worth catching.
- The heartbeat limit is the one `watch/progress.ts` was written expecting: capping `deltaSec` at 30s stops
  one bad number rewriting a total but is explicitly **not** a rate limit, since a client beating in a loop
  still accumulates real seconds.
- The browser suite signs in **once** (a Playwright setup project writing `storageState`) rather than per
  test. Fifty logins in seven minutes from one address is not what a person does, and it trips the login
  limit — the suite was wrong, not the limit. It also cut the run from 7.5 minutes to 2.3.
- `helmet`'s CSP is deliberately **off**. A CSP describes what a *document* may load; this server returns
  JSON and media and never a document. Setting one here would be a header nobody enforces, which reads like
  protection. `crossOriginResourcePolicy` is `same-site`, not the stricter default, or the browser on :3000
  blocks every poster served from :4000 in development.

**Access control**
- **A description is never required to publish.** It was, and it made the library unpublishable: ingest
  cannot write a synopsis, so every episode needed a person to type one before *any* could go out — and
  because a collection needs at least one publishable video, the collection was blocked too, reporting
  a missing `videos` while plainly holding five. What is required is what a probe produces on its own:
  a title, a real duration, a banner. Reported as "why can't I publish collections".
- **`publishableVideoCount` has exactly one definition.** There were two and they disagreed: `publish()`
  counted the videos that were *ready* while the read that draws the admin's checklist passed the
  total, so the screen reported a collection ready and the button refused it. Both call the one helper
  in `common/publishing.ts`, which also feeds the count the publish confirmation names — so the dialog
  cannot promise something different from what happens. Already-published videos count, or
  re-publishing a collection whose episodes went out individually reports an empty shelf.
- `POST /collections/:id/publish?cascade=true` takes the collection's **ready** videos with it in one
  transaction. That is what makes a freshly ingested show publishable without editing every episode.
- **`update()` builds its `data` field by field**, never by spreading the DTO — so a column added later
  cannot be written by anyone who guesses its name. The cost is that a *new* field is silently dropped
  until it is added there too, and the PATCH still answers 200 with a response that looks right. That
  happened with `trailerYoutubeId`; `library.db-spec.ts` now asserts the round trip rather than the
  status code.
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

**Deployment** (`Dockerfile`, `deploy/`, `.github/workflows/` — see [`deploy/README.md`](deploy/README.md))

- `TRUST_PROXY` must be set behind a TLS-terminating proxy, and the failure without it is silent.
  The session cookie is `secure` when `NODE_ENV=production`, and express-session refuses to *set* a
  secure cookie unless it believes the connection is HTTPS — which it only does when `trust proxy`
  lets it read `X-Forwarded-Proto`. `/auth/login` then answers **200 and sends no cookie**, which
  reads as "my password stopped working". Verified both ways: with the header, `Set-Cookie … Secure`;
  without it, a 200 and nothing. It also fixes throttling, which otherwise keys `/auth/login` on the
  proxy's address for every visitor on earth.
- Traefik routes `/api` on the **web** hostname straight to the API, bypassing Nuxt. Not a
  micro-optimisation: **Nitro's proxy buffers the whole request body in memory**, and
  `streamRequest: true` does not prevent it on the node-server preset — h3's `getRequestWebStream`
  falls back to `readRawBody`. Measured: a 600 MB upload grew the web container ~575 MB and
  OOM-killed it at a 256 MB limit; via Traefik the same upload peaked at 55 MB. Uploads are capped at
  2 GB. The route rule stays for SSR, which is small JSON in-process.
- **`NUXT_API_TARGET` is baked in at build time**, not read at runtime — Nuxt freezes it into the
  Nitro bundle's route rules. Setting it on a running container does nothing, which is why the API
  service is named `api` in every stack and the image is built with `http://api:4000`.
- `prisma generate` runs **before** `nest build` in the image: the generated client is gitignored,
  so it can never arrive in the build context. `prisma` and `dotenv` are *runtime* dependencies of
  apps/api rather than dev ones, so `--omit=dev` leaves the entrypoint able to run
  `prisma migrate deploy` and `prisma.config.ts` able to load.
- The production install is `npm ci --omit=dev -w @video/api --include-workspace-root`. A bare
  `--omit=dev` at the root installs *every* workspace's production dependencies, dragging Nuxt and
  ~300 MB into the API image.
- The entrypoint pins `PRISMA_SCHEMA_ENGINE_BINARY` by glob. Left to resolve the engine itself the
  CLI probes `@prisma/engines` for write access, which a non-root container against a root-owned
  `node_modules` fails — reporting *"please make sure you install prisma with the right permissions"*,
  which describes a broken install rather than the unwritable directory it actually found.
- `/state` is created **in the image**, owned by `node`. Docker seeds a fresh named volume from the
  image's directory including its ownership, but creates the mount point root-owned when it does not
  exist — and the bootstrap token write then fails with `EACCES` on first boot. Bind mounts are never
  chowned by Docker at all, so `MEDIA_PATH` and `DERIVED_PATH` must be `chown 1000:1000` on the host.
- Alpine is wrong for the API image: `@node-rs/argon2` ships prebuilt **glibc** binaries. The runtime
  image also needs `ffmpeg`, which is most of its size.
- **The pipeline stops at GHCR — nothing deploys.** `build-dev.yml` is a manual
  `workflow_dispatch` (GitHub's "Use workflow from" dropdown is the branch picker) and pushes two tags
  per image: the moving `<image_tag>` and an immutable `<image_tag>-<short sha>`, both derived from
  the input so `prd` needs no second workflow. Putting a build on the server is Portainer → Update the
  stack with **Re-pull image** ticked, which is *not* feature-gated.
- **Do not add an automated deploy back without re-measuring.** A Portainer CE webhook redeploys a
  Git-backed stack only when the tracked *git ref* has moved, and says nothing when it has not: `204`
  in ~20ms, no pull, no recreate. This is easy to get backwards, because a call landing right after a
  merge *does* replace the containers — the git change carried the pull with it. Confirmed by
  Portainer's `ConfigHash` moving `b604e95f` → `1a28019c` across the one call that worked, and five
  minutes of no change on every call after. `?pullimage=true` and `?IMAGE_TAG=…` are **non-git** stack
  webhook features (`"repository" !== method` in the UI) and a Git stack ignores them; *Re-pull image*
  under GitOps updates is Business Edition (`featureId: STACK_PULL_IMAGE`). Deploying a *branch* never
  moves `main`, so a webhook would report success for work it never did — which is why the step was
  deleted rather than worked around. The two real options, if it ever becomes worth it, are recorded
  in `deploy/README.md` step 4.

## Conventions

- Pure logic (`path-parser`, subtitle matcher, `qualityLabel`, `needsConversion`) lives in testable functions
  with unit tests written **before** the code that calls them. These are the highest-risk, cheapest-to-test parts.
- Three test tiers, and the split matters: `*.spec.ts` (unit), `*.e2e-spec.ts` (HTTP, Postgres stubbed) and
  `*.db-spec.ts` (HTTP against a real `video_test` database). Anything whose correctness *is* a database
  guarantee — transactions, conditional updates, constraints — belongs in the third; a stub cannot lose a
  race. `test:db` fails loudly with no database rather than skipping, so it can never go green testing nothing.
- **`test:db` is not safe to run twice at once.** The database name (`video_test`) and the bootstrap-token
  paths (`/tmp/video-streaming-*-test.bootstrap-token`) are fixed, and every suite `TRUNCATE`s between
  cases — so two runs from two worktrees delete each other's fixtures and each other's master token. The
  failures look nothing like a collision: `/auth/redeem` starts answering **400 "That invite token is not
  valid"** (the other run redeemed it, or truncated it away) or the token file simply vanishes, and a whole
  green suite goes red on code that is fine. Give a parallel checkout its own database with
  `TEST_DATABASE_URL=…/video_test_<name>` — `test/db/global-setup.ts` already reads it — **and set
  `TMPDIR` to a private directory**, which fixes the token paths too: they are built from
  `os.tmpdir()`, and Node resolves that from `TMPDIR` on Linux. The two together are full isolation.
  Confirmed the hard way: a db tier run against a concurrent one from another worktree failed at
  `transcode.db-spec.ts` (a cancelled job's temp file) and then, on retry, somewhere else entirely —
  the same code passed 458/458 the moment both variables were set. **A db-tier failure that moves
  between runs is this, not your change.**
- `NUXT_DEV_PORT` and `NUXT_API_TARGET` exist for the same reason: :3000 and :4000 are hardcoded defaults,
  and a second checkout cannot start either server without them. Both default to the old values.
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
npm run test:all        # all three API tiers, in order — prefer this
npm run test -w @video/web              # vitest unit tests (web)
npm run test:e2e -w @video/web          # Playwright, against both dev servers
```

Prefer `test:all` over picking a tier. An API change can pass the unit and database tiers and break
the stubbed HTTP one — that is exactly how `onModuleInit` shipped with a broken `auth.e2e-spec`, and
it went unnoticed because the change had been "verified" with the other three suites.

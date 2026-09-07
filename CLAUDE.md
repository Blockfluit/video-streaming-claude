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
- `MEDIA_ROOT` (`media/`) holds source files and is watched. `DERIVED_ROOT` (`derived/`) holds posters,
  banners and converted VTT, and is **never** inside `media/` — generated output landing in the watched
  tree causes a watcher feedback loop.
- **The converted MP4 is the one exception**, and it is deliberate: it lives in `MEDIA_ROOT`, beside its
  source (`Heat.mkv` → `Heat.mp4`). A transcode is hours of CPU, not something regenerated on demand, and
  for a reclaimed video it's the only copy — so it belongs on the archival disk, not the scratch one.
  Consequence: a conversion needs headroom on the *source's* drive, and reclaiming now genuinely frees
  space there.
- What stops the watcher feeding on it is not its location but the column: **reconcile drops from its scan
  any path that is a row's `playbackKey`, or a live job's `outputKey`** (`ingest/converted-output.ts`,
  applied to the whole `ScanResult` — issues too, since a converted file beside a loose source parses as
  one). Sound only because of its partner invariant: **`playbackKey` is written to the row *before* the
  file appears at that path**, so reading rows *after* the scan cannot miss a conversion finishing
  mid-scan. Reverse either half and the library grows a duplicate row per conversion. Both ends carry a
  comment saying so.
- The filter is on **stored keys only**, never names. Skipping `Heat.mp4` because `Heat.mkv` sits beside
  it would silently swallow a real second file an admin dropped there — forever, unnoticed.
- `convertedKeyFor` never returns its argument. An `.mp4` source would otherwise map to itself, and ffmpeg
  truncates its output the moment it opens it, so the film would vanish before the encode read a frame;
  that case becomes `Heat.converted.mp4`. Collisions past that take `-2`, `-3` like uploads, checking the
  filesystem **and** both `storageKey`/`playbackKey` — but a reconvert excludes the row's own key, or it
  would pick a new name and orphan its previous output.
- The encode writes to a **dot-prefixed neighbour of its destination** (`.<stem>.converting-<jobId>.mp4`),
  not `derived/tmp/`: dot-prefixed so the scanner/watcher pass over a half-written file inside the watched
  tree, and in the destination's own directory so the rename is same-filesystem and atomic. Interrupted
  jobs are swept at startup — in `derived/tmp/` an orphan was dead weight; in a media folder it's
  gigabytes of the admin's disk.
- A **move does not take the converted file with it.** It's written once, beside where the source was at
  the time. Relocating it inside `reconcile()` would mean a cross-filesystem copy of gigabytes on the
  watcher's debounce path, with a crash window in every ordering ending in an unclaimed `.mp4`. Stranded
  costs tidiness; ingested twice costs the curation.
- Existing installs are moved by `POST /admin/jobs/relocate-conversions`, **not** a migration — SQL can't
  move a file, and these can't be abandoned like `derived/thumbnails/` was. Not a boot hook either:
  copying a library across filesystems with the bootstrap held open turns a slow start into a healthcheck
  restart loop. `playbackRoot()` keeps both layouts playable until it's run, and should be deleted after.
- **Every folder directly under `MEDIA_ROOT` is a drive** — a symlink to a physical disk in production. A
  drive is where bytes live, never a collection. Convention: `media/<drive>/<item>/<season>/file`; what an
  item folder *becomes* is decided by what's inside it (`ingest/structure.ts`) — season folders or two
  videos make a collection, a lone video doesn't.
- The scanner follows a symlinked directory at the **drive level only**. `readdir` reports one as neither
  file nor directory, so without this every disk is skipped and the scan returns an empty library rather
  than an error. Deeper symlinks stay unfollowed, and `MAX_WALK_DEPTH` still bounds the walk.
- A video **loose in a drive root** isn't ingested — it raises `LOOSE_DRIVE_FILE`. A drive holds unrelated
  things, so there's no folder to take a suggestion from and nothing to say whether it stands alone.
- The folder layout is only an **initial suggestion**. A proposal applies when a video is first discovered
  and never again — a move on disk follows the file and changes nothing else. Re-deriving would undo
  whatever an admin has arranged.
- `storageKey` = archival source. `playbackKey` = converted MP4, **also under `MEDIA_ROOT`**, beside the
  source. Streaming serves `playbackKey ?? storageKey`. Both are unique columns: two rows sharing one
  converted file is silent corruption rather than an error.
- Videos with `sourceDeletedAt` set and a valid `playbackKey` are **exempt** from the missing-file sweep,
  or reclaiming disk space marks the library `MISSING`.
- Every storage key is `path.resolve`d and confirmed inside its root before use (path traversal). Only
  `StorageService` joins paths. Containment is tested with `path.relative`, **never** `startsWith`:
  `/srv/media-backup` starts with `/srv/media` and is a different directory. Lexical, doesn't follow
  symlinks — roots are operator-controlled and the threat is a crafted key, not a hostile filesystem.
- `StorageService` refuses to start when `DERIVED_ROOT` resolves inside `MEDIA_ROOT` — that is the watcher
  feedback loop, checked at boot because it is configuration and configuration drifts.
- Writes go to a `.incoming` neighbour and are renamed into place, so a failed write cannot leave a
  truncated file for the watcher to ingest.
- Deleting a collection or season keeps its files unless `?deleteFiles=true`. Without the files gone,
  reconcile rebuilds the rows on the next scan — the default is the recoverable mistake, not the other one.
- **Creating a season creates a folder in `MEDIA_ROOT`**, which is what reconcile rebuilds the row from.
  Deleting a season removes its directory only when **empty** (`storage.deleteIfEmpty`, i.e. `rmdir` —
  check and action in one syscall, no race). An empty directory holds nothing to lose, and leaving it was
  what made a deleted season reappear on the next scan. A directory still holding something is left alone,
  so nobody destroys a film with the button that tidies an empty folder — that still needs `deleteFiles`,
  and the admin UI confirms by naming how many files go rather than asking "are you sure?".
- **Deleting a video always takes its generated output**, `deleteFiles` or not: poster, banner, subtitle
  tracks and the per-video `subtitles/<id>/` directory nothing else has ever cleaned up. It belongs to a
  row that no longer exists and is regenerated from the source, so keeping it only leaks unreachable
  files. The **source** under `MEDIA_ROOT` still needs `deleteFiles`, since reconcile can rebuild the row
  from it. Every key is collected **before** `video.delete`, since the cascade takes the row and its
  `Subtitle` rows together, leaving nothing to say what to remove afterwards.
- The **converted file** goes on that same unconditional path (`playbackKeysToDelete`, its own list since
  it lives in `MEDIA_ROOT`), and here it's load-bearing, not tidy: ingest skips it only because a row
  claims it, so leaving it behind means the next scan finds an unclaimed `.mp4` and rebuilds the deleted
  entry under a new id with none of its history.
- The exception is a **reclaimed** video, whose converted file is its only remaining copy — reclaiming is
  allowed precisely *because* the converted file replaces it. Sweeping it up as derived output would
  destroy a film through the "recoverable" button, so that one **refuses** and the caller must ask for the
  files. The admin UI offers only the destructive button there.
- A video's parent folder is deliberately **not** tidied, unlike a season's: a season row rebuilds from a
  *directory*, so an empty one must go; a video row rebuilds from a *file*, already gone, so an empty
  folder is inert — and a video's parent is often a season folder with a live `Season` row pointing at it,
  which `rmdir` would break the same way.
- Deleting a video **refuses while a job is `QUEUED` or `RUNNING`**. `MediaJob` is `onDelete: Cascade` and
  `JobsService` holds its running job in memory, so the delete leaves ffmpeg writing to a path whose row
  is gone, and the job's bookkeeping then fails against a row that no longer exists — including inside its
  own `catch`, where the rejection escapes unhandled. `QUEUED` counts too.

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
- Streaming serves `playbackKey ?? storageKey`, both from `media`, so the URL is unchanged before and
  after conversion and survives the source being reclaimed. (`playbackRoot()` still answers `derived` for
  a row left under the old `converted/` layout, until the relocation endpoint has run.)
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
- `Video.titleSource` is the same `AUTO`/`MANUAL` contract, one level up: a renamed file's `applyMove`
  re-derives `title` (and `normalisedTitle` with it) only while `titleSource` is still `AUTO`. Editing a
  title through `PATCH /videos/:id` is what flips it to `MANUAL`, and from then on a rename on disk
  leaves it alone — the same "an admin's explicit choice survives a routine rescan" rule as artwork, in
  the other direction of travel: the filesystem is allowed to drive the title until a person overrides
  it, but a person's title is never allowed to drive the filesystem. Collections and Seasons do not get
  this: their folder identity is taken once, at discovery, and deliberately never revisited afterwards —
  `applyMove` only follows the file, and does not touch which collections it belongs to — so there is
  nothing left for a `titleSource` on either of them to track.
- The poster crop is `crop=min(iw\,ih*2/3):min(ih\,iw*3/2)`, **not** `crop=ih*2/3:ih`. The latter reads
  correctly, works on every landscape file — which is most of a library — and then fails outright on a
  portrait one by asking for a crop wider than the source. Both dimensions must be capped by what the
  frame can supply. The `\,` are escaped for ffmpeg's filter parser, never for a shell.
- A **trailer** is stored as the 11-character YouTube **id**, never the pasted URL, parsed by
  `parseYoutubeId` in `packages/shared` so the form and the endpoint can't disagree on what's acceptable.
  Admins paste whatever's in the address bar — a watch URL with a playlist/timestamp, a `youtu.be` link,
  an embed URL — and interpolating that straight into an iframe `src` gives a player that silently shows
  nothing. Keeping the id keeps the embed URL a *rendering* decision (privacy host, autoplay, mute). The
  id pattern is **anchored**: a playlist id is 34 characters of the same alphabet, so an unanchored match
  finds something id-shaped inside one and plays a video that doesn't exist.
- The hero's trailer starts **muted** — not a preference: a browser refuses to start an unmuted video
  nobody asked for, and fails *silently*, iframe loaded and sitting there. Suppressed entirely under
  `prefers-reduced-motion`; nothing is requested from YouTube until it starts. The iframe must be
  `pointer-events-none`, or it swallows every click and the Play button underneath stops working the
  moment the trailer fades in — while the page looks perfectly fine.
- **The reveal is never gated on the player confirming anything.** `HeroBackdrop` mounts the iframe
  hidden and crossfades it in ~900ms after the iframe's `load`; it reveals *earlier* on
  `onStateChange / info: 1`, and retreats to the banner **only** on `onError`. Built the other way round
  once — hidden until confirmed, unmounted after four seconds of silence — real YouTube doesn't reliably
  answer that handshake, so every viewer got the banner and nothing else, on every title, and it shipped
  green because the browser suite's only stub always answered. **Silence means carry on; only an error
  means stop**, and `hero.spec.ts` now stubs all three (answers, silent, failing) for that reason.
- The "can't be loaded" fallback needs no timer: an embed that never fires `load` never reveals, so a
  blocked host or dead network leaves the banner where it is by construction.
- **`subscribeToPlayer` posts `listening` repeatedly**, not once. An iframe's `load` fires when its
  *document* arrives, before the player attaches its own `message` listener — a single message then
  lands on nothing and the embed never asks again, the likeliest reason the handshake was never heard.
  Bounded (~4s) and cancelled when the trailer is torn down.
- **The home hero rotates on a fixed interval**, not when a trailer ends — there's no ended signal
  worth relying on, so "play next when this finishes" would rest on the same silence that already cost
  the feature once. The interval is ~10s: nearly ten seconds of trailer now that it starts at once;
  shorter and the entry changes before its trailer has said anything, while opening a YouTube iframe
  every few seconds.
- The rotation stops for: `prefers-reduced-motion` (never starts — same rule as the trailer), a pointer
  resting on the hero or focus inside it, and an explicit pause button. An **open `TrailerModal` holds it
  too** — the hero can't turn over while somebody's watching this title's trailer in a dialog on top of
  it. A ✕ and `dismiss` emit on the hero are gone with the rest of its trailer controls.
- The rotation's dots are dimmed with a **colour**, never `opacity` — `visible.spec.ts` reports an
  interactive element under 0.35 effective opacity as invisible, and opacity multiplies down the
  ancestor chain. Inactive is `--ui-border-accented` (3:1); active is `--ui-primary`.
- They live in the hero's **text column**, under the call to action, not on the hero floor where they
  were first put: the home page is pulled up over its hero by `-mt-16`, so the bottom 4rem sits under a
  row heading — "Recently added" landed exactly on the pause button. The text column is the one place
  clear of that band at every width; the hero's old trailer controls sat bottom-right and are gone now.
- The browser suite runs with `reducedMotion: 'reduce'` in `playwright.config.ts`. Without it the
  auto-playing trailer puts a third-party iframe on `/` — visited by a dozen tests only for a base
  URL — where the response watchdog fails any 4xx in any frame and the run needs outbound internet.
  `e2e/hero.spec.ts` opts back out for the motion tests and stubs YouTube rather than reaching it.
- **A collection's artwork is derived, not stored.** Its own `posterKey`/`bannerKey` are the *admin
  override*; null means "not overridden", and it then shows its **first video's** picture by
  `MEMBERSHIP_ORDER`, falling back to a stock image only when empty. Deriving on read makes it follow the
  episodes instead of snapshotting something that rots. The inherited candidate goes through
  `whereVisible(role)` like every nested read — a published collection may hold draft episodes, and a
  draft's poster isn't published art.
- **The artwork routes never 404 for a missing picture.** Absent artwork is ordinary, and every card used
  to pay a round trip to be told so; the browser suite fails any 4xx, so one un-postered collection turned
  whole pages red. A row the caller may not see is still a 404 — the fallback must not turn an invisible
  video into a 200 that confirms it exists.
- The stock image is an **SVG built in code**, not a file. `nest build` copies TypeScript only, so a
  `.jpg` needs an `assets` entry in `nest-cli.json` *and* a Dockerfile `COPY`, and missing either fails as
  a 500 in production and nowhere else.
- `qualityLabel()` compares by **edge, not axis**: long edge against the tier's width threshold, short
  edge against its height threshold. Height alone hides the badge on most films (a 1080p film in 2.39:1
  is `1920×800`); either raw dimension against either threshold over-promotes portrait video (a 1080×1920
  phone clip clears QHD's 1440 on height alone). The edge comparison is what satisfies both intents.
- Badges render only at 1080p and above; below that, render nothing.
- `PATCH /videos/:id/markers` merges the patch onto the **stored** markers before validating. The editor
  saves one marker per click, so validating the patch alone would accept an end before a start it cannot
  see. A partial pair is legal — that is the state mid-edit — and the player ignores a range it cannot use.
- Markers are bounded by `durationSec` **when it is known**. An unprobed video still gets the ordering rules
  and the absolute 24-hour cap; refusing markers outright would mean a probe failure also blocks curation.
- `qualityLabel` lives in `packages/shared` — the API probes the dimensions, the web app renders the badge.
- ffmpeg and ffprobe are invoked with `execFile`, never `exec`. Every path reaching them came off a disk
  scan or a database row, so a filename containing `;` or `$(…)` must stay a filename.
- **There is no ffmpeg wrapper worth adopting** — checked, not worth re-checking. `fluent-ffmpeg` is
  formally **deprecated** and still depends on `async@0.2.9` from 2013; `fessonia` is abandoned;
  `@ffmpeg/ffmpeg` is WASM (wrong target); `bare-ffmpeg` targets Bare, not Node; `execa` is ESM-only and
  **fails under ts-jest's CommonJS loader**, where every API test runs (730 unit, 19 e2e, 605 db). The
  thin wrapper in `media/ffmpeg.service.ts` stays.
- **ffprobe reports failures as JSON**: `-show_error -of json` puts `{ "error": { "string": … } }` on
  **stdout**, even on a non-zero exit, and `promisify(execFile)` attaches that stdout to the rejection.
  It adds nothing to a successful probe, so it is always passed. Prefer it to reading stderr.
- The **encoder** has no equivalent — ffmpeg offers only text loglevels — so stderr summarising stays the
  fallback there. For progress, `-progress pipe:1` emits `key=value` lines, which is why step 12 must use it
  rather than scraping the status line.
- Failures go through `FfmpegError`, which keeps ffmpeg's diagnosis and drops the command line —
  `execFile`'s own message leads with the whole invocation, pushing the real cause past where
  `probeError` is truncated and showing absolute server paths to an admin. Absolute paths in ffmpeg's
  output are reduced to filenames for the same reason. stderr and the structured message **overlap
  without containing each other** — stderr adds the specific cause (`moov atom not found`) the
  structured message lacks — so the shared part is dropped and both halves kept.
- Thumbnails are written to `DERIVED_ROOT`, never the watched tree, and are **renamed into place** from
  `derived/tmp/` like a transcode. ffmpeg truncates its output on open, so capturing straight to
  `thumbnails/<id>.jpg` left the live poster missing for as long as the capture took — every card
  requests that URL, so a routine re-probe flickered artwork to a **404**, not a stale picture. Testing
  this needs a failure *after* the output is opened: pointing ffmpeg at an unreadable source fails during
  input parsing and never touches the destination, passing against the broken code too.
- A probe failure writes `probeError` on the row and moves on. One unreadable file must not stop a scan of
  two hundred, and the admin needs to see which file and why.
- **A poster failure is not a probe failure.** Thumbnail generation runs outside the probe's `catch` and is
  only logged: it used to sit inside, so a failed capture wrote `probeError` on a row whose probe had just
  succeeded, and the ingest list reported a file as broken while it played and edited perfectly well.
- **`captureFrame` checks that a frame was actually written.** ffmpeg exits **0** when the seek lands past
  the end — it says "Output file is empty, nothing was encoded" on stderr and writes nothing — so trusting
  the exit code left the *rename* to fail with an `ENOENT` naming neither the timestamp nor the file. A
  `NoFrameError` becomes a **400** on the capture endpoint, because the admin chose the moment.
- **A scan has no `awaitWriteFinish`; the watcher does.** A scan can read a file still being copied, and
  ffprobe reports the whole duration from an MP4's leading moov atom while bytes are still arriving — a
  994 MB film recorded at 8 MB had its poster sought 813 seconds in. Reconcile can't tell mid-copy from
  finished while it looks, so it notices **next time**: a row whose file has a different size or mtime is
  updated and re-probed.
- `needsConversion` does **not** fire on nulls from a failed probe — that would queue CPU-saturating work on
  a guess. The container check still applies, since it needs no probe.
- Probe/thumbnail run at concurrency 2 (cheap, IO-bound). Transcoding is separate and runs one at a time —
  it saturates a CPU, so running several makes them all slower rather than finishing sooner.
- **Nothing transcodes on its own.** A 200-file drop flags what needs converting and stops; an admin decides
  when to spend the CPU.
- Transcode output goes to a dot-prefixed neighbour of its destination and is renamed into place **only on
  success**. A partial file under its final name would be streamed to viewers, read by the next probe as
  finished, and — now that the output lands in the watched tree — ingested as a truncated video.
- The final name is chosen **after** the encode, not before. A three-hour transcode is easily outlived by a
  new file appearing in the folder, so a name reserved up front may be taken by the time it is used. The
  *temporary* name comes from the source stem and is stable throughout, which is what the encode needs.
- The row is updated **before** the rename, and rolled back to its previous values on failure (a reconvert's
  previous `playbackKey` is not null, so clearing it would strand the old file). Rename-first leaves a
  finished `.mp4` that no row claims in a watched folder — and the rename is exactly what wakes the watcher.
  Reserve-first leaves the column pointing at a file that appears milliseconds later: streaming 404s for an
  instant, `reclaimSource` refuses because it stats the file, and the delete guard is unreachable because
  `enqueue` will not convert a reclaimed video at all. Transient against permanent.
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
  never the absolute one. Matching a dot segment anywhere in the absolute path makes the verdict depend
  on where the library lives, not what's in it: a root under any dot directory ignores **itself**, so
  chokidar watches nothing — silently, with only the startup scan still working, so restarting the API
  "fixed" it every time. Every worktree checkout (`.claude/worktrees/<name>/media`) ran that way, which is
  how it was found. Segments split on the platform separator only, so a backslash stays a legal filename
  character.
- Only the **drive level** — a folder directly under `MEDIA_ROOT` — may be a symlink. `readdir` reports a
  symlinked directory as neither `isDirectory()` nor `isFile()`, so following it is explicit. Deeper links
  aren't followed and symlinked files aren't ingested; `MAX_WALK_DEPTH` bounds the drive case in case a
  link points back up its own tree.
- A symlinked drive resolves in the **container's** mount namespace, so a deployment must mount the
  target at the same absolute path the link names (`DISKS_PATH` in `deploy/compose.yml`). Bind-mounting
  `MEDIA_PATH` alone leaves `media/disk1 -> /mnt/hdd1/videos` dangling and the scan reports `ENOENT`
  against a disk plainly there on the host — the link was followed correctly, there was just nothing
  behind it. Mounting a disk *onto* `/media/disk1` instead doesn't work, since Docker resolves that mount
  point through the very symlink that's broken.
- A dangling drive is reported with the **target it couldn't reach**, not a bare errno — `ENOENT` alone
  sends an admin looking for a bug in the library rather than their mounts. That message prints an
  absolute server path deliberately: here it's the entire diagnosis, and the ingest list is ADMIN-only.
- Reconcile is keyed on `storageKey` and must stay idempotent — that is what stops uploads double-creating.
- Uploads stage in `MEDIA_ROOT/.uploads/` and are **renamed** into place, dot-prefixed so both the scanner
  and the watcher skip it — a partial or abandoned transfer is never a candidate for ingestion. The rename
  now crosses filesystems, because each drive is its own disk: `StorageService.move` catches `EXDEV` and
  copies to a **dot-prefixed neighbour** in the target directory before renaming, so a file still appears
  under its final name only once it is complete.
- **Upload places files and creates no rows.** It writes them into the shape the convention expects on a
  drive the uploader picks — a single file gets a folder named after it, a folder tree lands as given —
  and reconcile makes of them exactly what it would of the same folders copied there by hand. One rule for
  what the library is, not two. Attribution (`uploadedById`, `origin: UPLOAD`) is stamped afterwards on
  `storageKey`, or an upload would be indistinguishable from a copy.
- A directory upload's relative paths travel in a **parallel `paths` field**, one per file, since multer
  strips separators from `originalname`. Traversal segments are dropped **before** `sanitizeFilename`
  runs — it gives an unusable segment a fallback rather than an empty string, so filtering afterwards
  turned `../../escaped` into real folders called `upload`. (Caught by `uploads.db-spec.ts`.)
- multer uses `diskStorage`, never memory: a 2 GB file buffered in the heap takes the process with it.
- An upload is accepted on its **extension alone**. The `mimetype` a browser attaches comes from the OS
  registry, not the file — Windows reports `.mkv` as `video/x-matroska`, `video/mkv`, or nothing, so
  ANDing it with the extension check refused real MKVs. ffprobe alone can say whether a file is playable,
  and records `probeError` on the next pass; a mislabelled upload becomes a draft with a diagnosis.
  (Shipped as a bug.)
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
  whose file changed holds a tag those bytes can never produce again, and move detection for that row is
  broken permanently — silently and late: the file is renamed months later and isn't recognised as
  itself, so a second video is created and the original is swept to `MISSING`, stranding its title,
  artwork, markers, credits and watch history while the file sits in plain sight under a new name. The
  re-read branch is where this bit: a scan has no `awaitWriteFinish`, so any copy outliving one scan
  interval gets tagged half-written and re-read. Recompute on *any* change, not just size — the tag
  samples the first and last megabyte, which can be rewritten without the size moving. (Shipped as a bug;
  `ingest.db-spec.ts` pins both symptom and mechanism.)
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
- `deltaSec` is **capped** at 30s per beat, not rejected — the plan says "reject > 30", but a rejected
  beat throws away the resume position along with the excess seconds, and missing two beats is a normal
  network hiccup. The cap stops one bad number rewriting a total; it is **not** a rate limit, since a
  client beating in a loop still accumulates — that's what the heartbeat limit in `common/throttling.ts`
  is for.
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
  On a `(personId, role)` clash the **episode's** credit wins outright — more specific, and can carry an
  episode-specific character name. Role display order comes from `Object.values(CreditRole)`, never a
  hand-written array. The sort must be **total** (role, position, collection-before-video, name, id): the
  two parents number positions independently, so ties are normal.
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
- **My List** (explicit, per-user) and **curated rows** (admin-made, same for everyone) are deliberately
  different things, and Continue Watching is neither — it falls out of `WatchProgress`. All three land on
  the home page and are now **rows** (`CuratedList.source`) rather than two hardcoded above the third.
- Both list adds are idempotent by **catching the unique violation**, not checking first: check-then-write
  isn't atomic and a double-click lands inside the gap. The partial uniques enforce it.
- Whether something is *on* the list rides on the **per-caller** read a screen already makes —
  `inMyList` on `/videos/:id/stats` and `/collections/:slug/progress` (`common/watchlist.ts`), never the
  detail read describing the record. The button is right on the first paint with no extra request, and a
  payload describing a video stays the same for everyone. `GET /me/watchlist` deliberately takes no id
  filter: asking about one record would mean paging the lot. `AddToListButton`'s `saved` prop went
  unpassed by every caller for months, so the button offered to add things already saved.
- `nextEpisode` (pure) picks the first **unfinished** episode — covering resuming a half-watched one, not
  skipping one because a later episode finished — and returns to the first once the whole thing is done.
  A null `orderIndex` sorts **last**: it means "ingest couldn't tell", and treating it as episode zero
  offers an unnumbered extra ahead of a real episode one.
- Curated row items are visibility-filtered **per item**. A row is admin-made and can hold anything, so that
  filter is the only thing stopping a home-page shelf from advertising a draft. `includeHidden` does nothing
  at all for a non-admin.
- `DELETE /lists/:id/items/:itemId` is scoped to the list in the URL — an item id alone must not reach into
  another row.

**Home-page rows** (`lists/sources/rank.ts` is pure; `computed.ts` is the IO around it)
- **The home hero features what was recently added** (`app/utils/hero.ts`, pure). It reads the
  `RECENTLY_ADDED` row out of the same `/lists` response the shelves come from — so moving, renaming or
  hiding that row moves the hero with it. It reads **`shelves`**, not the raw rows: a `RECENTLY_ADDED`
  row resolving to nothing must not shadow the fallback, or an empty filter renders an empty hero.
- **No migration seeds such a row** — only the two personal ones are — so the hero falls back to
  `GET /library?sort=added`, the same recency answer `/browse` already sorts by. Without that fallback the
  feature does nothing on a fresh install, the install where it matters most. A browser run against a
  fresh database only ever exercises the fallback, and `hero.spec.ts` is the only thing covering the row
  branch.
- The hero carries **no description**. Neither card select has one and neither should gain one — a
  synopsis on the shared card shape is paid for by every card on every shelf, to serve three lines in
  one place. `trailerYoutubeId` is eleven characters and is on both, which is the distinction.
- A row is a **source, a kind, a limit and filters**. `MANUAL` reads its `ListItem`s; computed sources rank
  the library; `CONTINUE_WATCHING` and `MY_LIST` delegate to `WatchService.history` and
  `WatchlistService.list` rather than restating either.
- A computed row applies `whereVisible(role)` **while scoring, before the limit**. A manual row can filter
  afterwards since its pool is small and admin-chosen; a computed one can't, or asking for ten returns
  three because the other seven were drafts — reading as an empty library rather than a filter.
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
- **The sort key is `normalisedTitle`, not `title`**, and that's load-bearing. A page boundary is decided
  by the SQL order and the JS comparator *together* — the database picks the candidates, the merge picks
  the cut — so the two must agree, and `localeCompare` applies ICU rules no Postgres collation shares. A
  normalised title is lowercase ASCII alphanumerics, where they coincide. Checked, not assumed: real-shaped
  titles (`10things`, `a1`, `ab`, `se7en`, `seven`) sort identically in both. The one live divergence is
  **astral-plane** characters — Postgres orders by code point, JS by UTF-16 code unit — which could show
  an emoji-titled film on the wrong side of a boundary. Not worth teaching this file a collation for.
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
- **Search is recall then precision.** `candidates.ts` asks Postgres which rows *resemble* the text;
  `relevance.ts` (pure) decides what each is worth. This is the one place the catalogue writes raw SQL,
  made safe by **never crossing a relation**: each query asks one table about its own text and answers
  with ids — it doesn't know what a film is or who may see a draft. Every rule stays in Prisma in its
  existing shape, candidate ids standing where `contains` clauses stood. Resolving "this shelf matches
  because a video on it does" in SQL would restate `whereFilm` and **leak**: the shelf's own state passes
  visibility while the draft video's is never asked.
- The scores Postgres computes are **thrown away** — they decide only which rows survive
  `CANDIDATE_LIMIT`, never the order. Making SQL's similarity and the scorer agree would recreate the
  seam `merge.ts` guards, for nothing.
- `pg_trgm` indexes **both** `title` and `normalisedTitle`, neither redundant. Measured: "star wa" scores
  0.875 by `word_similarity` on `title` vs 0.222 by `similarity` on `normalisedTitle`. `title` keeps its
  spaces, answering word order and partial words; `normalisedTitle` is accent/case-folded, answering
  misspellings and accents — and is the only folded form that *can* be indexed, since `unaccent()` is
  STABLE rather than IMMUTABLE.
- The threshold is **0.3**, also Postgres's own default — pinning it with `set_config` is belt and braces.
  Measured, not guessed: the weakest true positive scored 0.4, the worst false positive 0.259.
- Fuzz never touches a **description**, and never a token of three characters or fewer. A synopsis is
  long prose where edit distance finds a near-match for almost anything, and three letters is two edits
  from most of the dictionary — `the` would find `she`. Junk results are worse than none.
- **A search reads a bounded pool whole; it cannot window.** `perSideWindow`'s argument assumes the per-side
  SQL order *is* the merged order, and a score Postgres never computed is not a column.
- **Every bound on a search falls in the order of the thing it is bounding, or it changes the answer.**
  The first version didn't keep this: it capped the read at `RELEVANCE_POOL` with a Prisma `take`, which
  falls in order of a *column* — for a search, the alphabet. A film called `Winter` sitting behind five
  hundred rows whose only claim was that word in a synopsis was found by Postgres, discarded before
  scoring, never shown — the feature failing outright, on where the title fell in the alphabet, so it
  looked intermittent. Now `CANDIDATE_LIMIT` is the only cut on the text route and falls by similarity;
  `LibraryService.searched` reads direct and indirect routes **apart**, and only the indirect one (cast,
  and a shelf reached through a video, both weighted below one) still carries a cap.
- Lowering `CANDIDATE_LIMIT` from 2 000 to `RELEVANCE_POOL` trades away recall on a **heavily filtered**
  library — `?q=drama&genre=Horror` now considers the 500 best resemblances rather than 2 000 — the right
  way round, since filters run after: a generous limit buys tail results for a narrowed view, at the cost
  of the top of the list on every ordinary search.
- Searching is keyed on whether there is a `q`, not on `sort === 'relevance'`: a search scores and
  drops unmatched rows whatever order it is then shown in, and a `q` meaning one thing under Best match and
  another under Title would be indefensible.
- **Search can run on Meilisearch** (`apps/api/src/search/`), and runs on Postgres when it does not.
  `MEILI_URL` unset is the default everywhere including every test tier, which is what stops the
  fallback rotting — it is not a branch kept for an outage, it is what a search *is* until somebody
  opts in. The engine answers the **recall** half only: `relevance.ts` still ranks and Prisma still
  decides who sees what.
- **An engine is asked about one table's own text and answers with ids.** No collection document holds
  the titles of the videos on it, and no title document holds the names of its cast — the leak the
  Prisma re-read *cannot* catch: a shelf found because a draft episode matched would pass every
  downstream filter on its own state. So the shelf-via-video route stays in Prisma with
  `whereVisible(role)` on the episode, and `documents.spec.ts` asserts the shape rather than trusting it.
  A stale index can only lose recall — `search.db-spec.ts` hands the service a deleted, drafted and
  renamed id and pins the answer each time.
- Index only what `relevance.ts` scores — title, description, genres. Recall the scorer throws away is
  worse than useless: it spends the candidate budget then drops the row. `originalTitle`, `tags` and
  `tagline` are populated and unindexed for that reason; indexing them changes what a search *means*.
- **The index is rebuilt in full, never patched** — after every reconcile pass, at boot, and on
  `POST /admin/search/reindex`. At this library's size that's seconds, which buys out of tracking ~40
  write sites across unbounded reconcile loops, TMDB applies, and cascade deletes that invalidate
  documents they never name. Rebuilds go through a **shadow index and an atomic swap**: delete-then-add
  leaves a real window where the index is empty (Meilisearch writes are background tasks) — a query
  answered 138 rows one moment and 25 the next, mid-rebuild, which is how it was found.
- **People are bounded by `PEOPLE_LIMIT` (100), not `CANDIDATE_LIMIT`.** They shared one constant by
  sitting in the same call, and it cost: those ids spread into `creditedTo(…)` in four places, and it's
  their *selectivity*, not the `IN` size, that hurts — five hundred people scattered across a catalogue
  make `credits: { some: { personId: { in } } }` match a large share of every table. **This is also why
  moving to an engine didn't make search quicker on a real library**: Postgres reached people through a
  similarity *threshold*, most queries clearing few, while a `limit` is not a gate — prefix matching plus
  typo tolerance fills it on every keystroke. Measured on 3 800 titles / 30 000 people / 60 000 credits:
  `Jan` went 64ms → 20ms, `Bakker` 35ms → 21ms. 25 was tried and cost real recall on an ordinary surname;
  past 100 the curve turns.
- Candidate people are filtered through `scoreText` before their ids reach any query. A name the scorer
  credits nothing for can only add rows that are then scored zero and dropped — after their evidence has
  been read. It is the same function that decides the final answer, so it can only remove work.
- **`GET /library` reports `Server-Timing`, only to an ADMIN.** The counts come from the candidate step,
  which runs *before* Prisma applies visibility (the Postgres path isn't even told the role) — so a
  candidate count describes the library, not the caller. The same numbers are logged as a warning past
  `SLOW_MS` for anybody. Neither ever carries text: no query, title, name, or id.
- The interceptor **subscribes inside** its `AsyncLocalStorage` store. An interceptor returns an
  Observable and the handler runs on *subscription*, so opening a store around the construction captures
  nothing — written that way first, symptom being a header that never appeared with no error anywhere.
- Search cost is dominated by the **reads**, not recall or scoring: measured 15ms of a 20ms request on a
  title query, engine 2–3ms, scoring 1–2ms. Making search quicker means shrinking the four evidence reads.
- **The engine client uses `node:http`, not `fetch`, worth 48ms a search.** Measured container-to-container
  on one 113-id answer: `fetch` (undici) keep-alive **50.5ms**, `fetch` with `Connection: close` 4.5ms,
  `node:http` keep-alive **1.6ms** — against Meilisearch's own 0–1ms. The cost shows as a step where the
  response outgrows one TCP segment (a delayed-ACK stall, not parsing). Until found, searching *through
  Meilisearch was slower than through Postgres*. `fetchUpstream` stays right for TMDB/OpenSubtitles, where
  a request crosses the internet once and 50ms is noise.
- End to end on a 3 800-title library, p50: Postgres 34–84ms, Meilisearch **15–36ms**. With the engine
  stopped mid-flight the answers are identical and timings return to Postgres numbers — the breaker stops
  it dialling a dead host, so a failed engine costs nothing per request.
- **The five recall clauses are a `UNION`, never one `OR`.** Postgres answers a disjunction from indexes
  only when *every* branch has one, so a single un-indexed clause makes all five GIN indexes unreachable
  and the search scans computing trigram similarity per row: measured over 20 000 videos, 173ms as an
  `OR` vs 8ms as a `UNION` of the title branches, 151ms → 43ms for the whole query. `description` is
  indexed for the same reason (`gin_trgm_ops` on `ILIKE '%x%'`, 49ms → 0.5ms). `genres` can't be — the
  expression needing indexing is over `array_to_string`, STABLE rather than IMMUTABLE — so that branch
  scans one narrow column, a cost already weighed and taken.
- A trigram index cannot serve a pattern under three characters, so a one- or two-letter search still scans.
  Unchanged by any of the above, and no search anybody types is two letters long.
- `total` for a search comes from the **scored pool**, never a `count()`. Postgres was asked a generous
  question, so a database count promises cards that scored nothing and were dropped — and `nextBrowsePage`
  walks until `loaded >= total`, so an overcount is a browse page that scrolls forever.
- Every indirect route scores **below one** — cast, genre, and a shelf reached through a video on it. That is
  what keeps `merge.ts`'s collection-before-film tie-break deciding anything: a shelf that could accumulate
  its way past the film it shares a name with would quietly retire the rule.
- The candidate query's `ORDER BY` ends in **`id`**, like every paged query. Without it the cut at
  `CANDIDATE_LIMIT` falls wherever Postgres likes, and infinite scroll shows a card twice.
- `sort=relevance` with no `q` is demoted to `title` **in the schema**, so the service never sees the
  combination. Not a 400: clearing the search box while Best match is selected leaves a request in flight
  carrying both, and the browser suite fails any response ≥ 400.
- Searching matches **genres** too. The box has said "titles, genres and cast" all along while never reading
  one, and the chips on a collection page link here as `?q=…`.
- `genre` narrows with `hasEvery` and is repeatable; `tag` stays a single value, because the chips on a
  collection page link here as `?tag=…` and those links keep meaning what they meant. The two vocabularies
  stay apart for the same reason the columns do.
- `GET /library/genres` tallies in memory rather than in SQL. Unnesting an array column needs raw SQL, and
  that would mean a second copy of `whereFilm` again; one narrow column off a private library is the
  cheaper thing to spend. If it stops being, `unnest` goes here and the endpoint's shape does not change.

**Imported metadata** (`metadata/tmdb.mapper.ts`, `crew-role.ts`, `diff.ts` are pure; the client is the seam)
- **The source is TMDB, not IMDb.** IMDb has no public API and its terms forbid scraping. TMDB returns the
  IMDb id for titles and people, so deep-links still work, sourced legitimately.
- **Search, preview, apply, with a person in between.** That gate is the whole provenance story: there's
  deliberately *no* per-field source column anywhere, because somebody looked at a diff and ticked boxes.
  An importer writing on its own would need one on every column it touches.
- The descriptive columns live on **both** `Collection` and `Video`. A film here is a video belonging to
  no collection, so putting them only on the collection leaves half the library unable to carry any.
  `Video.year` exists for the same reason and is editable by hand, not only by import.
- **A proposal with nothing to say about a field never empties it** (`diff.ts`). TMDB not knowing a
  tagline isn't a reason to delete one somebody wrote — without the rule, ticking everything on a
  well-curated title empties half of it. Enforced twice, in the diff and again at the write, since the
  second is what a stale preview would otherwise get past.
- The **title** is the one field never ticked by default. It is usually the first thing an admin fixes, and
  a slug does not follow a rename, so an accepted rename leaves the shared link and the name disagreeing.
- Any title an import writes goes through `titleUpdate()`, or `normalisedTitle` rots and the "already in the
  library?" matching behind `/requests` silently stops seeing the row.
- TMDB writes **`""`, not null**, for everything it doesn't know. `new Date('')` is an Invalid Date that
  survives into a column, and an empty tagline is a blank line under the title. Television renames the
  same ideas — `name`, `original_name`, `first_air_date` — so reading only the film spelling gives a show
  with no title, no year, and **no error**.
- `vote_average` is `0` for anything nobody has rated. Stored, that's a confident "0.0 ★" on every obscure
  title, so a rating with no votes behind it is dropped.
- `crew-role.ts` matches **whole job strings, never substrings** — the same trap as release-tag stripping.
  TMDB's crew is full of jobs *containing* a key one ("Assistant Director", "Second Unit Director"), and a
  loose match puts the first assistant director's name at the top of the panel. Unmapped becomes `OTHER`
  **and keeps its `jobTitle`**.
- **Every cast and crew member is stored; the panel trims.** A person row never created can never be
  searched for, and `GET /people/:slug` already returns a filmography. `MAX_CREDITS` is 500, the whole
  list arriving in one response, so collapsing is purely a rendering decision.
- Because all but six jobs collapse to `OTHER`, a credit's identity is `(personId, role, jobTitle)`. On
  `(personId, role)` alone somebody credited as Costume Designer on a show and Stunt Coordinator on an
  episode **collides with themselves** and the show's credit vanishes from that episode — `mergeCredits`
  keys on job title for this. Acting credits have none and key as they always did.
- A re-import is **additive**: it never rewrites `Credit.position` (dragged into place by hand), and never
  deletes a credit an admin added.
- `PeopleService.resolveMany` exists because the per-row path can't: `create` loads *every* person's slug
  and probes for a duplicate name separately, so a 250-credit film is 500 queries and 250 full-table
  scans. It also adds each new slug to its own snapshot, or two same-named people in one cast take the
  same slug.
- **A person's IMDb id is not returned with credits** — it's `/person/{id}/external_ids`, one request
  each, so resolving eagerly costs 250 requests per film for links most never click. They fill in behind
  the read on `MediaService`'s probe queue, and `imdbCheckedAt` stops someone with no id being re-asked
  every page view.
- `TmdbError` is an **`HttpException` (502), not a plain `Error`**. As a plain Error it became a 500 and
  the one message an admin could act on never left the process. 502 because the failure is upstream.
  (Shipped that way; caught the first time the page was opened in a browser.)
- The **token never reaches a message or a log line**. A fetch failure can carry the request, and the
  request carries the token, so failures are described rather than interpolated — same reason
  `FfmpegError` drops the command line.
- Artwork goes in as `MANUAL`, reusing `ArtworkSource`, so the next reprobe can't replace a real poster
  with a frame grabbed 10% into the file. The preview *says* it would replace hand-chosen artwork rather
  than skipping quietly.
- Everything that talks to TMDB happens **before** any write. Holding a transaction open across a network
  call ties a database connection to somebody else's latency.
- Episodes are matched on `orderIndex` within a season. One with none is one ingest couldn't number, and
  guessing would put the wrong synopsis on the wrong episode — it's left alone.
- Genres are their own column, never `tags` — curator-authored, and sharing one column means a re-import
  can't tell which entries it owns and may replace.
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
  taking more room than the cast did. The line **deduplicates names within a role**: Story and Screenplay
  both map to WRITER, so a writer credited for both was named twice in one breath.
- `CreditsEditor`'s person picker **searches the server**. It filtered `/people?limit=100` in the browser
  on the reasoning that a private library's cast list is small; one import made it 111 — past
  `MAX_PAGE_LIMIT` — so the people the import had just created were exactly the ones unpickable. Still a
  plain input with results underneath, never a `USelectMenu` — see the note above.
- Its reorder arrows are **hidden while a filter is active**: `move()` works on positions in the whole
  list, so "down" in a filtered view means a place the reader can't see.
- Both admin forms re-seed from the record when **`updatedAt`** changes, not on every refresh and not
  once at setup. The collection's seed-once meant an import refreshed the page while the form held old
  values, so Save wrote them back over the import; the video's `watchEffect` threw away whatever was
  being typed. One rule fixes both, and imports made refreshes frequent enough to matter.

**Requests** (`requests/serialize.ts` is pure; `packages/shared/src/title.ts` is the comparison key)
- `toRequestView` is the **only** thing between a request row and the name of whoever wrote it. Non-admins
  get title, year, comment, status and admin note — hiding those would leave a page listing nothing — and
  never `requestedBy`/`statusChangedBy`. Built field by field rather than spread from the row, so a column
  added to `VideoRequest` later can't ride along; `serialize.spec.ts` pins the exact key set. `mine` is the
  deliberate exception: it tells you which entry is yours, which you already knew.
- The existence check is scoped to **`whereVisible(role)`**. Refusing a USER because a DRAFT matches would
  tell them the draft exists — the leak visibility exists to prevent. Their request is created instead,
  and the admin (who sees both) gets a `libraryMatch` hint putting the two side by side, computed over the
  *whole* library — handing it to a non-admin would undo the same protection.
- `normalisedTitle` on `Video` and `Collection` is derived from `normaliseTitle()` and written **only**
  through `titleData()`/`titleUpdate()` in `common/title.ts`. A derived column is worth nothing while it
  disagrees with its source, and it rots via a new write site setting `title` alone.
- It's deliberately **not** the slug: a slug is stable once created and drifts from the title it came
  from, so matching on one would miss every record ever renamed.
- `normaliseTitle` drops a **trailing bracketed** year (`The Matrix (1999)`), never a bare one — `Blade
  Runner 2049` and `2001: A Space Odyssey` *are* their numbers. It keeps leading articles: dropping them
  matches `The Thing` to `Thing` (usually right) and `The Others` to `Others` (not), a false match
  refusing a legitimate request. Never returns `''` for a title with content — `''` is the "not
  comparable" sentinel an unbackfilled row holds, matching nothing.
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
  "Aachen"). `cleanTitle` never returns empty, falling back to the raw name — which masks substring bugs
  in single-token titles, so test tag stripping with **multi-word** titles or the test proves nothing.
- The sidecar regex's stem must stay **greedy**. Lazy would split `The_Big_Sky_en_English` at the first
  short word, reading `Big` as the language.
- Subtitle binding is exact-stem first, then title. Ambiguity is **reported, never guessed** — wrong
  language on the wrong episode is worse than an issue in the admin list.
- Sidecars are matched **per folder**, never library-wide — every show has a `Pilot`, so a wider scope
  makes all of them ambiguous.
- Everything served lives in `DERIVED_ROOT`, including sidecars already `.vtt` — copying a few kilobytes
  beats carrying a "which root?" question through every read, and it survives the source moving.
  `sourceKey` holds the media path the sidecar came from; without it reconcile can't notice a deletion.
- Decide a subtitle's charset **before** converting, not after. Legacy `.srt` is often Windows-1252, and
  ffmpeg either fails or emits mojibake — a conversion that already threw can't be rescued by a retry.
- A subtitle claiming to be WebVTT is sniffed for the `WEBVTT` signature — on upload, and on download when
  a provider labelled `.vtt`. An SRT accepted as `.vtt` loads as an empty track: language listed, nothing
  ever appears. (Upload refuses anything else outright; download converts, since nobody chose its format.)
- **At most** one `isDefault` per video. `<track default>` on two tracks is undefined behaviour, and *none*
  is a legitimate answer — see below.
- The default track is a property of the **video**, not of a track: `PUT /videos/:id/subtitles/default`,
  because "no default at all" has no track to carry it and AUTO has to be expressible. `isDefault` is
  deliberately **not** on `updateSubtitleSchema`; two ways to write one invariant is how they drift.
- The rule is **English, and only English** (`subtitles/default-track.ts`, pure). A video whose subtitles are
  all Dutch gets no default rather than an arbitrary one: a default on a language the viewer cannot read is
  worse than none, since it turns subtitles on and leaves them hunting for the menu that turns them off.
- English is matched through `toIso6391`, never by string. Extracted tracks carry the container's tag
  (`eng`) while sidecars carry whatever the filename said (`en`); compared as strings those are two
  languages, and the rule would skip every embedded track — the majority of them.
- `Video.subtitleDefaultSource` is the same contract as `posterSource`: **MANUAL is never reapplied over**.
  Without it a deliberate Dutch default reverts to English the next time anything touches the track list.
- `refreshAutoDefault` runs wherever that list changes — after extraction (**once, after the whole set**;
  inside the loop it answers from a half-registered list), after sidecar binding, after an upload, and after
  a removal. That last is not tidiness: nothing else promotes a replacement, so deleting the default used to
  leave a video with none and no route back.
- The container's `disposition.default` decides **nothing**. It meant the default was whatever the encoder
  set — often a forced-subtitle track, and on a two-flagged container whichever stream was processed last.
- The tie-break between two English tracks is **total**, ending on the id. Same-label collisions are normal
  (an extracted track and a sidecar for one language), and a default that moves between scans reads as a
  rendering bug for weeks.
- A **downloaded** track goes through the same rule: `installDownloaded` calls `refreshAutoDefault` exactly
  as an upload does, so fetching an English subtitle for a video that had none lights it up, and an admin's
  MANUAL choice survives it. `fetchSubtitleSchema` therefore carries no `isDefault` either.
- An unrecognised season folder or language code is *accepted and flagged*, not rejected. Only structural
  problems (root-level file, depth > 3) refuse ingestion.
- Language codes go through `src/common/language.ts` (backed by `langs`), never a local list. A language can
  have two three-letter codes — `dut`/`nld`, `ger`/`deu` — and subtitle files in the wild use both.
- The conversion writes to `derived/tmp/` and is **renamed into place**, like a transcode and for the same
  reason as thumbnails: ffmpeg truncates its output the moment it opens it, so converting straight to the
  final key leaves the live track empty for as long as it takes, and empty for good if it fails. The player
  requests that URL the instant it mounts.

**Finding subtitles** (`subtitles/providers/`, admin-initiated, off by default)
- The whole feature is **off unless `OPENSUBTITLES_API_KEY` is set**. Searching sends a title or a file hash
  to a third party, which is a change of posture for a private library, so it is opt-in and **nothing fetches
  on its own** — the same rule that stops anything transcoding by itself.
- `GET /subtitles/search/status` exists so the editor can *hide* the button rather than offer one that always
  fails. Deliberately not a 503: a screen that has to catch an error to draw itself flickers. Same shape and
  same reasoning as `/admin/metadata/status`.
- Search and install are **synchronous routes, not `MediaJob`s**. That queue is concurrency 1 and shared with
  transcoding, so a 20 KB download queued behind a forty-minute encode waits forty minutes to do a second of
  work. Both are one round trip and an admin is waiting.
- The **hash is asked first, the title only if it found nothing.** A hash match was timed against this exact
  release; a title match was timed against some other cut and may drift by seconds. An admin who types a
  query is overriding the derived question, so the hash is skipped entirely — answering with hash matches
  would ignore what they asked.
- Hash the **source** (`storageKey`), never `playbackKey`. A transcode is not a release anyone else holds, so
  its hash matches nothing and hashing it would silently turn the good half of the feature off.
- The OSDb hash is `size + every LE uint64 in the first and last 64 KB`, and is **undefined below 128 KB** —
  `osdbHashOfFile` returns null there and the title search covers it. Like `contentTag` it reads only the
  ends: never use it for deduplication or integrity. Test fixtures must be padded past 128 KB or the hash
  path never runs and the test proves the title fallback twice.
- A downloaded track is `origin: DOWNLOADED`, never `INGEST`, or reconcile's sidecar sweep reaps every one of
  them on the next scan. It is its own value rather than `UPLOAD` because the panel shows an admin where a
  track came from, and "uploaded" is a lie about a file nobody chose off their own disk.
- Provider failures are an `HttpException` with **502**, not a plain `Error` — `TmdbError` records why: as a
  plain Error it becomes a 500 and the one sentence the admin could act on never leaves the process. The
  upstream body is logged and never rendered.
- The provider is injected behind `SUBTITLE_PROVIDER`, which is also the seam the db suite replaces —
  talking to opensubtitles.com in a test would be testing their uptime.
- The download allowance (`GET /infos/user`) belongs to the **account**, not the key, so a server holding a
  key and no account has **no such number** — `quota()` returns `null` there, and `quotaNotice` renders
  nothing. `null` and `0` are different answers: "0 of 0 left" would tell an admin they had spent something
  they never had and send them waiting for a reset that never comes. At zero the install buttons are
  *disabled* rather than left to fail, because the refusal otherwise arrives from a machine the admin has
  never heard of.
- The quota route is wrapped as `{ quota }` rather than returned bare: a handler returning `null` sends an
  empty 200 body, and the picker could not then tell "no such number" from "the response went missing".
- Reading the allowance again after a download is a **re-read, not a decrement**. The account is shared with
  anything else using it, so local arithmetic drifts from the truth the first time it is.

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
- A video belongs to any number of collections through **`CollectionVideo`**, carrying `seasonId` and
  `orderIndex`: those say where it sits *in one collection*, so the same episode can be episode 3 of a
  show and item 1 of a best-of row. `seasonId` must belong to `collectionId`; Prisma can't say that
  across a relation, so the service does. Deleting a collection takes its seasons and memberships and
  **leaves the videos standing** — a shelf is not the books.
- Every "which collection" filter on `GET /videos` is built as **one** clause (`membershipFilter`). They
  all constrain the same relation, so spread separately they overwrite each other — `?collectionId=X&seasonId=Y`
  silently dropped the collection and answered about the season alone. `?film=true` is the odd one: a
  fact about the *seasons behind* the join, so it's `none`/`some` across two relations and can't fold
  into that object at all. There's no column saying a video is a film — a column would be a second answer
  to drift. Returned under **`AND`**, not bare keys, since two `OR` keys spread into one object leave only
  the last.
- **A film is a video that no season-holding collection claims** (`common/films.ts`). Seasons are the only
  thing in the model that says "instalment of something": ingest turns season folders into a collection
  *with* seasons and a folder of eight films into one with none. It used to mean "a video in no collection
  at all", making every film on a shelf unfindable — the shelf was one card and the films were on it, so
  nowhere. Deliberately **not** "the membership has no `seasonId`": a special filed straight under a show
  is an extra of that show. The season half is **role-blind** — narrowing it per role could only leak.
  `?film=false` is the rule's opposite (the episodes), **not** `whereFilm`'s complement, which would let
  it enumerate episodes of shows the caller can't see.
- The word `standalone` survives in `ingest/structure.ts`, `uploads.service.ts` and `admin/media.vue`, where
  it still means the true, different thing: a folder holding one video becomes no collection. Leave it.
- `Collection.seasonCount` is **TMDB's** count of the whole show; `seasonsHere`/`videosHere` on the API
  response count our own rows. Two numbers is what makes "3 of 5 seasons here" a sentence, and it is the
  second that decides whether a shelf is a series or a saga of films.
- `GET /collections/:slug/resolve` checks **season slugs before video slugs**, and the literal `:slug/resolve`
  route is declared before `:slug` or Express matches `resolve` as a collection slug.
- Postgres treats NULLs as distinct, so composite uniques containing nullable columns do not prevent
  duplicates. Enforce those in the service layer.
- `ListItem.position` is deliberately not unique — a unique index collides during drag-reordering.
  `Video.orderIndex` is not unique for the same reason, which is why `PATCH /collections/:id/videos/order`
  rewrites a season's whole sequence in one transaction rather than swapping pairs. It sets `seasonId`
  **and** `orderIndex` together, since dragging an episode into a season changes both at once;
  `seasonId: null` means "directly in the collection", where films live. Like `credits/reorder` it names
  both parents and refuses ids belonging to anything else.

**Frontend**
- During SSR, `useFetch`/`$fetch` run in Nitro and do **not** forward the browser cookie. Pass
  `headers: useRequestHeaders(['cookie'])` — wrap it once in a `useApi()` composable.
- Everything is same-origin via the Nuxt `/api/**` proxy. Keep it that way: a cross-origin `<track>` fails
  silently, and `<video>`/`<track>` cannot send `Authorization` headers (this is why auth is cookie-based).
- A video is shown at **`/v/<slug>`**, its own page. `videoPath` therefore cannot return null any more — it
  used to, for a video that arrived without a collection, which is now simply what a standalone film is.
  `/c/<collection>/…` still resolves so shared links do not rot, and redirects a video to its canonical URL.
- `videoPath` (`/v/<slug>`, describes) and `playPath` (`/watch/<slug>`, plays) are picked between on a
  rule, not by feel: **inside a collection it plays** — an episode row, a collection's grid, the "more
  from" shelf — as do Continue Watching and History, since the choice was already made. **Browse, My List
  and curated rows describe**, since there the question is still what to watch. The **home hero** is on
  that side of the rule too: it features a new arrival, precisely something nobody has decided about yet,
  and a collection has nothing single to play anyway. `videoPath` was called `watchPath`, naming the one
  route it does *not* build while `playPath` sat beside it building exactly that — so the names now point
  at their own routes.
- **The player's Previous/Next are scoped by `?from=<collection-slug>`, which `playPath` takes as an
  optional second argument.** Must travel in the URL: a video belongs to any number of collections and
  `seasonId`/`orderIndex` sit on the *membership*, so the same episode is episode 3 of a show and item 1
  of a best-of row — the player can't derive one running order from the video alone. `collections[0]` is
  the tempting fix and is wrong for anything in two collections. Every "plays" surface passes it; Continue
  Watching and History don't, since they hold a video and position with no collection in hand.
- **`GET /videos?collectionId=…` is sorted by `title, id` and is not an episode order.** Deliberate — a
  library-wide listing has no single running order — and reading a sequence off it is how the outro's
  "Next episode" spent months going to the alphabetically next title. The order comes from
  `GET /collections/:slug`, through `episodeSequence` in `app/utils/episode-sequence.ts`.
- **`MEMBERSHIP_ORDER` is not cross-season order either.** It opens `{ seasonId: 'asc' }` and `seasonId`
  is a **cuid**, so videos arrive grouped by season with the seasons in an order nobody chose — a *total*
  order for paging, a different job. Season numbers are on the response's separate `seasons` list, which
  is why `episodeSequence` takes both halves.
- **`episodeSequence`/`neighbours` are not a second `nextEpisode`, and must not become one.** `nextEpisode`
  answers *where to resume* — the first unfinished episode. This answers *what physically follows*, the
  only thing Previous/Next can mean, since pressing one then the other must return you where you were. A
  surface wanting "carry on watching this show" wants the API's answer, not this one.
- A video not in the sequence gets **no stepper** — covering a `?from=` naming a collection it's not in
  (writable by anyone), one the caller can't see, and a response truncated past the embedded-video cap.
  Offering nothing beats a wrong neighbour.
- **`browse.vue` lists collections *and* films**, merged into one grid. It listed only collections, so a
  film could never appear however often it was published — a folder of eight films is one shelf, films
  *on* it rather than on none. Episodes stay out: reachable through their show, and listing them would
  bury four films under forty episodes of one. It asks **`GET /library`** for both halves at once; it used
  to fetch `/collections` and `/videos?film=true` separately and stitch them together here, which is why
  the merge moved to the API — see **The catalogue** above.
- Every filter **reaches** the URL, mapped by `app/utils/browse-filters.ts` (pure, specced). A narrowed
  library is something you share and come back to, and none of that survives state held only in a `ref`.
  Changing any filter resets `offset`, or narrowing while on page seven lands on an empty page that looks
  exactly like an empty library.
- **The URL is no longer where the question lives, and that's the whole of the search box feeling quick.**
  `browse.vue` holds filters in a `ref` and writes them out on a slower clock (`SETTLE_MS`, 600ms) than it
  asks the API on (`INSTANT_MS`, 150ms): the grid follows the box as closely as the server can answer,
  while the address bar only has to agree eventually. It used to be one 250ms debounce doing both, so
  nothing could move until a `router.replace` landed — measured on a 3 800-title library, the wait between
  keystroke and answer went **245ms → 133ms**. `INSTANT_MS` is deliberately not lower: near 90ms is where
  a search stops being noticeable.
- The cost is a **second copy of the state**, kept honest by one watcher when the URL is the copy that
  moved — a link into `/browse` already there, or a back navigation. It follows the **box** too: a third
  copy of the same text, the only one anybody sees. A hard load re-runs setup and seeds all three for
  free, which is why a test arriving via `page.goto` proves nothing here.
- **`fill()` is gated on the box having settled and the first page having landed.** `loadMore` can drop a
  stale *answer* but can't un-ask: scrolling while a new question's first page is in flight reaches it
  with a `total` describing the previous list, and the returned window gets appended to the new one.
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
- **The player starts itself from `onLoadedMetadata`, after the resume seek — never with the `autoplay`
  attribute.** The `<video>` and its `<source>` are server-rendered, so the attribute opens the browser at
  0:00 while Vue is still hydrating, only then seeking to the resume point: a second of the wrong scene,
  out loud, on every resume. `play()` is attempted once per load; a browser refusing an unmuted play it
  saw no click for is left alone, since the poster and controls are already on screen and muting instead
  would start a film silently. Playwright doesn't pass `--autoplay-policy=no-user-gesture-required`, so
  `playwright.config.ts` does. Tests about *where a seek lands* call `freeze()` (`e2e/viewer.spec.ts`),
  which pauses **and** re-pauses on `play`, since the autoplay attempt can settle after a bare `pause()`.
- **The stored volume is applied at the top of `onMounted`, before anything can call `play()`.** That
  handler's `readyState >= 1` branch calls `onLoadedMetadata` synchronously, starting playback — so
  restoring afterwards sounds the opening seconds at the old volume, the audible twin of the resume-seek
  bug above. `parseVolume` (`app/utils/volume.ts`) returns `null` for anything unusable rather than a
  number: `el.volume` **throws** on `NaN` or a value outside 0–1, and a throw in `onMounted` takes the
  whole player down. `muted` is stored beside the level, never folded into it — a zero would lose the
  level to come back to. Both `localStorage` calls are wrapped: Safari in private mode throws on the API
  itself, and losing a preference must not stop playback.
- **`/watch/:slug` never reaches `networkidle`, so `visit()` cannot open it.** A playing video keeps
  issuing range requests, so the wait inside `visit` runs until the *test* times out — a hang with no
  failing assertion. `visitPlayer()` (`e2e/fixtures.ts`) waits for `readyState >= 1` instead. Any reload
  of the player page needs the same treatment.

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
  browse, My List, a collection's grid — except `EpisodeRow` (choosing a moment, not a title) and every
  `HeroBackdrop`. `MediaCard`'s `shape` prop existed for months with **no caller ever passing it**, so
  every card rendered 16:9; `viewer.spec.ts` asserts the *request* rather than the rendered element.
- Card hover is a **border**, never an overlay. A centred play/info glyph covered the one thing a card
  exists to show. Removing it has to delete the element, not hide it — `visible.spec.ts` fails a control
  that's `opacity: 0` and still focusable.
- **Anything laid over a `.card-lift` needs a `z-index` above 1.** That hover rule scales and raises the
  card, so a control at `z-index: auto` is covered by the gesture that reaches for it. My List's remove
  button was plainly there at rest and gone the instant you went for it, click landing on the card's
  link. Visible at rest isn't the same as reachable.
- A nav link to a route with no page is a broken app, not a placeholder. The reverse is just as bad:
  `/admin/collections/[slug]` and `/admin/comments` are unreachable without their sidebar entries.
- The admin layout has a real `<main>`. It had none — only `<aside>` and a bare `<div>` — so there was no
  landmark to skip the nav to, and `main a[…]` (every viewer-side test) matched nothing there.
- `refDebounced` is VueUse and **not a dependency**. Debounce with a `setTimeout` cleared in `watch`, the
  way `browse.vue` does; without one, every keystroke is a request and answers can land out of order, so
  the list settles on whatever the *slowest* one returned. VueUse *resolves* as a transitive of
  `@nuxt/ui`, so `useInfiniteScroll` imports cleanly and is still a phantom dependency.
- `/browse` loads on scroll, and the loop that fills the viewport measures `getBoundingClientRect()`
  rather than the `IntersectionObserver`'s own flag. An observer reports *changes* at end of frame, so
  after appending cards it hasn't necessarily fired again and a loop waiting on it stalls with the
  sentinel still on screen — the ordinary case on a wide monitor: one page of fifty is under three rows
  at 4K, so the first load never reaches the fold. The observer is the cheap trigger; the rectangle is
  the answer.
- The scroll loader **must** stop at `MAX_LIBRARY_OFFSET` (10 000). `listLibrarySchema` refuses a deeper
  offset with a **400 rather than clamping**, and `e2e/fixtures.ts` fails every test on the page for any
  response ≥ 400 — a loader that keeps going takes the whole suite down with it. `nextBrowsePage` in
  `browse-paging.ts` is the one place that decides, and it's specced.
- Appending offset pages is only sound because `apps/api/src/library/merge.ts` sorts on a **total** order
  ending in `id`. Break that and the same card arrives twice under one `:key`.
- **A screen asking for `MAX_PAGE_LIMIT` and printing `total` is claiming a number it cannot show.** Every
  `Page<T>` carries `total` and `hasMore`, and the recurring bug is reading the first into a heading while
  ignoring the second: `/admin/people` and `/admin/library` both shipped as "one window of a hundred, and
  stop", so "Videos (1284)" sat over a hundred rows and the only records openable were ones whose titles
  were already known. `loadMoreLabel`/`appendWindow` in `app/utils/paging.ts` are the shared answer; the
  offer is counted against **`total`**, never `hasMore`. The label names *what is left* ("Load 12 more (of
  412)") since promising a whole window for the twelve that remain reads as records gone missing.
- `appendWindow` dedupes by id rather than concatenating. Offset paging over a list that moves hands back
  a row already on screen — a delete in an earlier window shifts every later one up by one — and two rows
  under one `:key` is a rendering bug, not a duplicate.
- **A filter change must drop the appended windows**, which is why both pages funnel every change through
  one `ask()` that resets them: window seven of the old question left underneath window one of the new
  one is a list whose rows never matched the box, with nothing on screen admitting it. The URL is written
  from what was *asked*, not the controls, so the shareable link is the question the list answers.
- Both load-more tests assert **both directions** — past one window the button fetches the next, within
  one window it's not offered — rather than skipping on a small library. A skip that never runs reports
  green, and the dev library is under a hundred titles.
- The poster wall is `.poster-grid` in `main.css`, used by browse, my-list and the collection page — was
  three copies of one arbitrary-value class. `auto-fill`, never `auto-fit`: with `1fr` tracks the two are
  identical whenever a row is full, but `auto-fit` collapses empty tracks and stretches a three-result
  search into three enormous posters.
- **A poster tile's floor is `11rem` at every viewport width above 400px.** Letting it grow on large
  screens was tried — a `clamp` reaching 14rem past ~2930px — and rejected on sight on a real 4K screen:
  enlarging the wall's cards there alone makes the page look zoomed. Extra width buys columns and margin,
  never size. **Below 400px the floor drops and the wall is two explicit columns**, since 11rem can't fit
  two tracks there: `.page-shell` leaves 343px at 375px, and two 176px tiles with a 1rem gap need 368px,
  so `auto-fill` found room for exactly one and every phone got a single poster filling the screen. The
  `@media (max-width: 25rem)` override is **continuous** with the rule it bends — at exactly 400px it
  produces a 176px tile identical to `auto-fill`'s, shrinking to 163.5px at 375px, 7% under the floor
  against 95% over it. Stated as `repeat(2, minmax(0, 1fr))` rather than a `min()` inside the auto-repeat,
  so the exception stays bounded and greppable. `minmax(0, 1fr)`, never `1fr`: `1fr` is
  `minmax(auto, 1fr)` and one unbroken title collapses the grid to a single column.
- **Every page is `.page-shell` and nothing else.** One width, one gutter scale, header included — so
  moving between routes never shifts content sideways. `/browse` and `/my-list` briefly had a wider
  variant, reasoning a wall of posters wants width a synopsis doesn't: at 4K it put sixteen columns 310px
  from the edge where every other page starts at 1115px. **Removed on sight** — the one page not lining up
  reads as broken, not as using the space. A wide treatment, if it returns, belongs to every full-width
  surface at once, not one route.
- **An admin table that doesn't fit scrolls sideways; it doesn't restack.** `.table-scroll` *replaces* the
  wrapper's `overflow-hidden` rather than nesting inside it — any non-`visible` overflow still clips the
  rounded corners, so the border stays put while content moves under it. The `<table>` needs `min-w-max`
  alongside `w-full`: `w-full` alone re-clips, `min-w-max` alone lets a short table shrink. Sideways
  rather than a card view below `sm` because the invite table on `/admin/users` always did this, and two
  table idioms in one admin area is worse than one imperfect one. The identifying column is first in all
  of them, so the useful half is on screen before anyone scrolls.
- **A secure-context API cannot be called directly — the dev server is reached over plain HTTP.**
  `crypto.randomUUID` and `navigator.clipboard` exist only on HTTPS or `localhost`, and are `undefined` on
  `http://192.168.x.x:3100` — exactly how the app is opened from a phone on the LAN. The player called
  `crypto.randomUUID()` at setup, so hydration threw and **Nuxt replaced the page with its own 500** —
  reported as "the video page 500s", though nothing server-side had failed. `newPlaySessionId` in
  `app/utils/` falls back to `crypto.getRandomValues`, carrying no such restriction, and still produces a
  **real UUID** since `heartbeatSchema` declares `playSessionId: z.uuid()`. The clipboard copy on
  `/admin/users` is the same trap on a value shown exactly once, and now says so rather than throwing into
  a void. The browser suite can't catch this class: it runs on `localhost`, which *is* a secure context.
- **No media query reaches JavaScript.** Every responsive decision is CSS — a `sm:` prefix,
  `@media (pointer: coarse)`, `@media (hover: hover)`. A `matchMedia` branch deciding *what to render*
  disagrees with the server, and a hydration mismatch is a `pageerror`, which the suite's
  `failOnConsoleError` fixture turns into a failure of **every test in the file**. VueUse's
  `useMediaQuery` is out for the same reason `refDebounced` is.
- **`.tap` is for icon-only, destructive, and press-while-moving controls — not for everything.** WCAG
  2.5.8's 24px floor is already cleared by a text-labelled `size="xs"` button at ~30px with its spacing;
  what fails is the icon-only set, where a bare `size-5` anchor is 20px. A blanket 44px turns `/browse`'s
  one row of filter chips into three for no gain. Grows the box with `min-block-size`/`min-inline-size`
  rather than a `::after` hit-area expander, which would silently cover and steal taps from the
  neighbouring control in the dense toolbars it's used in.
- **`.card-lift:hover` lives inside `@media (hover: hover) and (pointer: fine)`.** Chromium latches
  `:hover` onto the last element tapped, so unguarded it leaves a card scaled 1.06 and raised long after
  you've navigated away and back, until you tap somewhere else.
- **The start-over sweep cannot be paused on a touchscreen**, since there's no hover and nothing to focus.
  It runs for 8s instead of 5 (`--offer-seconds` under `@media (pointer: coarse)`), rather than gaining a
  "keep this" control — a third button inside a two-control overlay on a 343px screen, over video, beside
  the native control bar.
- **`AUDIT` also measures horizontal overflow**, and lives in `e2e/audit.ts` rather than `visible.spec.ts`:
  importing it *from a spec file* registers that file's tests too, quietly running the whole legibility
  suite under the phone project. `document.documentElement.scrollWidth` against `clientWidth` is the
  assertion; per-element rectangles are diagnosis, reported only when that fires. A candidate is dropped
  when any ancestor's computed `overflow-x` isn't `visible`, exempting media rails, `.no-scrollbar`
  shelves and admin tables by **behaviour** rather than a drifting class allowlist. Candidates containing
  other candidates are dropped, so one bad chip reports once. Use `getAttribute('class')`, never
  `className`: on an SVG that's an `SVGAnimatedString`, and slicing it throws inside `page.evaluate`.
- **The hero's scrim runs bottom-up below `sm` and left-to-right above it** (`.hero-side-scrim`). The
  horizontal version is tuned for text in the left third and fades to `transparent 72%`; on a phone the
  text column spans the full width, so its right quarter sat on unscrimmed artwork. `visible.spec.ts`
  **cannot** see this — `backdrop()` returns `null` at the first `background-image`, exempting that
  element *and every descendant* from contrast checks — so it's judged by eye. A class rather than the
  inline style it replaced, since a media query can't live in a `style` attribute.
- **Every hero proportion is `svh`, not `vh`.** `vh` is the *large* viewport height, ignoring a mobile
  browser's collapsing address bar, so the hero opens taller than the screen. `full` always said this;
  `wide` was missed and read `58vh`.
- **The player's three overlays are one flex column, not three absolute siblings.** All sat at
  `bottom-20` — 80px up a video 193px tall on a phone, floating at 41% of its height — and Skip intro and
  Start over shared that offset with nothing keeping them apart, so resuming into an intro put one on top
  of the other. A column makes the overlap impossible; the container is `pointer-events-none` since it
  spans the video and would otherwise swallow every tap. They stay siblings of `<video>`, so **native
  fullscreen leaves them behind** — accepted, since the alternative is the Fullscreen API and a control
  surface of our own, and this player is deliberately the browser's.
- **Episodes reorder with `@dnd-kit/vue`, and with arrows beside it.** HTML5 `draggable` fires *nothing*
  from a finger, so `/admin/collections/:slug` had no working reorder on a phone. dnd-kit's
  `PointerSensor` reads Pointer Events (mouse, touch and pen through one path), so a mouse-driven test
  gesture is what a thumb performs; its `KeyboardSensor` covers cross-season moves without a pointer at
  all. Checked and worth not re-checking: **`vuedraggable@next`** is UMD-only with no `exports` field and
  its open #286 is `RefImpl is not a constructor` against this project's Vue 3.5; **`useSortable`** (from
  `@vueuse/integrations`) would promote two phantom dependencies at once and can't do cross-list;
  **`sortablejs`** mutates the DOM behind Vue's back, needing every wrapper to undo it before splicing;
  **pragmatic-drag-and-drop** is built on HTML5 DnD with no touch support. The rows are their own
  component because `useSortable` can't be called in a `v-for`.
  **Playwright cannot script a touch drag** (microsoft/playwright#39043 is open), so `dragOnto` in
  `fixtures.ts` performs a *pointer* drag, scrolling both ends into view first — `page.mouse` works in
  viewport coordinates while `boundingBox()` will happily report a point below the fold.
- **`hasTouch: true` on the `phone` Playwright project is load-bearing.** Without it Chromium reports
  `pointer: fine` and every `@media (pointer: coarse)` rule in `main.css` goes unexercised while the run
  stays green. No device preset: `devices['iPhone 14']` implies WebKit — the wrong browser, carrying
  neither storage state nor `--autoplay-policy`. `mobile.spec.ts` plants a box that can't fit and checks
  the audit names it, since an audit reporting nothing looks exactly like an app with nothing wrong.
- Helpers shared by two screens move to `app/utils/` (Nuxt auto-imports them) rather than being copied.
  `apiMessage` was private to the video editor until a second page needed it — two divergent copies of
  "what did the server actually say" is how one screen ends up silently swallowing errors.
- `packages/shared` emits **both** CJS and ESM, and needs to. NestJS and ts-jest `require()` the CJS
  half; Vite serves the package to the *browser* as a native ES module, where a CJS file exposes **no
  named exports at all** and `import { loginSchema }` fails at parse time. SSR hides this completely —
  Nitro can require CJS — so it only appears when a page is opened in a browser. Relative imports in
  `src` carry explicit `.js` extensions so one source tree emits both.
- Nuxt Icon's runtime endpoint defaults to **`/api/_nuxt_icon`**, which the `/api/**` proxy swallows
  whole and forwards to NestJS. Moved to `/_icons` via `icon.localApiEndpoint`; otherwise any icon
  resolved at runtime silently fails to draw. The `/api/**` proxy owns that prefix entirely, so anything
  else wanting a server route has to move off it.
- A poster's storage key never changes, so replacing one leaves the browser showing the old picture. The
  admin screens append a cache-busting query after a capture or upload; the ETag alone can't help an
  `<img>` never re-requested.
- Browser tests live in `apps/web/e2e` (`npm run test:e2e -w @video/web`). They assert controls **do
  something** — `expectsRequest` waits for the API call — because a button with no handler renders
  perfectly. Needs both dev servers plus `npx playwright install --with-deps chromium`.
- **`locator.count()` does not retry.** A guard written as `if (await x.count() === 0) test.skip(...)`
  runs before a client-side route has rendered and is therefore always true: the sidebar-navigation test
  skipped on every run since it was written, announcing "only one video in this collection" about a
  collection holding five. A skip that never runs reports green. Decide a skip from the **data** (fetch
  it) and wait for the DOM with `expect`, which retries. `waitForLoadState('networkidle')` is not a
  substitute either — after a client-side navigation it can resolve *before* the data request has started.
- **A click cannot catch a control covered on hover.** Playwright jumps the mouse straight to its target,
  so an element a *neighbouring* `:hover` effect covers is uncovered again by the click itself — passing
  while a person cannot press the thing at all. My List's remove button shipped that way for months.
  Assert the **stacking** instead: hover the thing that moves, then check `document.elementFromPoint` at
  the control's own centre still lands on the control.
- `visible.spec.ts` catches the two bugs every other test walks past: **an `opacity: 0` control**
  (Playwright clicks those happily and `toBeVisible()` doesn't check opacity, so a `group-hover` with no
  `group` ancestor passes while invisible to a person) and **text below WCAG AA**. Contrast is measured
  by painting colours on a canvas — Chromium returns `oklab()` for the Tailwind palette, and parsing that
  as `rgb()` silently reports every ratio as ~1.
- **The audit skips the contrast of anything under `0.99` effective opacity**, so every *disabled* control
  in the app is invisible to it — `@nuxt/ui` dims those to `0.75`. That is the right call (a disabled
  control is deliberately quiet, and 0.75 still clears the `0.35` invisible-control floor), but it means a
  green audit says nothing about a disabled state. Judge those by eye.
- **A control that only renders in some states is only audited in those states.** The player's Previous/Next
  need `?from=` in the URL, and the audit's player test arrives by clicking Play on a video picked by title
  — which may be in no collection at all. The controls were therefore absent exactly when the audit ran, so
  a second test addresses a collection-scoped player directly. A control that is never on screen when the
  audit walks the page has not been judged by it, and the audit cannot tell you that.
- Server-rendered markup accepts a click or a keystroke **before Vue hydrates**, and the interaction is then
  silently dropped. Tests go through `visit()`/`fillStable()` for this.
- That's not only a test problem, and calling it "the first character" understated it. `v-model`'s
  mounted hook writes the model's value into the element on hydration, throwing away **everything** typed
  up to that moment: on `/browse` in dev, typing from the instant the grid paints turned `chernobyl` into
  a search for `nobyl`, then 150ms later `ernobyl`; from ~300ms it was right. A production build narrows
  the window without closing it, making it *harder* to diagnose since whether it bites depends only on how
  fast you start typing. `useTypedBeforeHydration` fixes it by adopting whatever's in the element in
  **`onBeforeMount`** — by `onMounted` the directive has already overwritten it. `/browse` uses it; the
  other six debounced boxes (`admin/library`, `admin/people`, `admin/comments`, `admin/requests`,
  `CreditsEditor`, `useRemoteSearch`) share the hazard, not yet the fix.
- A test that *retries* a field — `fillStable` — can't catch this; one typing a key at a time can.
  `viewer.spec.ts` deliberately uses `pressSequentially` with no retry for exactly one test.
- **A media event can fire before hydration too, and nothing replays it.** On a hard load the `<video>`
  and its `<source>` are in the server-rendered HTML, so the browser starts fetching before Vue attaches
  `@loadedmetadata` — the event lands on nothing. `VideoPlayer` therefore *asks* in `onMounted`
  (`readyState >= 1`) as well as listening; `onLoadedMetadata` is idempotent since both can fire. Without
  the ask, a refresh of `/watch/:slug` opens at 0:00 while clicking through to the same page resumes
  correctly.
- **The player resumes; it does not offer to.** `resumePoint` (`app/utils/resume.ts`) is the one rule for
  where playback opens, shared with `/v/:slug` so the position named on "Resume from 12:34" is the one it
  lands on. The seek must set `lastTick`, or `onTimeUpdate`'s first delta credits the whole resume offset
  as time watched. What's offered instead is **"Start from the beginning"** — nothing announces the
  position in words, since the player's own timeline sits directly under the button already saying it.
- **The offer's timer is the `offer-wipe` animation in `main.css`, not a `setTimeout`.** Grey sweeps
  across the button and `@animationend` removes it — one clock rather than two to drift apart, and
  hover/`focus-within` pausing the sweep pauses the disappearance with it. Drawn as an animated
  **background image**: a positioned `::before` would paint above in-flow content and cover the label,
  and the label is a bare text node that can't be given a `position` to lift it back out.
- **That animation is exempt from the `prefers-reduced-motion` reset**, load-bearingly: the blanket
  `animation-duration: 0.01ms` would end the sweep on its first frame and take the control with it,
  leaving those viewers no way to restart a video at all.
- The sweep's grey is measured against the **button's** foreground (7.2:1), not the page, so none of the
  `:root` tiers describe it — verified by hand, since `visible.spec.ts` reads computed background and
  never sees a background image. That foreground computes to `oklch(...)`, and parsing those numbers as
  r/g/b reports a confident 2.97:1 for a pairing that's really 7.2:1 — the same palette trap
  `visible.spec.ts` guards against elsewhere.
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
- **curl proves SSR and nothing else.** Both faults above returned HTTP 200 to curl and broke on
  hydration. A frontend change is verified in a browser or it is not verified.
- **Never name a local binding after an auto-imported Vue API.** A parameter called `ref` in
  `admin/lists.vue` made the **production** build emit that page's chunk with no `import { ref }`, so
  `ref('')` called a free global and setup threw `ReferenceError: ref is not defined`. A component whose
  setup throws renders **nothing** — a blank content area inside an intact admin sidebar, API and
  database both fine. Isolated by building both ways: the *template's* arrow parameter name makes no
  difference (minified away); the *script* binding is the whole of it. `auto-imports.spec.ts` parses
  every SFC for this and is verified by mutation — parsed rather than grepped, since `{ watch: [q, tag] }`
  in `browse.vue` is an option key and fine, `(row, ref: T)` is a binding and isn't.
- **`npm run dev` and the browser suite cannot see a production-only build fault.** The one above appeared
  solely in `nuxt build` output, and `apps/web/e2e` runs against the **dev servers** — so its `pageerror`
  watchdog never ran against the broken code. Anything depending on how the bundle is *built* needs a
  source-level check or a run against `.output`.
- A blank screen and an empty library must not look alike. `useApiData` returns `null` for both a failed
  request and no results, so a page destructuring only `{ data }` renders an outage as "No rows yet" —
  sending whoever reads it looking in entirely the wrong place. Take `error` too and check it **before**
  the empty state.
- The **same rule applies while a request is still out**, which is what skeletons are for. Viewer pages
  pass `{ lazy: true }` so a client-side navigation paints at once instead of freezing the previous
  screen — and then "no data yet" and "no data" become the same `null` again. Branch order is **error →
  content → skeleton → empty**: content before skeleton so a refetch keeps rows already on screen, empty
  state last so it's only reached once the request has genuinely succeeded with nothing in it.
- Test that with `status !== 'success'`, **never `status === 'pending'`**. `status` starts `idle` and
  only becomes `pending` when the fetch actually starts, and under `lazy` the fetch is deferred to
  `onBeforeMount` — so on the one frame the placeholder exists to fill, `pending` is false.
- **`lazy: true` costs SSR nothing** — checked in Nuxt's `asyncData.js` and worth not re-deriving. The
  server branch calls `initialFetch()` and registers `onServerPrefetch` **without consulting `lazy`**;
  only `server: false` skips it. A hard load still blocks and ships real content; only a client-side
  navigation sees a placeholder.
- A fetch that decides **what a URL is** stays blocking. `c/[collection]/[...path]`'s `resolve` answers
  404 and 301s a shared collection link to the video's own page; painting an episode grid then
  redirecting out is worse than the pause. Its second request only fills a page `resolve` already
  committed to, so that's the one that goes `lazy`.
- Making a primary fetch `lazy` **breaks a `throw createError` in setup**, silently: `error` is null
  there since the request hasn't been made, so the throw never fires and a missing record renders the
  page's own fallback instead of Nuxt's error page. Move it to `watch(error, …, { immediate: true })`
  calling `showError`.
- **Do not use `USkeleton`.** It hardcodes `role="alert"`, `aria-live="polite"` and `aria-label="loading"`
  on every instance with no prop to disable them, so a grid of twenty placeholders is twenty live regions
  announcing themselves — same trap as `USelectMenu`'s built-in `aria-label` shadowing its visible text.
  Its theme resolves to the three declarations `.skeleton` carries in `main.css`, so nothing is given up;
  the skeleton components put **one** `role="status"` on the container instead.
- A skeleton is a textless, non-interactive `<div>` with a solid `background-color`. Never a gradient
  shimmer: `visible.spec.ts` stops resolving a backdrop at the first `background-image` and returns null,
  silently exempting that element **and every descendant** from contrast checks — a shimmer buys a green
  audit by blinding it. Never an `<a>`/`<button>` either. The pulse is decoration: the reduced-motion
  reset stops it, so the resting colour must read as a placeholder on its own.
- **A WCAG ratio is necessary, not sufficient.** "I still cannot read this" was reported while every
  control cleared AA — worst 5.78:1, `Edit` buttons 6.19:1. The formula weights red at 0.2126, so
  saturated red text on near-black scores well and reads badly at 12–14px. Fix: stop using accent-coloured
  *text* for controls — `variant="subtle"` with no `color` gets `color="neutral"` (white on a raised
  surface), and the one real call to action gets `variant="solid"`. Accent colour marks things and never
  sets type.
- Colour lives in five named tiers in `main.css` (`--ui-text` → `--ui-text-dimmed`, plus `--ui-border` and
  `--ui-border-accented`), each annotated with its measured ratio — replacing 96 ad-hoc `white/N`
  utilities, two below AA (`text-white/35` at 2.8:1, `/40` at 3.5:1). `--ui-border-accented` is measured
  against `--ui-bg-elevated`, **not** the page: a bordered control sits on a raised surface, and measuring
  against the page flatters the value while the border still vanishes.
- `bg-white/N` is deliberately *not* part of that sweep — scrims over artwork and progress-bar tracks,
  where the alpha is the point.
- Gradients over artwork interpolate to `var(--ui-bg)`, never a hardcoded hex. The hero faded to
  `#08080a` after the page moved to `#0a0a0c`, so the scrim stopped landing on the colour behind it.
- **Reka UI teleports popovers to `<body>`.** An audit scoped to `main *, header *, aside *` never sees a
  single dropdown, select or modal. `visible.spec.ts` walks the whole document for this.
- A `mask-image` icon's colour **is** its `background-color`, so an audit treating the element's own
  background as backdrop compares the colour against itself, reporting a flat ~1:1 for every icon. Text
  and borders paint *on top of* their own background and must include it; icons must not. Getting this
  wrong reported 56 fake problems out of 70.
- **`@nuxt/ui` control triggers carry their own `aria-label`, which shadows the visible text.**
  `USelectMenu` ships `aria-label="Show popup"`, so the accessible name of a person-picker was "Show
  popup". Pass an explicit `aria-label` naming the *job*, not the mechanism.

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
- **A description is never required to publish.** It was, and made the library unpublishable: ingest
  can't write a synopsis, so every episode needed a person to type one before *any* could go out — and
  since a collection needs one publishable video, the collection was blocked too, reporting a missing
  `videos` while plainly holding five. Required instead: what a probe produces on its own — title, real
  duration, banner.
- **`publishableVideoCount` has exactly one definition.** There were two and they disagreed: `publish()`
  counted videos that were *ready* while the admin checklist read passed the total, so the screen
  reported a collection ready and the button refused it. Both now call one helper in
  `common/publishing.ts`, which also feeds the publish confirmation's count — the dialog can't promise
  something different from what happens.
- `POST /collections/:id/publish?cascade=true` takes the collection's **ready** videos with it in one
  transaction — what makes a freshly ingested show publishable without editing every episode.
- **`update()` builds its `data` field by field**, never by spreading the DTO — so a column added later
  can't be written by guessing its name. Cost: a *new* field is silently dropped until added there too,
  and the PATCH still answers 200 looking right. Happened with `trailerYoutubeId`; `library.db-spec.ts`
  now asserts the round trip rather than the status code.
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
  The remaining-admin count is read `FOR UPDATE` inside the transaction: read-then-write isn't atomic, and
  without the lock two admins demoted at once both see "one other remains" and both commit. A
  *deactivated* admin doesn't count as cover. No self-exemption — this one rule covers an admin demoting
  themselves and two admins stranding each other; "you can't edit yourself" would only catch the first.
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

- `TRUST_PROXY` must be set behind a TLS-terminating proxy, and the failure without it is silent. The
  session cookie is `secure` when `NODE_ENV=production`, and express-session refuses to *set* a secure
  cookie unless it believes the connection is HTTPS — which it only does when `trust proxy` lets it read
  `X-Forwarded-Proto`. `/auth/login` then answers **200 and sends no cookie**, reading as "my password
  stopped working". Verified both ways: with the header, `Set-Cookie … Secure`; without, a 200 and
  nothing. Also fixes throttling, which otherwise keys `/auth/login` on the proxy's address for everyone.
- Traefik routes `/api` on the **web** hostname straight to the API, bypassing Nuxt. Not a
  micro-optimisation: **Nitro's proxy buffers the whole request body in memory**, and
  `streamRequest: true` doesn't prevent it on the node-server preset. Measured: a 600 MB upload grew the
  web container ~575 MB and OOM-killed it at a 256 MB limit; via Traefik the same upload peaked at 55 MB.
  Uploads are capped at 2 GB. The route rule stays for SSR, small JSON in-process.
- **`NUXT_API_TARGET` is baked in at build time**, not read at runtime — Nuxt freezes it into the Nitro
  bundle's route rules. Setting it on a running container does nothing, which is why the API service is
  named `api` in every stack and the image is built with `http://api:4000`.
- `prisma generate` runs **before** `nest build` in the image: the generated client is gitignored, so it
  can never arrive in the build context. `prisma` and `dotenv` are *runtime* dependencies of apps/api
  rather than dev ones, so `--omit=dev` leaves the entrypoint able to run `prisma migrate deploy`.
- The production install is `npm ci --omit=dev -w @video/api --include-workspace-root`. A bare
  `--omit=dev` at the root installs *every* workspace's production dependencies, dragging Nuxt and
  ~300 MB into the API image.
- The entrypoint pins `PRISMA_SCHEMA_ENGINE_BINARY` by glob. Left to resolve the engine itself, the CLI
  probes `@prisma/engines` for write access, which a non-root container against root-owned `node_modules`
  fails — reporting *"please make sure you install prisma with the right permissions"*, which describes a
  broken install rather than the unwritable directory it found.
- `/state` is created **in the image**, owned by `node`. Docker seeds a fresh named volume from the
  image's directory including ownership, but creates the mount point root-owned when it doesn't exist —
  and the bootstrap token write fails with `EACCES` on first boot. Bind mounts are never chowned by
  Docker, so `MEDIA_PATH`/`DERIVED_PATH` must be `chown 1000:1000` on the host.
- The API image is **Alpine**, and the reason is `ffmpeg`, not Node. It was bookworm-slim on the belief
  that `@node-rs/argon2` needs glibc; it doesn't — `@node-rs/argon2-linux-x64-musl` is a published
  prebuilt, and Prisma resolves its musl engine the same way. Verified in the image; all 870 API unit
  tests pass on musl.
- **Debian's `ffmpeg` package costs 457 MB to install two binaries under 600 KB**, since it hard-depends
  on `libsdl2-2.0-0` for `ffplay`. SDL2 pulls Mesa, Mesa pulls libLLVM and libz3, and behind those come
  X11, Wayland, GTK, PulseAudio and the DRM drivers — 288 packages so a headless server can open a player
  window it never opens. `--no-install-recommends` can't decline them; they're Depends. Alpine needs 123
  packages and 184 MB, and ships no `ffplay`. Do not "simplify" the base back to Debian.
- The **`prisma` CLI is a runtime dependency** (the entrypoint runs `migrate deploy`) and Prisma 7's CLI
  bundles Prisma Studio — `@prisma/studio-core` drags in React, Radix UI, framer-motion, and
  `@prisma/config` drags in `effect`. That's ~290 MB of the image; the API itself never touches the CLI,
  using only the generated client and `@prisma/adapter-pg`. Removing the subtree leaves the API booting
  normally, but needs migrations to move to an init container.
- **The pipeline stops at GHCR — nothing deploys.** `build-dev.yml` is a manual `workflow_dispatch` and
  pushes two tags per image: the moving `<image_tag>` and an immutable `<image_tag>-<short sha>`. Putting
  a build on the server is Portainer → Update the stack with **Re-pull image** ticked.
- **Do not add an automated deploy back without re-measuring.** A Portainer CE webhook redeploys a
  Git-backed stack only when the tracked *git ref* has moved, and says nothing when it hasn't: `204` in
  ~20ms, no pull, no recreate. Easy to get backwards, since a call right after a merge *does* replace
  containers — the git change carried the pull with it. Confirmed by Portainer's `ConfigHash` moving
  across the one call that worked, then no change on every call after. `?pullimage=true` and
  `?IMAGE_TAG=…` are **non-git** stack webhook features and a Git stack ignores them; *Re-pull image*
  under GitOps updates is Business Edition. Deploying a *branch* never moves `main`, so a webhook would
  report success for work it never did — which is why the step was deleted rather than worked around.
  The two real options are in `deploy/README.md` step 4.

## Conventions

- Pure logic (`path-parser`, subtitle matcher, `qualityLabel`, `needsConversion`) lives in testable functions
  with unit tests written **before** the code that calls them. These are the highest-risk, cheapest-to-test parts.
- Three test tiers, and the split matters: `*.spec.ts` (unit), `*.e2e-spec.ts` (HTTP, Postgres stubbed) and
  `*.db-spec.ts` (HTTP against a real `video_test` database). Anything whose correctness *is* a database
  guarantee — transactions, conditional updates, constraints — belongs in the third; a stub cannot lose a
  race. `test:db` fails loudly with no database rather than skipping, so it can never go green testing nothing.
- **`test:db` is not safe to run twice at once.** The database name (`video_test`) and bootstrap-token
  paths (`/tmp/video-streaming-*-test.bootstrap-token`) are fixed, and every suite `TRUNCATE`s between
  cases — so two runs from two worktrees delete each other's fixtures and master token. Failures look
  nothing like a collision: `/auth/redeem` starts answering **400 "That invite token is not valid"** or
  the token file simply vanishes, and a whole green suite goes red on code that's fine. Give a parallel
  checkout its own database with `TEST_DATABASE_URL=…/video_test_<name>` and **set `TMPDIR` to a private
  directory**, which fixes the token paths too (built from `os.tmpdir()`). Confirmed the hard way: a db
  tier run against a concurrent one from another worktree failed at `transcode.db-spec.ts` and then, on
  retry, somewhere else entirely — the same code passed 458/458 once both variables were set. **A
  db-tier failure that moves between runs is this, not your change.**
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

# video-streaming-claude

A private, invite-only Netflix-style video library — a CRUD application for managing videos, with real
byte-range streaming, collections and seasons, and a PIM-style ingest pipeline that discovers media
dropped on disk, stages it as drafts, and lets an admin enrich and publish it.

> **Status: complete.** All eighteen steps of [`docs/PLAN.md`](docs/PLAN.md) are built.
> The design lives in the plan; the things that are easy to get wrong — and why they are the way
> they are — live in [`CLAUDE.md`](CLAUDE.md).

## What it does

- **Collections → optional Seasons → Videos.** A film is a collection of one; a series has seasons.
- **Two ways in.** Upload through the browser, or drop files into `media/` and let the watcher find them.
- **Draft → Published workflow.** Ingested files are staged with a missing-field checklist before going live.
- **Real streaming.** HTTP `206` range responses, so seeking in a 4 GB file is instant.
- **Transcoding.** Browser-triggered MKV → MP4 (H.264/AAC, faststart) with live progress.
- **Subtitles.** Sidecar files and embedded MKV tracks, both normalised to WebVTT.
- **Watch tracking.** Resume where you left off, per-video stats, continue-watching.
- **Skip intro / outro**, cast and crew, comments, curated rows, and a personal My List.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Nuxt 4 + Vue 3 + `@nuxt/ui` (Tailwind 4) |
| Backend | NestJS 11 on Express |
| Database | PostgreSQL 17 + Prisma 7 |
| Auth | Server-side sessions, invite-only accounts |
| Media | ffmpeg / ffprobe |

## Prerequisites

- **Node 24** — `nvm use` picks it up from [`.nvmrc`](.nvmrc)
- **Docker** — for PostgreSQL, via `docker-compose.yml`
- **ffmpeg + ffprobe** — probing, thumbnails, transcoding, subtitle conversion

Developed inside WSL2 (Ubuntu) on the Linux filesystem. That matters: `inotify` does not fire
reliably for files under `/mnt/c`, and the ingest watcher depends on it.

## Getting started

```bash
nvm use                 # Node 24
docker compose up -d    # PostgreSQL
npm install
cp apps/api/.env.example apps/api/.env
npm run db:migrate      # applies the initial migration
npm run dev             # Nuxt on :3000, NestJS on :4000
```

Then open <http://localhost:3000>.

On first run the API prints a **single-use master token** and writes it to `.bootstrap-token`
(mode `600`, gitignored). Redeem it at `/setup` to create the first admin; every later account comes
from an admin, directly or by invite. The file is deleted the moment it is used, and on any startup
that finds an admin already present — a token whose file is gone is unusable, so a stale one is
replaced rather than reused.

### Layout

| Path | What it is |
|---|---|
| `apps/web` | Nuxt 4 frontend, `srcDir` = `app/`, proxies `/api/**` → `:4000` |
| `apps/api` | NestJS 11 API on `:4000` |
| `packages/shared` | Types and pure helpers imported by both; compiled to `dist` before either app builds |
| `media/` | `MEDIA_ROOT` — the watched source tree (contents gitignored) |
| `derived/` | `DERIVED_ROOT` — thumbnails, posters, converted MP4/VTT (contents gitignored) |

### Root scripts

| Script | Does |
|---|---|
| `npm run dev` | Builds `packages/shared`, then runs both apps together |
| `npm run build` | Shared → API → web, in that order |
| `npm run typecheck` | `tsc --noEmit` across all three workspaces |
| `npm test` | Unit tests (API) |
| `npm run test:e2e` | HTTP tests against a stubbed database — no Postgres needed |
| `npm run test:db` | HTTP tests against a real `video_test` database |
| `npm run test:all` | All three tiers, in order |
| `npm run db:migrate` / `db:generate` / `db:studio` | Prisma, in `apps/api` |

## Testing

Four tiers, and the split is deliberate — each catches something the others cannot.

| Tier | Command | Catches |
|---|---|---|
| Unit | `npm test` | Pure logic: path parsing, subtitle matching, quality labels, watch accounting |
| HTTP (stubbed) | `npm run test:e2e` | Routing, guards, validation, rate limits — no database required |
| HTTP (real database) | `npm run test:db` | Anything whose correctness *is* a database guarantee: transactions, conditional updates, constraints. A stub cannot lose a race. |
| Browser | `npm run test:e2e -w @video/web` | That the app actually works. Needs both dev servers running. |

`npm run test:all` runs the three API tiers together. Use it rather than picking one: an API change
can pass unit and database tests while breaking the stubbed HTTP tier, and that has happened.

The browser tests assert that controls **do something** — a button with no handler renders
perfectly — and include a legibility audit that measures contrast by painting colours onto a canvas,
because a dark theme makes grey-on-black easy to ship. They need
`npx playwright install --with-deps chromium`.

## Hardening

- **`helmet`** for security headers. Its CSP is deliberately off: a CSP describes what a *document*
  may load, and this server returns JSON and media, never a document. The page comes from Nuxt, which
  is where a CSP belongs.
- **Rate limiting** counts against the signed-in user, falling back to the IP. Keying on IP alone
  would throttle a whole household behind one NAT, and would miss one account misbehaving from
  several addresses.

| Bucket | Limit | Where |
|---|---|---|
| Credentials | 10/min | `POST /auth/login`, `POST /auth/redeem` — the only routes reachable without a session |
| Authoring | 30/min | Posting a comment, minting an invite |
| Expensive | 20/min | Anything that spawns ffmpeg or walks the disk: convert, extract, re-probe, capture, upload, scan |
| Heartbeat | 40/min | Playback telemetry — leaves room for the 10s beat across a couple of tabs |
| Default | 300/min | Everything else |

Streaming, artwork, subtitle tracks and `/auth/me` are **exempt**. A single `<video>` issues a range
request per seek; every card on a shelf asks for a poster. A limit there does not protect anything —
it breaks playback.

- **Validation** is per parameter against a zod schema from `packages/shared`, rather than a global
  pipe. The schema is what says *what* to validate, and zod strips unknown keys by default — which is
  what a global `whitelist: true` would have bought.

## Licence

Unlicensed / personal project.

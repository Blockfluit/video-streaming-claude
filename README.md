# video-streaming-claude

A private, invite-only Netflix-style video library — a CRUD application for managing videos, with real
byte-range streaming, collections and seasons, and a PIM-style ingest pipeline that discovers media
dropped on disk, stages it as drafts, and lets an admin enrich and publish it.

> **Status: scaffolded (build step 2 of [`docs/PLAN.md`](docs/PLAN.md)).**
> The monorepo, database container, and both apps run; no features are implemented yet.
> The full design lives in [`docs/PLAN.md`](docs/PLAN.md).

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
npm run db:migrate      # from build step 3 onwards — no schema exists yet
npm run dev             # Nuxt on :3000, NestJS on :4000
```

Then open <http://localhost:3000> — the placeholder page reports the API's health through the
`/api` proxy, which is the quickest check that both halves are talking.

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
| `npm test` | Jest (API) |
| `npm run db:migrate` / `db:generate` / `db:studio` | Prisma, in `apps/api` |

On first run the API prints a **single-use master token** and writes it to `.bootstrap-token`
(gitignored). Redeem it at `/setup` to create the first admin account; every later account is
created by an admin, either directly or via an invite token.

## Licence

Unlicensed / personal project.

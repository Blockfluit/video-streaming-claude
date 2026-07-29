# video-streaming-claude

A private, invite-only Netflix-style video library — a CRUD application for managing videos, with real
byte-range streaming, collections and seasons, and a PIM-style ingest pipeline that discovers media
dropped on disk, stages it as drafts, and lets an admin enrich and publish it.

> **Status: planning complete, implementation not started.**
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

Nothing is scaffolded yet — see the build order in [`docs/PLAN.md`](docs/PLAN.md).

```bash
nvm use                 # Node 24
docker compose up -d    # PostgreSQL
npm install
npm run db:migrate
npm run dev             # Nuxt on :3000, NestJS on :4000
```

On first run the API prints a **single-use master token** and writes it to `.bootstrap-token`
(gitignored). Redeem it at `/setup` to create the first admin account; every later account is
created by an admin, either directly or via an invite token.

## Licence

Unlicensed / personal project.

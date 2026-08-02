# syntax=docker/dockerfile:1
#
# Two images from one file: `--target api` and `--target web`.
#
# They share the `deps` and `build` stages, so a CI run that builds both pays
# for the install and the compile once. Build them from the repository root —
# npm resolves `@video/shared` through a workspace symlink, and an install run
# from inside apps/api has no workspace to link to.
#
#   docker build --target api -t vsc-api .
#   docker build --target web -t vsc-web .

ARG NODE_IMAGE=node:24-bookworm-slim

# ---------------------------------------------------------------------------
# base — glibc, deliberately not Alpine: @node-rs/argon2 ships prebuilt glibc
# binaries, and on musl it falls back to building from source or simply fails.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
WORKDIR /app

# ---------------------------------------------------------------------------
# deps — every dependency, dev included, for compiling.
#
# The whole tree is copied before installing rather than just the manifests.
# That costs cache granularity, but apps/web's `postinstall` runs `nuxt
# prepare`, which needs the app source present; splitting the layers means
# `--ignore-scripts`, and the root package.json's `allowScripts` list names
# five packages that genuinely need theirs. The npm cache mount is what keeps
# this cheap between builds.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY . .
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ---------------------------------------------------------------------------
# build — order matters and is not negotiable.
#
#  1. packages/shared first: 40 files under apps/api import it and `nest build`
#     type-checks, so a missing packages/shared/dist fails the API compile.
#  2. `prisma generate` before `nest build`: the generated client is gitignored,
#     emitted as TypeScript under src/, and tsc compiles it along with the rest.
#     It cannot arrive in the build context.
# ---------------------------------------------------------------------------
FROM deps AS build

# Baked in, not read at runtime. Nuxt evaluates process.env.NUXT_API_TARGET
# while it builds and freezes the result into the Nitro bundle's route rules,
# so setting this on a running container does nothing at all. `api` is
# therefore the required service name in every deployment.
ARG NUXT_API_TARGET=http://api:4000
ENV NUXT_API_TARGET=${NUXT_API_TARGET}

RUN npm run build -w @video/shared \
 && npm run db:generate -w @video/api \
 && npm run build -w @video/api \
 && npm run build -w @video/web

# ---------------------------------------------------------------------------
# prod-deps — runtime dependencies for the API alone.
#
# `-w @video/api --include-workspace-root` is what keeps Nuxt and its ~300 MB
# of dependencies out of the API image; a bare `npm ci --omit=dev` at the root
# installs the production dependencies of every workspace, web included.
#
# `prisma` and `dotenv` are runtime dependencies of apps/api rather than dev
# ones precisely so they survive --omit=dev: the entrypoint runs
# `prisma migrate deploy`, and prisma.config.ts opens with `import 'dotenv/config'`.
# ---------------------------------------------------------------------------
FROM base AS prod-deps
COPY . .
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev -w @video/api --include-workspace-root

# ---------------------------------------------------------------------------
# api
# ---------------------------------------------------------------------------
FROM base AS api

# ffmpeg brings ffprobe with it. Both are spawned by name (FFMPEG_PATH /
# FFPROBE_PATH default to bare `ffmpeg` / `ffprobe`), and a slim Node base has
# neither — every probe, thumbnail and transcode fails without this.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# node_modules is hoisted entirely to the root, and node_modules/@video/shared
# is a symlink to ../../packages/shared — so that path has to exist with a
# package.json and a dist, or every `import from '@video/shared'` fails at
# require time rather than at build time.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build     /app/packages/shared/dist ./packages/shared/dist

COPY --from=prod-deps /app/apps/api/package.json ./apps/api/package.json
COPY --from=build     /app/apps/api/dist ./apps/api/dist

# Needed at run time, not just at build time: the entrypoint applies migrations,
# and prisma.config.ts names `prisma/schema.prisma` and `prisma/migrations`
# relative to the working directory.
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/prisma.config.ts ./apps/api/prisma.config.ts

COPY docker/api-entrypoint.sh /usr/local/bin/api-entrypoint.sh
RUN chmod +x /usr/local/bin/api-entrypoint.sh

# Create the state directory *in the image*, owned by the user that will write
# to it. Docker seeds a fresh named volume from the image's directory —
# contents and ownership both — but when the mount point does not exist it
# creates it root-owned instead, and the bootstrap token write then fails with
# EACCES on first boot. Nothing else in the image needs this; the media and
# derived roots are bind mounts, which Docker never chowns, so those are the
# operator's job (see deploy/README.md).
RUN mkdir -p /state && chown node:node /state

# WORKDIR is load-bearing twice over: prisma.config.ts's paths are relative to
# it, and MEDIA_ROOT / DERIVED_ROOT / BOOTSTRAP_TOKEN_FILE all resolve against
# process.cwd() when given relative values. Set them absolute in the compose
# file and neither question arises.
WORKDIR /app/apps/api

ENV NODE_ENV=production \
    PORT=4000

# uid 1000 in the node image. The bind-mounted media and derived directories on
# the host must be owned by 1000 too — StorageService mkdir -p's both at boot
# and writes into them.
USER node

EXPOSE 4000

# No curl or wget in a slim image, and node has had global fetch for years.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["api-entrypoint.sh"]
CMD ["node", "dist/main"]

# ---------------------------------------------------------------------------
# web
#
# Nitro traces its externals and copies them into .output/server/node_modules,
# so the built output is self-contained — no install, no workspace, nothing
# else to copy. @video/shared is inlined into the bundle at build time and is
# not a runtime dependency here at all.
# ---------------------------------------------------------------------------
FROM base AS web

COPY --from=build /app/apps/web/.output ./.output

ENV NODE_ENV=production \
    NITRO_PORT=3000 \
    NITRO_HOST=0.0.0.0

USER node

EXPOSE 3000

# Any HTTP answer means Nitro is up. Deliberately not a 2xx check on `/`: that
# page server-renders from the API, so a check on its status would report the
# web tier unhealthy whenever the API is the thing that is down.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NITRO_PORT||3000)+'/').then(()=>process.exit(0)).catch(()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]

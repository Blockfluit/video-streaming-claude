#!/bin/sh
set -eu

# Apply migrations before the app serves anything.
#
# This is not a convenience. The `session` table is owned by a Prisma migration
# (connect-pg-simple is configured with createTableIfMissing: false, because its
# DDL differs from ours), so an API that starts against an unmigrated database
# cannot authenticate a single request. PrismaService also runs `SELECT 1` at
# boot and exits non-zero if the database is unreachable — so a failure here and
# a failure a second later look the same to Docker, and both are correct.
#
# `migrate deploy` applies pending migrations and never generates, resets or
# prompts — it is the only Prisma migrate command safe to run unattended.
# Racing replicas would be a problem; there is exactly one API container by
# design (in-process job queues, one ingest watcher), so there is no race.
#
# Run by path rather than `npx`: npx would try to reach the network if it did
# not find the binary, and turning a missing dependency into a download at boot
# is not a failure mode worth having.
# Point Prisma straight at the schema engine it already has.
#
# Left to resolve the engine itself, the CLI probes @prisma/engines for write
# access — it wants somewhere to download to — and this container runs as
# `node` against a root-owned node_modules. It fails with "Can't write to
# /app/node_modules/@prisma/engines please make sure you install prisma with
# the right permissions", which describes a broken install rather than the
# unwritable directory it actually found. Naming the binary skips the probe
# entirely, so nothing needs write access to its own code.
#
# Resolved by glob rather than hardcoded: the filename carries the platform and
# the OpenSSL version (schema-engine-debian-openssl-1.1.x today), and both move
# with a Prisma upgrade or a base-image change.
if [ -z "${PRISMA_SCHEMA_ENGINE_BINARY:-}" ]; then
  for candidate in /app/node_modules/@prisma/engines/schema-engine-*; do
    if [ -x "$candidate" ]; then
      PRISMA_SCHEMA_ENGINE_BINARY="$candidate"
      export PRISMA_SCHEMA_ENGINE_BINARY
      break
    fi
  done
fi

if [ -z "${PRISMA_SCHEMA_ENGINE_BINARY:-}" ]; then
  echo "No Prisma schema engine found under /app/node_modules/@prisma/engines." >&2
  echo "The image is built wrong — migrations cannot run." >&2
  exit 1
fi

echo "==> Applying database migrations"
/app/node_modules/.bin/prisma migrate deploy

echo "==> Starting API"
exec "$@"

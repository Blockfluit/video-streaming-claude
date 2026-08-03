# Deploying

GitHub Actions builds two images and pushes them to GHCR. It stops there — **Build dev images** is a
button in the Actions tab, its branch dropdown chooses what gets built, and putting a build on the
server is a separate, deliberate action in Portainer.

```
you pick a branch  ──▶  tests  ──▶  build api + web  ──▶  GHCR      ← the pipeline ends here
                                                            │
                                                    you, in Portainer  ──▶  running
```

Nothing deploys on its own, and nothing claims to. [Step 4](#4-why-there-is-no-webhook) records why
the automated last hop was removed rather than worked around.

Traefik terminates TLS in front of both containers, and the browser only ever talks to `WEB_DOMAIN`.
Traefik splits that hostname across the two containers:

```
https://WEB_DOMAIN/          ──▶  web  (Nuxt SSR)
https://WEB_DOMAIN/api/**    ──▶  api  (StripPrefix /api, priority 100)
https://API_DOMAIN/**        ──▶  api  (direct, for curl — the app never uses it)
```

Everything the browser sends is still same-origin — same host, same cookie, the same `/api/…` paths
the app already calls. It just does not detour through Node twice.

**Why `/api` is split off rather than proxied by Nuxt.** Nitro's proxy buffers the entire request
body in memory. `streamRequest: true` is the documented fix and does not work on the node-server
preset: h3's `getRequestWebStream` falls back to `readRawBody`. Measured on this stack, a 600 MB
upload grew the web container by ~575 MB and OOM-killed it at a 256 MB limit; routed by Traefik the
same upload peaked at 55 MB and succeeded. Uploads are capped at 2 GB, so no realistic amount of RAM
makes buffering them sensible. Sending video streaming the same way also drops a relay hop from every
range request a seeking viewer makes.

SSR still uses the Nuxt route rule to reach `http://api:4000` in-process — those are small JSON reads
and never touch the Traefik router.

---

## One-time server setup

### 1. Storage

```sh
sudo mkdir -p /srv/docker/streaming-platform-dev/media /srv/docker/streaming-platform-dev/derived
sudo chown -R 1000:1000 /srv/docker/streaming-platform-dev
```

The API container runs as `node` (uid 1000) and creates and writes into both directories at boot.
Getting the ownership wrong shows up as an `EACCES` in the container log a second after it starts.

They must be two separate directories. The API refuses to start if `DERIVED_ROOT` resolves inside
`MEDIA_ROOT`, because generated thumbnails and transcodes landing in the watched tree make the ingest
watcher trigger itself in a loop.

Drop files into `media/` and the watcher ingests them. That works because this is a native bind mount
— `inotify` does not fire reliably over NFS or SMB, so if the library ever moves to a network share,
expect to trigger a rescan by hand.

### 2. GHCR access

Nothing to do, but worth knowing why. The repository is public, so the stack needs no Git credential,
and the two packages the deploy pushes are public with it — confirmed by pulling both images onto the
server with no credential configured anywhere.

Package visibility is a *separate* setting from the repository's, though, and it can be changed
independently. If a pull ever starts failing with `denied`, that is what happened, and there are two
ways back:

- **Make the packages public again** — *Packages → `api` / `web` → Package settings → Change
  visibility*. Nothing is disclosed that the public source did not already disclose.
- **Or add a registry credential** — *Portainer → Registries → Add registry → Custom*, URL `ghcr.io`,
  your GitHub username, and a personal access token scoped to **`read:packages`** only.

### 3. The stack

**Portainer → Stacks → Add stack → Repository**:

| Field | Value | |
|---|---|---|
| **Name** | `video-dev` | Also the compose project name, which prefixes the volumes (`video-dev_pgdata`). Chosen once and permanently: renaming the stack later leaves the database behind under the old prefix. |
| Repository URL | `https://github.com/Blockfluit/video-streaming-claude` | |
| Reference | `refs/heads/main` | |
| **Compose path** | **`deploy/compose.yml`** | **Not the default.** Portainer pre-fills `docker-compose.yml`, and that file is the local-development Postgres — a stack left on the default deploys a lone database and no application. |
| Authentication | off | The repository is public. |

Paste the contents of [`stack.env.example`](stack.env.example) into the stack's **Environment
variables** editor, replace the placeholder hostnames with the real ones, and fill in the two
secrets:

```sh
openssl rand -base64 32   # SESSION_SECRET
openssl rand -base64 24   # POSTGRES_PASSWORD
```

Portainer writes those to a `stack.env` and passes it to compose as `--env-file`, which is what makes
`${VAR}` interpolation work. That happens wherever the file lands, so the compose file relies on
interpolation for everything load-bearing rather than on `env_file:` finding a particular path —
`stack.env` sits beside the compose file in a web-editor stack and one directory up in a Git-backed
one. Both layouts are tested.

A missing required value fails the deploy with a sentence naming it (`required variable
SESSION_SECRET is missing a value: set SESSION_SECRET in the stack environment`) rather than starting
an API that cannot hold a session.

**If the first deploy fails naming `env_file`:** the block uses the long form (`path:` /
`required: false`), which needs Compose v2.24+, and Portainer embeds its own compose rather than
using the host's CLI. Delete the whole `env_file:` block from the `api` service — it carries only the
optional tuning knobs, and everything the app cannot start without arrives by interpolation. This
fails loudly at deploy time, so you will not be hunting it at runtime.

### 4. Why there is no webhook

There is no automated deploy, and the reason is worth keeping rather than rediscovering.

**A Portainer CE webhook redeploys a Git-backed stack only when the tracked git ref has moved.**
Against an unchanged ref it returns `204` in about twenty milliseconds and does nothing at all — no
pull, no recreate — while the caller sees success. Measured in both directions: the one call that did
replace both containers landed just after two pull requests were merged, so the stack's `ConfigHash`
moved from `b604e95f` to `1a28019c` and the image pull came along with the *git* change. Every call
afterwards, with the ref unchanged, left the same image id and the same start time five minutes later.

Neither query parameter helps. `?pullimage=true` and `?IMAGE_TAG=…` are both features of the
**non-git** stack webhook, which the UI gates behind `"repository" !== method`; a Git stack ignores
them silently. The switch that *would* make a Git stack act on a changed image behind an unchanged ref
is **Re-pull image** under GitOps updates, and that one is Business Edition — its control carries
`featureId: STACK_PULL_IMAGE`.

That is fatal for a branch-picker pipeline specifically: deploying a branch never moves `main`, so the
server would never change while every run went green. **A deploy that reports success for work it did
not do is worse than one that fails.** So the workflow stops at the registry, and the last step is
yours.

Two ways to automate it later, if it ever becomes worth the trade:

- `PUT /api/stacks/<id>/git/redeploy` with `{"pullImage": true, "env": [...]}` and a Portainer access
  token. This is the endpoint behind the UI's own **Pull and redeploy** button and is *not* gated.
  Costs a token and a Traefik route into the Portainer API, and the request **replaces** the stack's
  environment — read the stack first and hand `Env` back, or `SESSION_SECRET` goes with it.
- Watchtower (the `nickfedor` fork; upstream `containrrr` is archived), scoped by label to these two
  containers. Needs nothing exposed to the internet, but hands the Docker socket — root-equivalent —
  to a third-party agent whose own README says it is not recommended outside a homelab.

### 5. Traefik

The compose file's labels match the existing convention: entrypoint `websecure`, `certresolver=letsencrypt`,
network `traefik`. Three things to check on the Traefik side, because they are outside this repo:

- **`respondingTimeouts.readTimeout` on the `websecure` entrypoint.** Traefik v3 defaults to 60s,
  and that clock covers reading the whole request body. Uploads are capped at 2 GB, which takes
  considerably longer than a minute on any domestic uplink — and it fails as a stalled progress bar,
  not an error message. Raise it or set it to `0`.
- **No `buffering` middleware on these routers.** It would collect entire request and response bodies
  before forwarding, which reintroduces exactly the problem the `/api` split solves, and breaks the
  byte-range requests that make video seeking work.
- **Router priority.** The `/api` router is pinned to `priority=100` so it beats the web router's
  bare `Host()` match. Traefik's default is to rank by rule length, which would also work here, but
  not visibly — and a viewer whose uploads land on the Nuxt container instead gets no error, just a
  process quietly eating a gigabyte.

Verified against Traefik v3.3: `/api/health` on the web host reaches the API, a login through Traefik
comes back with a `Secure` cookie, and a range request returns `206` with the right `Content-Range`.

### 6. First login

The bootstrap token is written to `/state/.bootstrap-token` and printed in a banner in the API
container's log:

```sh
docker logs video-dev-api | head -40
```

Redeem it at `https://<WEB_DOMAIN>/setup`. It expires after 24 hours; restarting the API while no
admin account exists mints a new one, so this is not a way to get locked out.

---

## Building

**Actions → Build dev images → Run workflow.** Pick the branch from the dropdown — that is the branch
picker; there is no separate input for it.

| Input | Default | |
|---|---|---|
| `run_tests` | true | Untick to skip the suite for a hotfix. |
| `image_tag` | `dev` | The environment tag to move. |

Each run pushes two tags per image, and writes both to the run summary:

| Tag | Example | |
|---|---|---|
| `<image_tag>` | `dev` | Moving. What the stack follows unless you pin it. |
| `<image_tag>-<short sha>` | `dev-1a28019` | Immutable. Short enough to type into Portainer. |

The branch dropdown only lists branches that already contain `.github/workflows/build-dev.yml`. A
branch cut before this landed needs a rebase onto `main` before it can be built.

## Deploying

The workflow stops at the registry — see [step 4](#4-why-there-is-no-webhook) for why. To put a build
on the server:

**Portainer → Stacks → `streaming-platform-dev` → Update the stack**, tick **Re-pull image**, Update.

That button pulls unconditionally and is *not* feature-gated — unlike the *Re-pull image* switch under
GitOps updates, which is the Business Edition one. It is the whole procedure when you are deploying
the moving `dev` tag, because the tag has not changed and only the image behind it has.

Use the button rather than the host. A Git-backed stack's compose file and its generated `stack.env`
live *inside* Portainer's own volume — `/var/lib/docker/volumes/portainer_data/_data/compose/<stack
id>/` — so driving it from the host means root, the right `--env-file`, and Portainer's view of the
stack drifting from what is actually running. The button avoids all three.

**The branch picks the code; `main` picks the compose file.** The workflow builds images from whatever
branch you select, but the stack is a Git-backed one pinned to `refs/heads/main`, so that is where
Portainer re-reads `deploy/compose.yml` from. A branch that changes a Traefik label, adds an
environment variable or edits the compose file at all does **not** take effect until it is merged —
its *code* deploys, its *topology* does not. Code-only branches, which is nearly all of them, are
unaffected. Pointing a second stack at a branch reference is the way to test a compose change without
merging it.

**Check it landed.** A redeploy that pulled nothing looks identical to one that did:

```sh
docker inspect streaming-platform-dev-api --format '{{.Image}} {{.State.StartedAt}}'
```

A changed image id and a fresh start time mean it actually replaced something.

### Rolling back

Set `IMAGE_TAG` to the `dev-<short sha>` you want in the stack's environment variables and update the
stack. The GHCR package page lists what is available, as does `docker image ls` on the server. Unlike
the moving tag, that one is a pin: nothing moves it, so the stack stays there until you set it back.

Note what a rollback does *not* undo: `prisma migrate deploy` has already run, and there is no
down-migration. Rolling back past a schema change needs a restore, which is why the next section
exists.

## Adding production later

A second stack, same compose file, different `stack.env`:

```
STACK_NAME=video-prd
WEB_DOMAIN=<the production web hostname>
API_DOMAIN=<the production API hostname>
IMAGE_TAG=prd
MEDIA_PATH=/srv/docker/streaming-platform-prd/media
DERIVED_PATH=/srv/docker/streaming-platform-prd/derived
```

with its own secrets, and named `video-prd` in Portainer so the volumes get their own prefix too.
`STACK_NAME` keeps the container names and Traefik routers distinct, and the two stacks share
nothing — separate database container, separate volumes, separate storage.

The build workflow needs no copy: run **Build dev images** with `image_tag` set to `prd`, and it
pushes `prd` and `prd-<short sha>` — the tags are derived from the input, not hardcoded. Rename it if
"dev" in the title becomes confusing.

## Known gaps

- **Nothing backs up the `pgdata` volume.** The media files are on the host and survive anything, but
  every account, watch position, comment and curated list lives only in that volume. A
  `pg_dump` on a schedule is the obvious next thing to add.
- **Playwright is not in CI.** `.github/workflows/tests.yml` runs the three API tiers and the web unit
  tests; the browser suite needs both dev servers plus a Chromium download and was left out of the
  first pass. It is the highest-value thing to add next, because it is the only tier that catches a
  page that renders and does nothing.

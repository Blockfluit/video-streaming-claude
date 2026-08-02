# Deploying

GitHub Actions builds two images and pushes them to GHCR; a Portainer stack webhook tells the server
to pull them. Nothing deploys on its own — **Deploy to dev** is a button in the Actions tab, and its
branch dropdown chooses what gets built.

```
you pick a branch  ──▶  tests  ──▶  build api + web  ──▶  GHCR  ──▶  webhook  ──▶  Portainer pulls
```

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
mkdir -p /srv/video-dev/media /srv/video-dev/derived
chown -R 1000:1000 /srv/video-dev
```

The API container runs as `node` (uid 1000) and creates and writes into both directories at boot.
Getting the ownership wrong shows up as an `EACCES` in the container log a second after it starts.

They must be two separate directories. The API refuses to start if `DERIVED_ROOT` resolves inside
`MEDIA_ROOT`, because generated thumbnails and transcodes landing in the watched tree make the ingest
watcher trigger itself in a loop.

Drop files into `media/` and the watcher ingests them. That works because this is a native bind mount
— `inotify` does not fire reliably over NFS or SMB, so if the library ever moves to a network share,
expect to trigger a rescan by hand.

### 2. GHCR credentials

The repository is private, so the server cannot pull without a credential. In **Portainer →
Registries → Add registry → Custom**:

- URL: `ghcr.io`
- Username: your GitHub username
- Password: a GitHub personal access token (classic) with **`read:packages`** only

### 3. The stack

**Portainer → Stacks → Add stack → Repository**:

| Field | Value |
|---|---|
| Repository URL | `https://github.com/Blockfluit/video-streaming-claude` |
| Reference | `refs/heads/main` |
| Compose path | `deploy/compose.yml` |
| Authentication | on — same PAT as above (private repo) |

Paste the contents of [`stack.env.example`](stack.env.example) into the stack's **Environment
variables** editor, replace the placeholder hostnames with the real ones, and fill in the two
secrets:

```sh
openssl rand -base64 32   # SESSION_SECRET
openssl rand -base64 24   # POSTGRES_PASSWORD
```

Portainer writes those to `stack.env` next to the compose file, which is where `env_file:
./stack.env` picks them up.

> If the first deploy fails with a missing `stack.env`, Portainer has written it to the root of the
> clone rather than beside the compose file — change `env_file: ./stack.env` to `../stack.env` in
> `deploy/compose.yml`. It is deliberately a hard failure rather than an optional file: an API that
> booted without `SESSION_SECRET` would be worse.

### 4. The webhook

On the stack, enable the webhook and **turn on re-pulling the image**. Without that, a redeploy
re-runs `compose up` against a `dev` tag it already has locally and nothing changes — the deploy
appears to succeed and ships nothing.

Copy the webhook URL into the repository's GitHub secrets as **`PORTAINER_WEBHOOK_DEV`**
(*Settings → Secrets and variables → Actions*). The URL is the credential — anyone holding it can
redeploy the stack, so it is a secret rather than a variable, and the workflow never echoes it.

**No hostname is committed, and none is printed.** `stack.env.example` ships placeholders under
`example.com`; the real ones live only in the Portainer stack. Nothing in the pipeline needs them, so
nothing carries them.

That second half matters as much as the first: **this repository is public, and on a public
repository the workflow log and the job summary are readable by anyone without signing in.** Storing
a hostname in a repository variable does not make printing it private — it is the printing that
publishes it. So the deploy summary reports branch, commit, tags and test result, all of which are
public in this repo anyway, and no URL. Likewise the webhook step never lets curl's stderr reach the
log, because a DNS failure would quote the Portainer host, and GitHub's secret redaction matches the
whole URL rather than a fragment of it.

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

## Deploying

**Actions → Deploy to dev → Run workflow.** Pick the branch from the dropdown — that is the branch
picker; there is no separate input for it.

| Input | Default | |
|---|---|---|
| `run_tests` | true | Untick to skip the suite for a hotfix. |
| `image_tag` | `dev` | The moving tag the stack follows. Change it to build an image without deploying it. |

Every run also pushes an immutable `sha-<commit>` tag, and writes what it built to the run summary.

The branch dropdown only lists branches that already contain `.github/workflows/deploy-dev.yml`. A
branch cut before this landed needs a rebase onto `main` before it can be deployed.

### Rolling back

Set `IMAGE_TAG` to the `sha-<commit>` you want in the stack's environment variables and redeploy.
`docker image ls` on the server, or the GHCR package page, will list what is available.

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
MEDIA_PATH=/srv/video-prd/media
DERIVED_PATH=/srv/video-prd/derived
```

with its own secrets. `STACK_NAME` keeps the container names and Traefik routers distinct, and the
two stacks share nothing — separate database container, separate volumes, separate storage.

Then copy `deploy-dev.yml` to `deploy-prd.yml`, change the default `image_tag` to `prd` and the
secret to `PORTAINER_WEBHOOK_PRD`.

## Known gaps

- **Nothing backs up the `pgdata` volume.** The media files are on the host and survive anything, but
  every account, watch position, comment and curated list lives only in that volume. A
  `pg_dump` on a schedule is the obvious next thing to add.
- **Playwright is not in CI.** `.github/workflows/tests.yml` runs the three API tiers and the web unit
  tests; the browser suite needs both dev servers plus a Chromium download and was left out of the
  first pass. It is the highest-value thing to add next, because it is the only tier that catches a
  page that renders and does nothing.

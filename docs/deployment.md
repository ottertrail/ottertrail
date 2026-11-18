# Deployment

How to run Ottertrail on one server, and the decisions behind it. The hosted service is one such deployment serving every organization; a self-hosted install is the same stack, usually with one organization. Events, traces, logs, and metrics are stored in ClickHouse, where reports read them ([clickhouse.md](clickhouse.md)); PostgreSQL holds accounts, organizations, projects, and settings.

Status: tested on one machine with Podman (see [What has been tested](#what-has-been-tested)). Nothing runs in production yet, and backups are manual.

## What runs

`deploy/compose.yaml` starts six services, and a seventh with the `object-store` profile ([source maps](#source-maps)), from the [Dockerfile](../Dockerfile) at the repository root, which builds one image for all of Ottertrail, [deploy/Caddyfile](../deploy/Caddyfile), and ClickHouse's settings in [deploy/clickhouse/](../deploy/clickhouse/).

| Service      | What it does                                                                                                                                                                   | Reachable from outside |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `postgres`   | PostgreSQL 18, data in the `postgres-data` volume                                                                                                                              | No                     |
| `clickhouse` | ClickHouse 26.8, for analytics events and later logs and traces, data in `clickhouse-data`. Capped at 40% of the server's memory (see below)                                   | No                     |
| `migrate`    | Brings both databases' schemas up to date, then exits. The API and the worker start only after it succeeds                                                                     | No                     |
| `api`        | The API, the dashboard's files, and the tracker (`/t.js`), on port 3000 inside the stack. Geolocation file in `geo-data`                                                       | No, only through Caddy |
| `worker`     | Background work: deletes events past each project's retention and those of deleted projects, and joins session replays                                                         | No                     |
| `caddy`      | HTTPS: gets and renews the certificate, redirects HTTP to HTTPS, compresses responses, passes every request to the API                                                         | Ports 80 and 443       |
| `garage`     | Only with `--profile object-store`: [Garage](https://garagehq.deuxfleurs.fr/) (AGPL-3.0), an S3-compatible store for source maps, in `garage-data`. About 10 MB of memory idle | No                     |

Idle, the stack without ClickHouse used about 160 MB of memory (API 100 MB, PostgreSQL 27 MB, worker 18 MB, Caddy 14 MB), measured with the test data below. The image is about 290 MB, almost all of it Node.js's own image. No sizing under real traffic has been measured.

ClickHouse's defaults assume a machine of its own with 16 GB or more, and its own sizing guide puts 8 GB as the floor. `deploy/clickhouse/` sets it up to share a server of about 8 GB: at most 40% of the memory it could have (its own plus what is free, worked out again as it runs, so it leaves more to other services as they grow), a 512 MiB mark cache instead of 5 GiB, internal logs Ottertrail never reads switched off, at most 1 GB per query, and large sorts and groupings continued on disk past 400 MB instead of failing ([storage benchmark](storage-benchmark.md)). Plan on 8 GB: on 2 GB, ClickHouse was killed for lack of memory at 6 million events.

## What you need

- A Linux server with Docker Engine and the Docker Compose plugin. Podman with `podman compose` works too (that is what was tested).
- A domain or subdomain for the instance, such as `analytics.example.com`, with its DNS A record (and AAAA, for IPv6) pointing at the server.
- Ports 80 and 443 open to the internet: Caddy needs them to get a certificate from Let's Encrypt, and sites send events to 443. Nothing else needs to be open besides SSH.
- This repository on the server, at the release to run.

## First start

```sh
cd ottertrail/deploy
cp env.example .env
chmod 600 .env
```

Edit `.env`: set `OTTERTRAIL_DOMAIN`, then fill `POSTGRES_PASSWORD`, `CLICKHOUSE_PASSWORD`, and `AUTH_SECRET` with the output of `openssl rand -hex 32` (a different value each). Hex keeps the password safe inside the database URL. `TIMEZONE` is the timezone of the first organization, the one the setup link creates; its owner can change it later in the organization's settings.

```sh
docker compose build migrate
docker compose up -d
docker compose ps
```

The first command builds the image that `migrate`, `api`, and `worker` share, once. `docker compose up -d --build` would work too, but podman-compose builds it once for each of the three, all at the same time, and on a 2 GB machine that ran out of memory. `migrate` should show "Exited (0)" and `api` "healthy". The build installs every development dependency inside the image and takes a few minutes; one of those three builds finished in Podman's 2 GB machine, but a small server may need swap or a build elsewhere (see [Images](#images)).

Create the owner account, then download what the API knows about IP addresses:

```sh
docker compose exec api node dist/setup.mjs
docker compose exec api node dist/update-geo.mjs
docker compose up -d --force-recreate --no-deps api
```

`setup.mjs` prints a link, valid for an hour, that creates the owner. `update-geo.mjs` saves DB-IP's location database (about 130 MB) and the address ranges of cloud and hosting providers (about 400 KB) in the `geo-data` volume; the API reads both at startup, hence the restart. Without them, events are stored without a location, and events from cloud servers are not recognized ([web analytics](web-analytics.md#data-centers)). DB-IP publishes a new file each month, and providers add ranges every week: run the last two commands again monthly. The API warns at startup when either file is missing or old.

The last command restarts only the API by recreating its container. `docker compose restart api` is the usual way, but Podman refuses it because `migrate` has exited.

## Updating

```sh
git fetch && git checkout <release>
docker compose build migrate
docker compose up -d
```

Compose rebuilds the image, runs `migrate`, and replaces the API and the worker. The API is unavailable for a few seconds while its container is replaced; the tracker retries events it could not send.

Updating from a release where events still arrived in PostgreSQL (before 18 November 2026): run `docker compose stop api worker` first. `migrate` copies the events PostgreSQL has not copied to ClickHouse yet, then drops PostgreSQL's events table, and never drops one ClickHouse lacks: if the old API keeps storing events in between, it copies again, and after 5 tries stops and asks for the API and the worker to be stopped ([ClickHouse](clickhouse.md#upgrading-from-postgresql-first)). The tracker retries what it could not send meanwhile.

With `OTTERTRAIL_IMAGE` set, update with `docker compose pull` and then `docker compose up -d` instead, never with `--build`: that would build this checkout and tag it with the registry image's name.

To go back to an earlier release, check it out and run the same command, as long as no migration ran in between. The deployment only runs migrations forward, and an older release may not work with a newer schema: after a migration, restore the backup taken before the update.

## Backups

Not automated yet. Before each update, and regularly, in `deploy/`:

```sh
./backup.sh
```

It writes two files into `deploy/backups/`, named by the time: `ottertrail-<time>.zip`, ClickHouse's backup of the events (its own `BACKUP DATABASE`), and `ottertrail-<time>.dump`, PostgreSQL's (`pg_dump`: accounts, organizations, projects, and settings). The instance keeps running. PostgreSQL's dump comes first, so every project in it has its events in ClickHouse's backup ([ClickHouse](clickhouse.md#backups)). ClickHouse writes its backup into its own volume, and the script then moves it out, so the disk needs free space of about twice ClickHouse's data while it runs. The files are readable only by the user who ran the script, and a run that fails leaves no file that looks like a backup. Copy both files off the server: a backup on the same disk is lost with it. Delete old ones yourself; they hold your customers' data, and events deleted since stay in them.

To restore into empty databases (a new server, or after `docker compose down -v`), with both files in `deploy/backups/`:

```sh
./restore.sh backups/ottertrail-2026-11-17T062707Z
```

It starts only PostgreSQL and ClickHouse, restores both, then starts the rest. PostgreSQL's restore runs as one transaction, so a failure leaves it empty rather than half restored. The databases must be empty and not yet migrated: ClickHouse refuses to restore into a table that holds data, and the migrations record themselves in one. If a restore fails, run `docker compose down -v` and start again.

A backup from before 18 November 2026 still holds PostgreSQL's last two days of events. `restore.sh` marks them all as not copied, since ClickHouse's backup, taken separately, may lack the last ones; `migrate`, which it runs with the rest, then copies them to ClickHouse, where each event counts once, and drops the table ([ClickHouse](clickhouse.md#upgrading-from-postgresql-first)).

With Podman, run both as `COMPOSE="podman compose" ./backup.sh`.

Restoring PostgreSQL alone, or moving it to a new major version (dump, new volume, restore), needs the worker stopped until PostgreSQL holds its data again (`docker compose stop worker`). A worker that finds PostgreSQL empty, or holding the wrong instance's data, deletes no events from ClickHouse, but logs an error ([clickhouse.md](clickhouse.md#retention-and-deleting-a-project)).

## Settings

`.env` holds only what differs between instances. Compose sets the rest (see the [API's configuration](../README.md#configuration)).

| Variable              | Meaning                                                                                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTTERTRAIL_DOMAIN`   | The instance's domain, without `https://`. The public URL is `https://` and this domain                                                                                                                                                   |
| `POSTGRES_PASSWORD`   | The database password. Only the containers use it; PostgreSQL has no port open. PostgreSQL keeps the password it was first created with: to change it, run `ALTER USER ottertrail PASSWORD '…'` in the database first, then change `.env` |
| `CLICKHOUSE_PASSWORD` | ClickHouse's password. Only the containers use it; ClickHouse has no port open. Like PostgreSQL's, it is set when ClickHouse first creates its data                                                                                       |
| `AUTH_SECRET`         | Signs sign-in cookies. Changing it signs everyone out                                                                                                                                                                                     |
| `TIMEZONE`            | The IANA timezone, such as `Europe/Berlin`, of the organization the setup link creates. Default `UTC`                                                                                                                                     |
| `LOG_LEVEL`           | Optional, default `info`                                                                                                                                                                                                                  |
| `OTTERTRAIL_IMAGE`    | Optional: an image to run instead of building this checkout, such as one from a registry                                                                                                                                                  |

Compose stops with "set … in .env" when a required one is missing.

### Source maps and session replays

Source maps turn minified stack traces back into a site's own code ([errors](errors.md#5-source-maps)), and session replays show what a visitor did before an error ([session replay](session-replay.md)). Both need an S3-compatible object store; without one, they are off and everything else works. Either:

- **Garage on the same server.** Generate the store's access key and Garage's own secret, put them in `.env` with `OBJECT_STORE_URL`, and start the stack with the `object-store` profile:

  ```sh
  printf 'OBJECT_STORE_URL=http://garage:3900\n' >> .env
  printf 'OBJECT_STORE_ACCESS_KEY_ID=GK%s\n' "$(openssl rand -hex 12)" >> .env
  printf 'OBJECT_STORE_SECRET_ACCESS_KEY=%s\n' "$(openssl rand -hex 32)" >> .env
  printf 'GARAGE_RPC_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
  docker compose --profile object-store up -d
  ```

  Garage creates its bucket (`OBJECT_STORE_BUCKET`, default `ottertrail`) and that key on its first start, from the same settings the API reads. Give `--profile object-store` to every later `docker compose` command too (`pull`, `up`, `down`), or set `COMPOSE_PROFILES=object-store` in `.env`, which Docker Compose reads.

- **Cloudflare R2, Amazon S3, or another S3-compatible store.** Create a bucket and an access key for it there, set `OBJECT_STORE_URL` to its endpoint (for R2, `https://<account ID>.r2.cloudflarestorage.com`), `OBJECT_STORE_REGION` (`auto` for R2), `OBJECT_STORE_BUCKET`, `OBJECT_STORE_ACCESS_KEY_ID`, and `OBJECT_STORE_SECRET_ACCESS_KEY`, and leave the profile off.

`SOURCE_MAP_BYTES_PER_ORGANIZATION` limits each organization's compressed maps, 1 GiB by default, and `REPLAY_BYTES_PER_ORGANIZATION` its compressed replays, 2 GiB by default (a first guess, until measured on real sites). Replays are kept 30 days. The API logs `OBJECT_STORE_URL is not set: source maps are off` at start when there is no store; a project's replay setting then says replays are off on the install.

### Traces, logs, and metrics

A server sends them to the instance's address over OTLP/HTTP, with its project's secret key ([telemetry](telemetry.md#receiving)); Caddy passes `/v1/traces`, `/v1/logs`, and `/v1/metrics` to the API like every other path, and nothing needs to be set. ClickHouse keeps them `TELEMETRY_RETENTION_DAYS`, 30 by default (1 to 365), and drops whole days past it on its own. After changing it, run `docker compose up -d`, as for an [update](#updating): `migrate` applies it to ClickHouse's tables, and the API, which refuses records older than it, restarts with it.

Containers keep at most 50 MB of logs each (`docker compose logs api` shows them). The API and the worker log one JSON object per line.

### One organization

An install is the same software as a hosted service with many customers: organizations, memberships, and the access check on every project route are all there. A self-hosted install runs one organization, the one its setup link creates: nobody can sign up (open sign-up, for a hosted service, is not built), invitations are not built yet, and the dashboard offers no second organization. Nothing needs to be set for that; a later setting to allow sign-up (off unless a deployment turns it on) will keep it so.

## Decisions

**One image, one process for all of the instance's paths.** The API serves the dashboard's built files (`apps/api/src/dashboard-app/`), the tracker, and the API from one origin, so the dashboard needs no CORS. Caddy only does HTTPS. The image can also run without Caddy, on a platform that runs Docker images and provides HTTPS. It then needs `DATABASE_URL`, `PUBLIC_URL`, and `AUTH_SECRET`; `TRUST_PROXY` set to the number of proxies the platform puts in front of it, or every visitor seems to come from the platform's proxy (one rate limit, one visitor ID, and one location for all); `node dist/migrate.mjs` before each release; and the worker (`node dist/worker.mjs`) as a second process. None of this has been tried on a platform. Files under `/assets/` have content-hashed names and are cached for a year; `index.html` is revalidated on every load, so a new release shows at once. Any other path without a file extension, outside `/api/`, answers with `index.html` for the dashboard's router; a missing file stays a 404.

**Dependencies bundled into the API.** `vp pack` puts the API's dependencies into `dist/`, so the image holds Node.js, about 10 MB of JavaScript, and the dashboard's files, and no `node_modules`. Installing them with `pnpm deploy --prod` took 182 MB instead: pnpm resolves better-auth's optional peer dependencies from the workspace, so React, Vitest, Playwright, and TypeScript came along. Bundling drops each package's `LICENSE` file, so each build writes `THIRD_PARTY_LICENSES.txt` listing every bundled package with its licence (`scripts/third-party-licenses.ts`). The dashboard's copy is served at `/THIRD_PARTY_LICENSES.txt`.

**Security headers on the dashboard.** Its files carry a Content Security Policy that allows only the instance's own scripts, styles, fonts, and requests, plus `data:` images and fonts (Vite inlines files under 4 KB). `frame-ancestors 'none'` and `X-Frame-Options: DENY` stop other sites from framing it; `Referrer-Policy: same-origin` keeps project IDs and filters in dashboard URLs from reaching other sites. With an HTTPS public URL, `Strict-Transport-Security` tells browsers to use HTTPS for a year; not for `localhost`, where a stored entry would break plain-HTTP development servers. The tracker and the API's JSON answers do not carry the dashboard's policy: sites on other origins load the tracker.

**Client addresses.** Caddy replaces any `X-Forwarded-For` a client sends with the address it sees, and the API trusts exactly one proxy hop (`TRUST_PROXY=1`). Rate limits and the visitor ID therefore see the real address, and a client cannot fake one. Tested: an event sent through Caddy with `X-Forwarded-For: 8.8.8.8` got no location, while the same header sent to the API from inside the stack was placed in the US. Putting a CDN or another proxy in front of Caddy breaks this: every request would seem to come from the CDN. That needs Caddy's `trusted_proxies` and one more hop, and is not set up.

**Migrations as their own step.** The `migrate` service runs before the API and the worker start, and they wait for it to succeed. The API never migrates on startup, so two API processes could never race to change the schema.

**Its own Compose project name.** The stack is named `ottertrail-instance`, not `ottertrail`: the development stack (`compose.yaml` at the root) uses that name, and the two would share a database volume on a developer's machine.

## Images

The Compose file builds the image on the server from the checkout. Building needs the full development toolchain, so it is slower and heavier than running. The alternative, not set up yet, is to build each release once in CI, for `linux/amd64` and `linux/arm64`, push it to a registry, and set `OTTERTRAIL_IMAGE` on each server; every instance then runs the identical image.

```sh
docker build -t ottertrail:local .   # at the repository root
```

An image built on an Apple Silicon Mac is for ARM servers; add `--platform linux/amd64` for most VPS providers (slow, through emulation).

## What has been tested

On macOS with Podman 6.2 and podman-compose 1.6, with `OTTERTRAIL_DOMAIN=localhost` (Caddy then uses its own local certificate authority):

- The stack starts in order: PostgreSQL healthy, migrations, then the API (healthy) and the worker.
- HTTP redirects to HTTPS; pages come over HTTP/2 with the security headers above; the tracker is compressed.
- In headless Chromium: the setup link creates the owner, a project is created, a test site on another origin loads `/t.js` and sends pageviews and time on page, and the analytics page shows them. Signing out and in again works; the session cookie is `__Secure-`, `Secure`, `HttpOnly`, and `SameSite=Lax`. No page broke the Content Security Policy.
- `update-geo.mjs` fills the volume, and the recreated API loads the file.
- `docker compose down` then `up` (without `-v`) keeps the events, the owner, and the geolocation file.
- A backup with `pg_dump`, then `down -v` (deleting every volume), then restoring, gave back every event and the owner's sign-in, before events moved to ClickHouse.
- A spoofed `X-Forwarded-For` sent through Caddy is ignored (see "Client addresses").

With ClickHouse in the stack (17 November 2026), driving the API from inside the stack, without Caddy (rootless Podman cannot open ports 80 and 443 without changing a setting of its machine):

- `build migrate` builds the image once, and `up -d` starts the stack from it: both databases healthy (ClickHouse's health check no longer puts its password on a command line), both migrated, then the API and the worker. The worker copies events to ClickHouse within seconds, and the analytics report reads them there (3 visitors, 6 pageviews, 3 visits, the right pages).
- Deleting a project: the trigger records it, its events leave reports within half a minute, and they leave ClickHouse's disk with the next retention run (the worker runs one at start). The other project keeps its own.
- `backup.sh`, then `down -v`, then `restore.sh`: the same report, and sign-in still works. After the worker sent PostgreSQL's events again, ClickHouse held 12 rows for 6 events and reported 6. The deleted project stayed deleted. The backup files are readable by their owner only. A backup that failed (PostgreSQL stopped) left no file behind, here or in ClickHouse's volume, and `restore.sh` refuses a name that is not a backup's.
- On the first try, the restore failed: ClickHouse's image answers queries from a temporary server while it sets itself up on an empty volume, and the restore reached it in between. `restore.sh` now waits for the real server.
- `up -d --build` failed on Podman's 2 GB machine: podman-compose built the shared image once for each of the three services that use it, at the same time, and two of the builds ran out of memory. The third finished, hence `build migrate` first in [First start](#first-start). The later `build migrate` reused that build's cached layers, so a build from scratch alone was not timed.
- The `object-store` profile (18 November 2026, Podman): without it, the stack has no Garage; with it, Garage started from this file healthy, and created its bucket and access key from the settings. Uploading, reading, and deleting source maps were tested against the development stack's Garage (the same image and `deploy/garage/garage.toml`), not yet inside this stack.

Not tested yet: the stack since events go straight to ClickHouse (18 November 2026), including an upgrade that copies PostgreSQL's remaining events and a backup and restore without them; the whole stack with the `object-store` profile, Docker Engine and Docker Compose on a Linux server, a real domain with a Let's Encrypt certificate, an `amd64` image, an update that runs a migration on existing data, and a restore on a new server.

## Known limitations

- No automated or off-site backups.
- The backups leave out the object store (Garage's `garage-data`, or the bucket elsewhere): after a restore, upload the source maps of the releases still in use again. Garage runs as one node, without copies of its data on other servers.
- The geolocation database and the data-center ranges are updated by hand, monthly.
- One server: no failover, and a few seconds of downtime for each update.
- No image registry or CI builds: each server builds its own image.
- One deployment per server. Two stacks on one host would both need ports 80 and 443; sharing a host needs one proxy in front of both, not set up.
- No CDN or proxy in front of Caddy (see "Client addresses").
- The API prints one line that is not JSON at startup: a warning from its JSON schema validator about union types.

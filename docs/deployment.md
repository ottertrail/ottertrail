# Deployment

How to run Ottertrail on one server, and the decisions behind it. Each customer runs an instance of their own, hosted or self-hosted, on this same stack. Events, traces, logs, and metrics are stored in ClickHouse, where reports read them ([clickhouse.md](clickhouse.md)); PostgreSQL holds accounts, projects, and settings.

Status: tested on one machine with Podman (see [What has been tested](#what-has-been-tested)). Nothing runs in production yet, and backups are manual.

## What runs

[deploy/compose.yaml](../deploy/compose.yaml) starts six services, and a seventh, Garage, with the `object-store` profile, which `example.env` turns on ([session replays and source maps](#session-replays-and-source-maps)). The API, the worker, and the migrations run one image, built from the [Dockerfile](../Dockerfile) for each release and published as `ghcr.io/ottertrail/ottertrail` ([Images and releases](#images-and-releases)). The settings of Caddy, ClickHouse, and Garage are inside the Compose file (`configs:`), so the file works on its own, next to its `.env`.

| Service      | What it does                                                                                                                                                                                                                  | Reachable from outside |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `postgres`   | PostgreSQL 18, data in the `postgres-data` volume                                                                                                                                                                             | No                     |
| `clickhouse` | ClickHouse 26.8, for analytics events and later logs and traces, data in `clickhouse-data`. Capped at 40% of the server's memory (see below)                                                                                  | No                     |
| `migrate`    | Brings both databases' schemas up to date, then exits. The API and the worker start only after it succeeds                                                                                                                    | No                     |
| `api`        | The API, the dashboard's files, and the tracker (`/t.js`), on port 3000 inside the stack. Geolocation file in `geo-data`                                                                                                      | No, only through Caddy |
| `worker`     | Background work: runs uptime checks, evaluates alert rules and sends their notifications, deletes events past each project's retention and those of deleted projects, and joins session replays                               | No                     |
| `caddy`      | HTTPS: gets and renews the certificate, redirects HTTP to HTTPS, compresses responses, passes every request to the API                                                                                                        | Ports 80 and 443       |
| `garage`     | With the `object-store` profile, which `example.env` turns on: [Garage](https://garagehq.deuxfleurs.fr/) (AGPL-3.0), an S3-compatible store for session replays and source maps, in `garage-data`. About 10 MB of memory idle | No                     |

Idle, the whole stack with Garage used about 425 MB of memory on 18 November 2026 (ClickHouse 158 MB, API 146 MB, worker 54 MB, PostgreSQL 39 MB, Caddy 23 MB, Garage 6 MB), measured with the test data below. The image is about 300 MB, almost all of it Node.js's own image. No sizing under real traffic has been measured.

ClickHouse's defaults assume a machine of its own with 16 GB or more, and its own sizing guide puts 8 GB as the floor. The Compose file's ClickHouse settings (`clickhouse-config` and `clickhouse-users`) set it up to share a server of about 8 GB: at most 40% of the memory it could have (its own plus what is free, worked out again as it runs, so it leaves more to other services as they grow), a 512 MiB mark cache instead of 5 GiB, internal logs Ottertrail never reads switched off, at most 1 GB per query, and large sorts and groupings continued on disk past 400 MB instead of failing ([storage benchmark](storage-benchmark.md)). Plan on 8 GB: on 2 GB, ClickHouse was killed for lack of memory at 6 million events.

## What you need

- A Linux server with Docker Engine and Docker Compose 2.23.1 or later (`docker compose version`). The Compose file holds its settings files inline (`configs:` with `content:`), which Docker Compose reads from 2.23.1 on ([Compose's reference](https://docs.docker.com/reference/compose-file/configs/)).
- Podman works with Docker Compose too: `podman compose` runs Docker Compose when it is installed (`PODMAN_COMPOSE_PROVIDER` chooses), or point Docker Compose at Podman's socket with `DOCKER_HOST`. Use Docker Compose 2.23.1 or later there too. podman-compose does not work: version 1.6 skips inline configs without a warning, so Caddy, ClickHouse, and Garage start without their settings, and Garage stops at once ([What has been tested](#what-has-been-tested)).
- A domain or subdomain for the instance, such as `analytics.example.com`, with its DNS A record (and AAAA, for IPv6) pointing at the server.
- Ports 80 and 443 open to the internet: Caddy needs them to get a certificate from Let's Encrypt, and sites send events to 443. Nothing else needs to be open besides SSH.

No checkout of this repository is needed. An install is a folder with four files from a release, and the `.env` made from one of them.

## First start

Make a folder, and download the release's files into it: `compose.yaml` and `example.env`, and the backup scripts.

```sh
mkdir ottertrail && cd ottertrail
curl -fLO https://github.com/ottertrail/ottertrail/releases/latest/download/compose.yaml
curl -fLO https://github.com/ottertrail/ottertrail/releases/latest/download/example.env
curl -fLO https://github.com/ottertrail/ottertrail/releases/latest/download/backup.sh
curl -fLO https://github.com/ottertrail/ottertrail/releases/latest/download/restore.sh
chmod +x backup.sh restore.sh
cp example.env .env
chmod 600 .env
```

While the repository is private, these links answer 404 without a GitHub sign-in, and the image needs one too:

- Download the files with the [GitHub CLI](https://cli.github.com/), signed in with `gh auth login`: `gh release download --repo ottertrail/ottertrail --pattern compose.yaml --pattern example.env --pattern backup.sh --pattern restore.sh` takes the latest release; put a release's tag (`vX.Y.Z`) before `--repo` for another. Without the CLI, GitHub's API serves each file with a token: list the release's files with `curl -fsSL -H "Authorization: Bearer $TOKEN" https://api.github.com/repos/ottertrail/ottertrail/releases/latest`, then download each from its `url` with the same header and `-H "Accept: application/octet-stream"`.
- Log in to the registry once, with a GitHub token that can only read packages (a classic token with `read:packages`): `echo "$TOKEN" | docker login ghcr.io -u <GitHub user> --password-stdin`.

Edit `.env`:

- `OTTERTRAIL_DOMAIN`: the instance's domain.
- `POSTGRES_PASSWORD`, `CLICKHOUSE_PASSWORD`, `AUTH_SECRET`, `OBJECT_STORE_SECRET_ACCESS_KEY`, and `GARAGE_RPC_SECRET`: the output of `openssl rand -hex 32`, a different value each. Hex keeps the password safe inside the database URL.
- `OBJECT_STORE_ACCESS_KEY_ID`: the output of `printf 'GK%s\n' "$(openssl rand -hex 12)"`, the form Garage's keys take.

`example.env` turns on the stack's own object store, Garage, for session replays and source maps. To use another store, or none, see [Session replays and source maps](#session-replays-and-source-maps) before the first start. Alert email is optional ([Alert email](#alert-email)). The instance's timezone is chosen on the setup page; the owner can change it later on the dashboard's Settings page.

```sh
docker compose up -d
docker compose ps
```

Compose pulls the images, then starts the databases, `migrate`, the API, the worker, and Caddy. `migrate` should show "Exited (0)" and `api` "healthy", and with Garage, `garage` "healthy". The domain and the three passwords are checked first: Compose stops before anything starts, with "set … in .env". The object store's settings are checked as the services start ([Missing settings](#missing-settings)).

Create the owner account, then download what the API knows about IP addresses:

```sh
docker compose exec api node dist/setup.mjs
docker compose exec api node dist/update-geo.mjs
docker compose up -d --force-recreate --no-deps api
```

`setup.mjs` prints a link, valid for an hour, that creates the owner. Teammates join by invitation links from the dashboard's Members page ([access](access.md)). An account whose password is lost gets a reset link from the Members page, or from the server: `docker compose exec api node dist/reset-password.mjs <email>` prints one, valid for an hour. `update-geo.mjs` saves DB-IP's location database (about 130 MB) and the address ranges of cloud and hosting providers (about 400 KB) in the `geo-data` volume; the API reads both at startup, hence the restart. Without them, events are stored without a location, and events from cloud servers are not recognized ([web analytics](web-analytics.md#data-centers)). DB-IP publishes a new file each month, and providers add ranges every week: run the last two commands again monthly. The API warns at startup when either file is missing or old.

The last command restarts only the API by recreating its container. `docker compose restart api` is the usual way, but Podman refuses it because `migrate` has exited.

## Updating

Back up first ([Backups](#backups)). Then replace `compose.yaml` with the new release's, and the backup scripts with its own, the same way as at the first start. Then:

```sh
docker compose pull
docker compose up -d
```

Compose pulls the new image, runs `migrate`, and replaces the API and the worker. The API is unavailable for a few seconds while its container is replaced; the tracker retries events it could not send. Read the release's notes first: a release whose `compose.yaml` adds a required setting names it there, and Compose stops until `.env` has it.

`OTTERTRAIL_VERSION` in `.env` chooses the release instead: each release's `compose.yaml` runs its own release by default, and `OTTERTRAIL_VERSION=0.2.0` runs 0.2.0 with the `compose.yaml` already there. That works while the Compose file itself has not changed between the two; the release notes say when it has.

To go back to an earlier release, use its `compose.yaml` (or its version in `OTTERTRAIL_VERSION`) and run the same commands, as long as no migration ran in between. The deployment only runs migrations forward, and an older release may not work with a newer schema: after a migration, restore the backup taken before the update.

## Backups

Not automated yet. Before each update, and regularly, in the install's folder:

```sh
./backup.sh
```

It writes three files into `backups/` beside it, named by the time:

- `ottertrail-<time>.zip`: ClickHouse's backup of the events, traces, logs, and metrics (its own `BACKUP DATABASE`).
- `ottertrail-<time>.dump`: PostgreSQL's (`pg_dump`): accounts, projects, and settings.
- `ottertrail-<time>-objects.tar`: the object store's source maps and session replays. When the instance has no object store, the tar holds only a manifest that says so.

The instance keeps running. PostgreSQL's dump comes first, so every project in it has its events in ClickHouse's backup ([ClickHouse](clickhouse.md#backups)). The object store comes last. A one-off container of the app's image runs `dist/backup-objects.mjs` with the API's own settings, so the API and the backup always agree on whether there is a store. It lists every object in the bucket and streams each into its own file, with a manifest of each object's key, size, content type, and SHA-256. The script then packs them into the tar on the server. Because the instance keeps running:

- An object written after PostgreSQL's dump can be in the tar while nothing in the dump refers to it. That is harmless: it only takes space.
- An object deleted in between, such as a replay that expired or a deleted project's map, is listed but no longer there. It is left out, and the script says how many. That is the same as if it had expired before the backup.

The files are readable only by the user who ran the script. A run that fails says which step failed, and leaves no file that looks like a backup: each file is written under a temporary name, and all three are renamed only when all three are complete. A failed object step also discards the finished `.zip` and `.dump`.

Disk space for a backup: ClickHouse writes its backup into its own volume, and the script then moves it out, so the disk needs free space of about twice ClickHouse's data. The objects need about twice their size too: once as files, once in the tar. Copy all three files off the server: a backup on the same disk is lost with it. Delete old ones yourself; they hold your customers' data, and events deleted since stay in them.

Both scripts run Compose in their own folder, next to `compose.yaml` and `.env`, wherever they are called from. To restore into empty databases (a new server, or after `docker compose down -v`), with the three files in `backups/`:

```sh
./restore.sh backups/ottertrail-2026-11-17T062707Z
```

It works in this order:

1. It checks the object backup before it changes anything. It unpacks the tar next to the backup, starts the stack's Garage when the `object-store` profile is on, and runs `dist/restore-objects.mjs --check`. That reads the manifest, checks every file against it (a regular file, not a link; its size; its SHA-256), refuses objects when no object store is set up, and waits up to a minute for the bucket to answer. A damaged tar, a missing store, or a store that cannot be reached stops the restore here, with the databases untouched.
2. It starts only PostgreSQL and ClickHouse, and restores both.
3. It runs `dist/restore-objects.mjs`, which checks everything again, then puts each object back under its key and content type. Each upload carries the file's MD5 (`Content-MD5`), so the store itself refuses bytes that differ from the checked file. An upload that fails because the store did not answer, or answered with a server error, is tried again, up to four times, from the file. The objects go back before the worker starts, because the worker deletes expired replays.
4. It starts the rest.

- PostgreSQL's restore runs as one transaction, so a failure leaves it empty rather than half restored.
- The databases must be empty and not yet migrated: ClickHouse refuses to restore into a table that holds data, and the migrations record themselves in one. If a restore fails after step 1, the script says that the databases were changed: run `docker compose down -v` and start again.
- The bucket does not need to be empty. An object with the same key is replaced; other objects stay.
- If the `-objects.tar` is missing, the script refuses. To restore without the source maps and session replays, run it with `--without-objects` first: `./restore.sh --without-objects backups/ottertrail-…`. Replays then do not play, and source maps must be uploaded again.
- A backup made without an object store restores no objects, into an instance with a store or without one.

Disk space for a restore: the three files, plus the unpacked objects, about as large as their tar, until the restore ends.

Both run `docker compose`. `COMPOSE` replaces it, such as `COMPOSE="podman compose" ./backup.sh`. The `object-store` profile comes from `COMPOSE_PROFILES` in `.env`, as `example.env` sets it. Without it, `restore.sh` does not start Garage, and its check stops after a minute because the bucket does not answer.

The one-off containers run as the user who runs the script (`-u` with its user and group IDs), so the files they write are that user's. That suits Docker running as root, and Podman on macOS, where it was tested. Rootless Docker and rootless Podman on Linux map container users to other IDs, so there the container may not be able to write into `backups/`, or read the unpacked objects; this is not tested. The bind mounts carry `:z`, which SELinux hosts (Fedora, RHEL) need so the container may use the folder; other hosts ignore it. Podman on macOS was tested with it; an SELinux host was not.

Restoring PostgreSQL alone, or moving it to a new major version (dump, new volume, restore), needs the worker stopped until PostgreSQL holds its data again (`docker compose stop worker`). A worker that finds PostgreSQL empty, or holding the wrong instance's data, deletes no events from ClickHouse, but logs an error ([clickhouse.md](clickhouse.md#retention-and-deleting-a-project)).

## Settings

`.env` holds only what differs between instances. Compose sets the rest (see the [API's configuration](../README.md#configuration)).

| Variable              | Meaning                                                                                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTTERTRAIL_DOMAIN`   | The instance's domain, without `https://`. The public URL is `https://` and this domain                                                                                                                                                   |
| `POSTGRES_PASSWORD`   | The database password. Only the containers use it; PostgreSQL has no port open. PostgreSQL keeps the password it was first created with: to change it, run `ALTER USER ottertrail PASSWORD '…'` in the database first, then change `.env` |
| `CLICKHOUSE_PASSWORD` | ClickHouse's password. Only the containers use it; ClickHouse has no port open. Like PostgreSQL's, it is set when ClickHouse first creates its data                                                                                       |
| `AUTH_SECRET`         | Signs sign-in cookies. Changing it signs everyone out                                                                                                                                                                                     |
| `LOG_LEVEL`           | Optional, default `info`                                                                                                                                                                                                                  |
| `OTTERTRAIL_VERSION`  | Optional: the release to run, such as `0.2.0`. Each release's `compose.yaml` runs its own release when this is unset ([Updating](#updating))                                                                                              |
| `COMPOSE_PROFILES`    | `object-store` in `example.env`: Docker Compose then starts Garage ([session replays and source maps](#session-replays-and-source-maps))                                                                                                  |
| `OBJECT_STORE_…`      | The object store for session replays and source maps, and its keys ([session replays and source maps](#session-replays-and-source-maps))                                                                                                  |
| `SMTP_URL`            | Optional: the SMTP server alert email goes through, with its user name and password ([alert email](#alert-email)). Never logged                                                                                                           |
| `EMAIL_FROM`          | The sender of alert email, required with `SMTP_URL`                                                                                                                                                                                       |

Compose stops with "set … in .env" when `OTTERTRAIL_DOMAIN`, `POSTGRES_PASSWORD`, `CLICKHOUSE_PASSWORD`, or `AUTH_SECRET` is missing.

### Missing settings

The object store's settings are required only in some installs, so Compose passes them on as they are, and the services check them as they start. Compose cannot check them for only those installs: that needs a check inside a condition, which Docker Compose before 5.0.2 evaluates in every install.

| Missing                                                                                       | What happens                                                                                                                                                                                                                          | Where it shows                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `OBJECT_STORE_ACCESS_KEY_ID` or `OBJECT_STORE_SECRET_ACCESS_KEY`, with `OBJECT_STORE_URL` set | `migrate` stops, and `docker compose up -d` ends with `service "migrate" didn't complete successfully: exit 1`. The API and the worker do not start: they make the same check                                                         | `docker compose logs migrate`: `ConfigError: OBJECT_STORE_ACCESS_KEY_ID and OBJECT_STORE_SECRET_ACCESS_KEY are required with OBJECT_STORE_URL` |
| `GARAGE_RPC_SECRET`, with Garage on                                                           | Garage stops at once and restarts again and again; everything else starts, and uploads of replays and source maps fail. Garage's message does not name the setting: it is `GARAGE_RPC_SECRET`, 64 hex digits (`openssl rand -hex 32`) | `docker compose logs garage`: `Error: Invalid RPC secret key: expected 32 bytes of random hex`                                                 |

After filling in the setting, run `docker compose up -d` again.

### Session replays and source maps

Session replays show what a visitor did before an error ([session replay](session-replay.md)), and source maps turn minified stack traces back into a site's own code ([errors](errors.md#5-source-maps)). Both need an S3-compatible object store; without one, they are off and everything else works. Pick one of three before the first start:

- **Garage on the same server**, as `example.env` has it: `COMPOSE_PROFILES=object-store` starts [Garage](https://garagehq.deuxfleurs.fr/) in the stack, and `OBJECT_STORE_URL=http://garage:3900` points the API at it. Fill `OBJECT_STORE_ACCESS_KEY_ID`, `OBJECT_STORE_SECRET_ACCESS_KEY`, and `GARAGE_RPC_SECRET` as [First start](#first-start) says. Garage creates its bucket (`OBJECT_STORE_BUCKET`, default `ottertrail`) and that key on its first start, from the same settings the API reads. Docker Compose reads `COMPOSE_PROFILES` from `.env`, so every `docker compose` command includes Garage without `--profile`.
- **Cloudflare R2, Amazon S3, or another S3-compatible store.** Remove the `COMPOSE_PROFILES` line. Create a bucket and an access key for it there, set `OBJECT_STORE_URL` to its endpoint (for R2, `https://<account ID>.r2.cloudflarestorage.com`), `OBJECT_STORE_REGION` (`auto` for R2), `OBJECT_STORE_BUCKET`, `OBJECT_STORE_ACCESS_KEY_ID`, and `OBJECT_STORE_SECRET_ACCESS_KEY`. `GARAGE_RPC_SECRET` can stay empty.
- **No object store.** Remove the `COMPOSE_PROFILES` and `OBJECT_STORE_URL` lines. Replays and source maps are then off.

A missing key does not stop Compose: `migrate` or Garage stops at start, and its log says why ([Missing settings](#missing-settings)).

`SOURCE_MAP_STORAGE_BYTES` limits the instance's compressed maps, all projects together, 1 GiB by default, and `REPLAY_STORAGE_BYTES` its compressed replays, 2 GiB by default (a first guess, until measured on real sites). Replays are kept 30 days. The API logs `OBJECT_STORE_URL is not set: source maps are off` at start when there is no store; a project's replay setting then says replays are off on the install.

### Traces, logs, and metrics

A server sends them to the instance's address over OTLP/HTTP, with its project's secret key ([telemetry](telemetry.md#receiving)); Caddy passes `/v1/traces`, `/v1/logs`, and `/v1/metrics` to the API like every other path, and nothing needs to be set. ClickHouse keeps them `TELEMETRY_RETENTION_DAYS`, 30 by default (1 to 365), and drops whole days past it on its own. After changing it, run `docker compose up -d`, as for an [update](#updating): `migrate` applies it to ClickHouse's tables, and the API, which refuses records older than it, restarts with it.

Containers keep at most 50 MB of logs each (`docker compose logs api` shows them). The API and the worker log one JSON object per line.

### Uptime checks

The worker runs each project's uptime checks from the server it is on ([uptime and alerts](uptime-alerts.md)). A check may not reach loopback, private, link-local, unique-local, shared (CGNAT), multicast, unspecified, or reserved addresses, so a dashboard user cannot point one at the stack's own PostgreSQL or ClickHouse, a cloud's metadata service, or the private network behind the server. Checks resolve host names with the name servers the server is set up with (`/etc/resolv.conf`; in Docker, the container's), not with `/etc/hosts`.

- **The server's own public address.** A check to it on another port reaches services a cloud firewall closes only to the outside, such as a port Docker publishes on the host. List it, and any other address or range checks must never reach, in `UPTIME_DENY_ADDRESSES` in `.env`, separated by commas, such as `UPTIME_DENY_ADDRESSES=203.0.113.10,2001:db8:1::/64`. The API and the worker refuse to start on an entry that is not an IP address or CIDR range.
- **A private network to check.** A self-hosted install that must check services on its own private network can set `UPTIME_ALLOW_PRIVATE_ADDRESSES=true`: checks may then reach loopback, private, unique-local, and shared addresses, the stack's own containers included. Every dashboard user can then point a check at any of them, and a check's word reads their answers one yes or no per run, enough to read out, a word at a time, what a service shows without a password. Set it only where every dashboard user may read those services, and list what they must not reach in `UPTIME_DENY_ADDRESSES`. Link-local addresses and the known cloud metadata services (`169.254.169.254`, `100.100.100.200`, `168.63.129.16`, `fd00:ec2::254`, `fd20:ce::254`, `fd00:c1::a9fe:a9fe`) stay refused. The hosted service leaves it off.

Webhooks, where alerts can go ([webhooks](webhooks.md)), follow the same rules with the same two settings: a webhook's URL is checked when it is saved and again on every delivery.

On shutdown the worker lets running checks and deliveries finish, at most 30 seconds each, so Compose gives it 45 seconds (`stop_grace_period`) before stopping it.

### Alert email

Optional, and only for alerts: invitations and password reset links are links the dashboard shows, and never need email. Alerts go to email channels through an SMTP server the instance is set up with: an email provider's or a relay of your own. Without one, email channels can still be made, the Settings page says email is not set up on this instance, and each email delivery fails with that reason. Webhooks need no setting.

- `SMTP_URL` in `.env`: `smtps://user:password@smtp.example.com:465` for TLS from the start, or `smtp://user:password@smtp.example.com:587` for STARTTLS, which is then required, so the password never crosses the network in plain text. Percent-encode a user name or password that holds `@`, `:`, `/`, `?`, `#`, or `%`. A relay that needs no password takes `smtp://relay.internal:25`. The URL takes no query string: the TLS, timeout, and logging settings are Ottertrail's, and none can be changed from it. The API and the worker refuse to start on a URL that is not `smtp://` or `smtps://`, has a path, a query string, or a fragment, or has a user name without a password; their messages never repeat it, and neither logs it.
- `EMAIL_FROM`: the sender, an address or a name and an address, such as `Ottertrail <alerts@example.com>`. Required with `SMTP_URL`. The provider must allow sending from that address (its domain verified, with SPF and DKIM), or messages land in spam or are refused.

Messages are plain text: what happened, when (in the instance's timezone), the project, and a link to the dashboard; the subject starts with the instance's name. A failed message is retried for about an hour ([uptime and alerts](uptime-alerts.md#step-2-channels-and-delivery-as-built)); its error shows in the channel's deliveries on the Settings page. After changing either setting, run `docker compose up -d`.

### One customer per instance

Every install serves one customer, whether self-hosted or hosted: each hosted customer gets an instance of their own (decided 18 November 2026), so no customer can slow another. An instance holds projects, its owner (the account the setup link creates), and its instance settings: a display name and the timezone reports count days in, which the owner changes on the dashboard's Settings page ([dashboard](dashboard.md#instance-settings)). The limits on events, source maps, and replays apply to the whole instance, all projects together, with a budget per project inside them. Nobody can sign up in an install; teammates join by invitation ([access](access.md)). Nothing needs to be set for that.

## Decisions

**One image, one process for all of the instance's paths.** The API serves the dashboard's built files (`apps/api/src/dashboard-app/`), the tracker, and the API from one origin, so the dashboard needs no CORS. Caddy only does HTTPS. The image can also run without Caddy, on a platform that runs Docker images and provides HTTPS. It then needs `DATABASE_URL`, `PUBLIC_URL`, and `AUTH_SECRET`; `TRUST_PROXY` set to the number of proxies the platform puts in front of it, or every visitor seems to come from the platform's proxy (one rate limit, one visitor ID, and one location for all); `node dist/migrate.mjs` before each release; and the worker (`node dist/worker.mjs`) as a second process. None of this has been tried on a platform. Files under `/assets/` have content-hashed names and are cached for a year; `index.html` is revalidated on every load, so a new release shows at once. Any other path without a file extension, outside `/api/`, answers with `index.html` for the dashboard's router; a missing file stays a 404.

**Dependencies bundled into the API.** `vp pack` puts the API's dependencies into `dist/`, so the image holds Node.js, about 10 MB of JavaScript, and the dashboard's files, and no `node_modules`. Installing them with `pnpm deploy --prod` took 182 MB instead: pnpm resolves better-auth's optional peer dependencies from the workspace, so React, Vitest, Playwright, and TypeScript came along. Bundling drops each package's `LICENSE` file, so each build writes `THIRD_PARTY_LICENSES.txt` listing every bundled package with its licence (`scripts/third-party-licenses.ts`). The dashboard's copy is served at `/THIRD_PARTY_LICENSES.txt`.

**Security headers on the dashboard.** Its files carry a Content Security Policy that allows only the instance's own scripts, styles, fonts, and requests, plus `data:` images and fonts (Vite inlines files under 4 KB). `frame-ancestors 'none'` and `X-Frame-Options: DENY` stop other sites from framing it; `Referrer-Policy: same-origin` keeps project IDs and filters in dashboard URLs from reaching other sites. With an HTTPS public URL, `Strict-Transport-Security` tells browsers to use HTTPS for a year; not for `localhost`, where a stored entry would break plain-HTTP development servers. The tracker and the API's JSON answers do not carry the dashboard's policy: sites on other origins load the tracker.

**Client addresses.** Caddy replaces any `X-Forwarded-For` a client sends with the address it sees, and the API trusts exactly one proxy hop (`TRUST_PROXY=1`). Rate limits and the visitor ID therefore see the real address, and a client cannot fake one. Tested: an event sent through Caddy with `X-Forwarded-For: 8.8.8.8` got no location, while the same header sent to the API from inside the stack was placed in the US. Putting a CDN or another proxy in front of Caddy breaks this: every request would seem to come from the CDN. That needs Caddy's `trusted_proxies` and one more hop, and is not set up.

**Migrations as their own step.** The `migrate` service runs before the API and the worker start, and they wait for it to succeed. The API never migrates on startup, so two API processes could never race to change the schema.

**One Compose file per release, with its settings inside.** An install downloads `compose.yaml` and `example.env` from a release, not the repository. The Caddyfile and the settings of ClickHouse and Garage are in the Compose file (`configs:` with `content:`), so they always match the release, and a server needs no other file. The development stack (`compose.yaml` at the repository root) reads the same ClickHouse and Garage settings from `deploy/clickhouse/` and `deploy/garage/`; a test (`apps/api/tests/deploy-files.test.ts`) fails when they differ from the Compose file's. `deploy/clickhouse/development.xml` is for the development stack only. Docker Compose does not recreate a container when only the content of one of its configs changes, so each service carries a label with its configs' hashes (`ottertrail.config.<name>`), and Caddy reads the domain from its environment: a release that changes a config, or a new `OTTERTRAIL_DOMAIN`, changes the service, and `up -d` recreates it. The same test fails when a label does not match its config.

**Its own Compose project name.** The stack is named `ottertrail-instance`, not `ottertrail`: the development stack (`compose.yaml` at the root) uses that name, and the two would share a database volume on a developer's machine.

## Images and releases

**From the registry.** Each release is built once in CI (`.github/workflows/release.yml`), for `linux/amd64` and `linux/arm64`, and pushed to the GitHub Container Registry as `ghcr.io/ottertrail/ottertrail`. Every server that pulls a release runs the identical image, and building needs no memory or toolchain on the server. Images are tagged with the version (`0.1.0`) and the commit (`sha-1a2b3c4`), never `latest`. While the repository is private, so is the image ([First start](#first-start) shows the login).

**Releasing.** The version is written in three places: the root `package.json`, `apps/api/package.json` (the API reports it, and webhooks name it), and the image `deploy/compose.yaml` runs by default. One command sets all three:

```sh
vp run version 0.2.0
git commit -am "chore(release): 0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

It refuses a version that is not [semantic](https://semver.org) (`x.y.z`, without a `v`). Run `vp run ready` before tagging. For the tag, the workflow first checks that all three hold the tag's version (`node scripts/version.ts --check`), then builds and pushes the image. Once the image is pushed, it creates the GitHub Release "Ottertrail 0.2.0" with `compose.yaml`, `example.env`, `backup.sh`, and `restore.sh`, and notes written from the commits since the previous tag (`scripts/release-notes.ts`): breaking changes (a `!` or a `BREAKING CHANGE:` footer) first, then features, fixes, and the rest, then how to install or update. `node scripts/release-notes.ts 0.2.0 HEAD` shows them before tagging. A version with a hyphen, such as `0.2.0-rc.1`, becomes a pre-release, and its notes count from the tag before it; a final release's notes count from the previous final release, so they include what its release candidates listed. Build metadata (`1.0.0+b1`) is refused: a Docker tag cannot hold a `+`.

A version's image is pushed once and never replaced: servers pull it by its version. When the workflow finds the image already in the registry, as when it runs again after the release step failed, it says so in its log and skips the build and the push; the release step then runs again, and replaces the files and notes of the release if it exists. To change a released image, release a new version. The workflow can also be run by hand from the Actions tab, which pushes an image tagged with the commit only, and releases nothing.

**Built from source.** For contributors and local deployment tests, or to run code that is not released: build the image from the checkout under the release image's name, with a tag of your own, and set that tag in `.env`. Compose only pulls an image it does not have, so it runs the local one:

```sh
docker build -t ghcr.io/ottertrail/ottertrail:dev .   # at the repository root
# deploy/.env: OTTERTRAIL_VERSION=dev
docker compose up -d                                  # in deploy/
```

Do not run `docker compose pull` with such a tag: there is no published image to pull. With a `docker-container` buildx builder (one made with `docker buildx create`), the built image stays in the builder's cache: add `--load` to `docker build` so Compose can use it. The build installs every development dependency inside the image and takes a few minutes; a small server may need swap, or a build elsewhere. An image built on an Apple Silicon Mac is for ARM servers; add `--platform linux/amd64` for most VPS providers (slow, through emulation).

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
- `up -d --build` failed on Podman's 2 GB machine: podman-compose built the shared image once for each of the three services that use it, at the same time, and two of the builds ran out of memory. The third finished. (Since then, installs pull a built image, and a build from source is one `docker build`: [Images and releases](#images-and-releases).) The later `build migrate` reused that build's cached layers, so a build from scratch alone was not timed.
- The `object-store` profile (18 November 2026, Podman): without it, the stack has no Garage; with it, Garage started from this file healthy, and created its bucket and access key from the settings. Uploading, reading, and deleting source maps were tested against the development stack's Garage (the same image and `deploy/garage/garage.toml`), not yet inside this stack.

The whole stack (18 November 2026), with the `object-store` profile, on Podman 6.2 and podman-compose 1.6 in a 4 GB machine shared with another project, through Caddy and HTTPS. Rootless Podman cannot open ports 80 and 443, so an override file kept outside `deploy/` published Caddy on 8443 (and 80 on 8081) and set `PUBLIC_URL` to `https://localhost:8443`, with `OTTERTRAIL_DOMAIN=localhost`; the settings were exported in the shell instead of `.env`. Headless Chromium went through Caddy, with Caddy's local certificate accepted:

- `build migrate` built the image once, in under a minute with the dependency layers cached, and `up -d` started the stack in order: PostgreSQL, ClickHouse, and Garage healthy, `migrate` exited 0 after applying both schemas, then the API (healthy after about 30 seconds), the worker, and Caddy. podman-compose started `migrate` again for each service that waits for it, so it ran four times; the later runs found nothing to do. Idle, after the test data below: ClickHouse 158 MB, API 146 MB, worker 54 MB, PostgreSQL 39 MB, Caddy 23 MB, Garage 6 MB, about 425 MB together.
- Setup: `setup.mjs` printed a link. The setup page showed Confirm password, the browser's timezone already chosen (Asia/Singapore), and "Email for alerts is not set up". Creating the owner signed them in. The session cookie is `__Secure-ottertrail.session_token`, `Secure`, `HttpOnly`, `SameSite=Lax`; a sign-in with another origin's `Origin` header answers 403.
- Web analytics: a test site on `http://localhost:8099` loaded `/t.js` (and `v.js`, `r.js`) and sent pageviews, time on page, and Web Vitals, each answered 202; the analytics page showed 10 pageviews on the right pages. Headless Chromium's own user agent names it `HeadlessChrome`, and collection ignores it as a bot, as designed: the test set a desktop Chrome user agent.
- Errors and replay: with "Around errors" chosen in the project's settings and `data-replay="errors"` in the snippet, a click threw an error. The error appeared, the recorder sent two chunks after it, the worker joined them within 10 seconds and linked the replay to the error. A page closed 8 seconds after its error sent only its first chunk; the worker joined that one, marked cut, after 5 minutes. The Replays page listed both with their error; the replay page played in the player page's frame, whose recording frame is sandboxed with `allow-same-origin` only, with the text masked and the timeline beside it (on the page, typed in a field, clicked a button, the error).
- Source maps: `PUT /api/source-maps` through Caddy with the secret key answered 201 (401 with the public key); the error page mapped the minified frame `app.min.js:1:38` back to `src/cart.ts:3:11`, with the lines around it. Stored in the stack's Garage.
- OTLP over HTTP/JSON through Caddy with the secret key (401 with the public key): a trace of two spans, one a PostgreSQL call, a log record, and a gauge. The Traces, trace, Logs, Metrics, Services, and Databases pages showed them.
- Uptime and alerts: the container reaches the internet, and a check on `https://example.com` stayed up. With `UPTIME_ALLOW_PRIVATE_ADDRESSES=true`, a webhook channel to a receiver on the host (`192.168.127.254`, Podman's address for it), and a check-down rule on a check of a page that answers 503: the check went down on its first run, and the receiver got `check.down` within a minute, then `check.up` when the check was paused; both signatures checked out with the channel's secret.
- Members: an invitation with web analytics only, on one of two projects, made on the Members page. In a second browser context, Accept, then name and password, signed the member in on that project's analytics. The member's sidebar held Web analytics and Speed only; the other project's page said "No such project" (its API answered 404), the project's Errors page and the Members page said "You don't have access" (403). A reset link from the Members page set a new password and signed out the member's other session; `reset-password.mjs owner@example.com` printed a link that did the same for the owner, after which the old password failed, the new one worked, and the link did not work twice. For an email with no account it prints so and exits 1.
- Headers: the dashboard carries its Content Security Policy, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, and `nosniff`, over HTTP/2, with assets cached for a year and compressed (zstd). The replay player page carries its own policy (`default-src 'none'`, styles, images, and fonts only from the project's allowed hostnames, `frame-ancestors 'self'`), `Referrer-Policy: no-referrer`, and `Cache-Control: no-store`, and answers 401 without a session. No `Strict-Transport-Security`, as expected for `localhost`. No page broke a Content Security Policy.
- `down`, then `up`, without `-v`: every count stayed the same (events, spans, logs, metric points, check results, users, replays, source maps, channels, rules, checks), Garage kept its 3 objects, and the replay still played; a delivery queued just before stopping was sent after the start.
- `backup.sh`, then `down -v`, then `restore.sh`, both with `COMPOSE="podman compose …"`: both files readable by their owner only, the restore exited 0, and the counts above, both sign-ins, the member's access, and the source-mapped stack's release came back. Garage's bucket did not: the backups left out the object store (since added; see the next test). After the restore, both replays were still listed with their errors and timelines, but the player said "This replay is not available: it may have expired", and the error page's stack was no longer mapped while the project's settings still listed the map. Uploading the map again mapped it again; the replays cannot be recovered.

Backups with the object store (18 November 2026), the same setup: Podman 6.2, podman-compose 1.6, the `object-store` profile, the override file, and the settings exported in the shell. A new owner, a project with "Around errors", an error with its replay from the test site, and a source map uploaded with the secret key: Garage held 2 objects, 930 bytes. This is the second run; the first, the same day, found the restore checked the object backup only after the databases, which the steps above now do first.

- `backup.sh` exited 0 and wrote the `.zip`, the `.dump`, and `-objects.tar`, all readable by their owner only. The tar held `manifest.json` and two files, with each object's key, size, content type (`application/gzip`), and SHA-256. No temporary file or folder was left. The bind mount's `:z` worked through podman-compose.
- Without `OBJECT_STORE_URL`, and with it set to `" off"`, `backup.sh` exited 0 and wrote all three files; the tar's manifest had `"bucket": null` and no objects.
- With Garage stopped, `backup.sh` exited 1 with "The backup failed while backing up the object store (source maps and session replays). No backup file was kept.", and left no file, here or in ClickHouse's volume.
- After `down -v`, `restore.sh` refused each of these before any database container existed, with exit 1 and "the databases were not touched": the `-objects.tar` missing; the tar cut short (`tar` reported it truncated); the tar's 2 objects with no `OBJECT_STORE_URL`; and `COMPOSE` without the `object-store` profile, so no Garage: after 62 seconds, "the bucket ottertrail at http://garage:3900 did not answer".
- Then `restore.sh` with all three files: "The object backup checks out: 2 objects (930 bytes), and the bucket answers", then the databases, then "Restored 2 objects (930 bytes)", exit 0, and no unpacked folder left. Before and after, the same: 4 events, 1 user, 2 projects, 1 replay, 1 source map, Garage's 2 objects and 930 bytes; the replay's recording answered 200 with 2,646 bytes, the player played it, and the stack mapped to `src/cart.ts` line 3.
- After `down -v` again, `restore.sh --without-objects` with the tar missing warned, restored the databases, and exited 0. The player then said "This replay is not available: it may have expired", and the stack was not mapped.

Not tested yet: Docker Engine and Docker Compose on a Linux server, a real domain with a Let's Encrypt certificate, ports 80 and 443, an `amd64` image, alert email through an SMTP server, an update that runs a migration on existing data, a restore on a new server, an object backup of Cloudflare R2 or Amazon S3, and the backup scripts under rootless Docker, rootless Podman on Linux, or SELinux.

Releases as an install gets them (18 and 19 November 2026), on macOS with Podman 6.2 in a 4 GB machine shared with another project, and Docker Compose 5.8.0 and then 2.23.1 (the standalone binaries) on Podman's socket. The image was built from a clean export of the commit (`git archive`), tagged `ghcr.io/ottertrail/ottertrail:0.0.0-releasetest`, and chosen with `OTTERTRAIL_VERSION`, so nothing was pulled. The install folder held only `compose.yaml`, `example.env`, `backup.sh`, `restore.sh`, and a `.env` made from `example.env`; an override file kept elsewhere published Caddy on 8443 and 8081 and set `PUBLIC_URL`, as above.

- `up -d` started all seven services: `COMPOSE_PROFILES=object-store` in `.env` was enough to start Garage. Inside the containers, the Caddyfile held the domain, ClickHouse ran with the inline settings (a mark cache of 512 MiB, 40% of the memory, 1 GB per query), and Garage created its bucket. The health check answered 200 over HTTP/2 through Caddy, and HTTP redirected to HTTPS.
- The setup link created the owner, a project was made, a test site on another origin loaded `/t.js` and sent one pageview (202), and the analytics page showed it: 1 visitor, 1 pageview, `/index.html`.
- `backup.sh`, called from another folder, wrote its three files into `backups/` beside it, readable by their owner only. `down -v` removed every volume. `restore.sh`, called from a third folder with a relative path, restored them, exit 0, and the analytics page showed the same pageview, with the owner's sign-in.
- Docker Compose 2.23.1, the oldest version the file asks for, from a fresh folder the same way (19 November 2026). Its override reset Caddy's ports with `!reset []` and added the high ports in a second file, because `!override` needs 2.24.4. `up -d` started all seven services; the Caddyfile, ClickHouse's settings (512 MiB mark cache, 0.4 of the memory, 1 GB per query), and Garage's (its bucket made) were in place; setup, a project, and one pageview went through, and the analytics page showed it.
- Recreating on 2.23.1, 5.0.2, and 5.8.0, with a Caddy container on its own: `up -d` kept the container when only the content of its inline config changed, so the new content never reached it. A changed environment variable or label recreated it, with the new content. Hence the domain in Caddy's environment, and each config's hash in a label ([Decisions](#decisions)). In the 2.23.1 stack, a changed Caddyfile without its label left every container as it was; with its new label, `up -d` recreated Caddy alone, which then held the new Caddyfile and answered through HTTPS.
- The three object store cases, from a fresh folder each, on 2.23.1 and on 5.8.0: Garage on (seven services, Garage healthy), an own S3 store (`COMPOSE_PROFILES` removed, no Garage secret; six services), and no store (six services; the API logs that source maps are off). Each started, with the API healthy through Caddy. With missing settings, on 2.23.1: the store's keys empty, with Garage or with an own store, stopped `migrate` with the `ConfigError` above, and `up -d` exited 1; `GARAGE_RPC_SECRET` empty left Garage restarting with "Invalid RPC secret key" (on 5.8.0 too), and everything else started ([Missing settings](#missing-settings)).
- Before the object store's keys were left to the services (18 November 2026), the Compose file checked them itself, inside a condition. Docker Compose 2.23.1 to 2.40.3, 5.0.0, and 5.0.1 evaluated that check in every install, so installs with an own store or none stopped asking for Garage's secret; 5.0.2 and later did not. Hence [Missing settings](#missing-settings).
- podman-compose 1.6, the same folder: it read `COMPOSE_PROFILES` from `.env` and started Garage, but skipped every inline config without a warning. Caddy ran with its image's default Caddyfile, ClickHouse with its defaults, and Garage stopped at once: "Failed to read config file /etc/garage.toml". Hence Docker Compose in [What you need](#what-you-need).

## Known limitations

- No automated or off-site backups.
- Garage runs as one node, without copies of its data on other servers: only `backup.sh` keeps another copy.
- The object backup copies every object each time, without increments. That suits the default limits (1 GiB of source maps, 2 GiB of replays); a much larger bucket takes long and needs the disk space twice.
- The geolocation database and the data-center ranges are updated by hand, monthly.
- One server: no failover, and a few seconds of downtime for each update.
- Release images are built in CI and pushed to ghcr.io, but nothing tests them there before they are pushed, and the release workflow has not run for a tag yet: run `vp run ready` before tagging a release.
- podman-compose cannot run the Compose file (inline configs); Docker Compose 2.23.1 or later is needed, with Docker or Podman.
- A missing object store key or Garage secret does not stop `docker compose up -d` before it starts anything, as the required settings do: `migrate` or Garage stops instead, and says so in its log ([Missing settings](#missing-settings)).
- The workflow's check for an image already in the registry (`docker buildx imagetools inspect`, which says "not found" for a new version) has not run in CI yet.
- `docker compose pull` from the private registry, and the release downloads with `gh` or a token, are not tested yet.
- One deployment per server. Two stacks on one host would both need ports 80 and 443; sharing a host needs one proxy in front of both, not set up.
- No CDN or proxy in front of Caddy (see "Client addresses").
- The API prints one line that is not JSON at startup: a warning from its JSON schema validator about union types.

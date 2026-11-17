# Deployment

How to run Ottertrail on one server, and the decisions behind it. The hosted service is one such deployment serving every organization; a self-hosted install is the same stack, usually with one organization. ClickHouse joins the stack when events move there ([roadmap](roadmap.md#next-in-stage-0)).

Status: tested on one machine with Podman (see [What has been tested](#what-has-been-tested)). Nothing runs in production yet, and backups are manual.

## What runs

`deploy/compose.yaml` starts five services from two files: the [Dockerfile](../Dockerfile) at the repository root, which builds one image for all of Ottertrail, and [deploy/Caddyfile](../deploy/Caddyfile).

| Service    | What it does                                                                                                             | Reachable from outside |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `postgres` | PostgreSQL 18, data in the `postgres-data` volume                                                                        | No                     |
| `migrate`  | Brings the schema up to date, then exits. The API and the worker start only after it succeeds                            | No                     |
| `api`      | The API, the dashboard's files, and the tracker (`/t.js`), on port 3000 inside the stack. Geolocation file in `geo-data` | No, only through Caddy |
| `worker`   | Background work: deletes events past each project's retention                                                            | No                     |
| `caddy`    | HTTPS: gets and renews the certificate, redirects HTTP to HTTPS, compresses responses, passes every request to the API   | Ports 80 and 443       |

Idle, the stack used about 160 MB of memory (API 100 MB, PostgreSQL 27 MB, worker 18 MB, Caddy 14 MB), measured with the test data below. The image is about 290 MB, almost all of it Node.js's own image. No sizing under real traffic has been measured.

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

Edit `.env`: set `OTTERTRAIL_DOMAIN`, then fill `POSTGRES_PASSWORD` and `AUTH_SECRET` with the output of `openssl rand -hex 32` (a different value each). Hex keeps the password safe inside the database URL. Set `TIMEZONE` now: reports count days in it, and changing it later moves the day boundaries of past data.

```sh
docker compose up -d --build
docker compose ps
```

`migrate` should show "Exited (0)" and `api` "healthy". The first build installs every development dependency inside the image and takes a few minutes; its memory needs have not been measured, so a small server may need swap or a build elsewhere (see [Images](#images)).

Create the owner account, then download the geolocation database:

```sh
docker compose exec api node dist/setup.mjs
docker compose exec api node dist/update-geo.mjs
docker compose up -d --force-recreate --no-deps api
```

`setup.mjs` prints a link, valid for an hour, that creates the owner. `update-geo.mjs` saves DB-IP's database (about 130 MB) in the `geo-data` volume; the API reads it at startup, hence the restart. Without it, events are stored without a location. DB-IP publishes a new file each month: run the last two commands again monthly.

The last command restarts only the API by recreating its container. `docker compose restart api` is the usual way, but Podman refuses it because `migrate` has exited.

## Updating

```sh
git fetch && git checkout <release>
docker compose up -d --build
```

Compose rebuilds the image, runs `migrate`, and replaces the API and the worker. The API is unavailable for a few seconds while its container is replaced; the tracker retries events it could not send.

With `OTTERTRAIL_IMAGE` set, update with `docker compose pull` and then `docker compose up -d` instead, never with `--build`: that would build this checkout and tag it with the registry image's name.

To go back to an earlier release, check it out and run the same command, as long as no migration ran in between. The deployment only runs migrations forward, and an older release may not work with a newer schema: after a migration, restore the backup taken before the update.

## Backups

Not automated yet. Before each update, and regularly:

```sh
docker compose exec -T postgres pg_dump -U ottertrail -Fc ottertrail > ottertrail-$(date +%F).dump
```

Copy the file off the server: a backup on the same disk is lost with it.

To restore into an empty database (a new server, or after `docker compose down -v`), start only PostgreSQL and wait until it is ready, then restore:

```sh
docker compose up -d --wait postgres
docker compose exec -T postgres pg_restore -h 127.0.0.1 -U ottertrail -d ottertrail \
  --no-owner --single-transaction --exit-on-error < ottertrail-2026-11-17.dump
```

Start the rest with `docker compose up -d` only if `pg_restore` finished without an error. The restore runs as one transaction, so a failure leaves the database empty rather than half restored. Starting the stack on an empty database would let `migrate` create a fresh schema there, which a second restore attempt would then collide with; in that case run `docker compose down -v` and start again.

Tested with Podman: after deleting the whole stack with `down -v`, these steps gave back every event and the owner's sign-in. Not yet tested on a new server.

## Settings

`.env` holds only what differs between instances. Compose sets the rest (see the [API's configuration](../README.md#configuration)).

| Variable            | Meaning                                                                                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTTERTRAIL_DOMAIN` | The instance's domain, without `https://`. The public URL is `https://` and this domain                                                                                                                                                   |
| `POSTGRES_PASSWORD` | The database password. Only the containers use it; PostgreSQL has no port open. PostgreSQL keeps the password it was first created with: to change it, run `ALTER USER ottertrail PASSWORD '…'` in the database first, then change `.env` |
| `AUTH_SECRET`       | Signs sign-in cookies. Changing it signs everyone out                                                                                                                                                                                     |
| `TIMEZONE`          | The instance's IANA timezone, such as `Europe/Berlin`. Default `UTC`                                                                                                                                                                      |
| `LOG_LEVEL`         | Optional, default `info`                                                                                                                                                                                                                  |
| `OTTERTRAIL_IMAGE`  | Optional: an image to run instead of building this checkout, such as one from a registry                                                                                                                                                  |

Compose stops with "set … in .env" when a required one is missing.

Containers keep at most 50 MB of logs each (`docker compose logs api` shows them). The API and the worker log one JSON object per line.

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
- A backup with `pg_dump`, then `down -v` (deleting every volume), then the restore steps above, gives back every event and the owner's sign-in.
- A spoofed `X-Forwarded-For` sent through Caddy is ignored (see "Client addresses").

Not tested yet: Docker Engine and Docker Compose on a Linux server, a real domain with a Let's Encrypt certificate, an `amd64` image, an update that runs a migration on existing data, and a restore on a new server.

## Known limitations

- No automated or off-site backups.
- The geolocation database is updated by hand, monthly.
- One server: no failover, and a few seconds of downtime for each update.
- No image registry or CI builds: each server builds its own image.
- One deployment per server. Two stacks on one host would both need ports 80 and 443; sharing a host needs one proxy in front of both, not set up.
- No CDN or proxy in front of Caddy (see "Client addresses").
- The API prints one line that is not JSON at startup: a warning from its JSON schema validator about union types.

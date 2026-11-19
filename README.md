# Ottertrail

Web analytics, product analytics, error tracking, and monitoring for developers and small teams, in one app. Each customer runs an instance of their own, hosted or self-hosted. See [CLAUDE.md](CLAUDE.md) for the architecture rules and [docs/roadmap.md](docs/roadmap.md) for the build order.

## Current state

This repository is a foundation, not a working product yet. It contains:

- `apps/web`: React dashboard (Vite, Tailwind CSS v4, shadcn/ui on Base UI) with sign-in, a project list, and inside each project an overview that sums up its health and business figures, its web analytics, its known users with their activity, and settings (install snippet and allowed sites), plus the Ottertrail design system and its reference page. Product analytics and errors are listed in each project's sidebar as **Planned**; neither exists yet.
- `apps/api`: Fastify API with `GET /api/health` (a liveness check) and `POST /api/events`, which collects events into ClickHouse, where reports read them ([docs/clickhouse.md](docs/clickhouse.md)). Dashboard sign-in works (the owner account comes from `vp run setup`). An instance holds projects; dashboard users read their reports (`GET /api/projects/:id/analytics`; `vp run report` prints the same reports in a terminal). Users are the owner, admins, and members with access per area and project, and one check runs on every route ([docs/access.md](docs/access.md)). The owner sets the instance's name and timezone on the Settings page ([instance settings](docs/dashboard.md#instance-settings)), where the owner and admins also manage the notification channels alerts go to: email over SMTP and signed webhooks ([docs/webhooks.md](docs/webhooks.md)). Each project's Alerts page holds its alert rules: a check down, a certificate about to expire, new, regressed, or spiking errors, a route's latency or failed share, and a metric above or below a value ([docs/uptime-alerts.md](docs/uptime-alerts.md)). Teammates join by invitation links from the Members page, with reset links for lost passwords. There is no open sign-up or job queue yet.
- `packages/tracker`: the browser script (`dist/tracker.js`, about 3.9 KB gzipped, and `dist/v.js` for Web Vitals) that sends pageviews, custom events, and errors, with a playground page in `demo/`. The API serves the built script at `/t.js`, so sites load it from their instance.

To run an instance on a server, see [docs/deployment.md](docs/deployment.md): each release publishes one Docker image (`Dockerfile`) and a Compose file with PostgreSQL, ClickHouse, and Caddy (`deploy/compose.yaml`), which a server downloads with `example.env` and starts with `docker compose up -d`.

The design system is documented in [docs/design-system.md](docs/design-system.md). How web analytics works, and the decisions behind it, are in [docs/web-analytics.md](docs/web-analytics.md); error tracking in [docs/errors.md](docs/errors.md); product analytics in [docs/product-analytics.md](docs/product-analytics.md); the planned session replay's design in [docs/session-replay.md](docs/session-replay.md); the dashboard, including sign-in, in [docs/dashboard.md](docs/dashboard.md); roles and access in [docs/access.md](docs/access.md).

## Toolchain

| Tool                                        | Version | Notes                                                                                                                                               |
| ------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                                     | 26 LTS  | `.node-version`; `engines` requires >= 26                                                                                                           |
| pnpm                                        | 12.21.0 | Pinned in `devEngines`; downloaded automatically if missing                                                                                         |
| [Vite+](https://viteplus.dev/guide/) (`vp`) | 1.6.0   | Dev server, build (Vite/Rolldown), tests (Vitest), lint (Oxlint), format (Oxfmt), type checks (TypeScript 7 via tsgolint), library packing (tsdown) |
| TypeScript                                  | 7.0     |                                                                                                                                                     |
| React                                       | 19.3    |                                                                                                                                                     |
| Fastify                                     | 5.12    |                                                                                                                                                     |
| Tailwind CSS                                | 4.3     |                                                                                                                                                     |
| PostgreSQL                                  | 18.7    | Local development database in `compose.yaml`                                                                                                        |
| Kysely                                      | 0.29    | Typed SQL query builder and migrations                                                                                                              |

Lint and format configuration lives only in the root `vite.config.ts` (`lint` and `fmt` blocks), with per-package `overrides`. Do not add `.oxlintrc.json`, `.oxfmtrc.json`, ESLint, or Prettier configs. Oxfmt also sorts imports and Tailwind classes (including inside `cn()` and `cva()`).

## Setup

Install the Vite+ CLI once ([instructions](https://viteplus.dev/guide/)), then:

```sh
vp install
```

`vp install` also installs the git hooks (through the `prepare` script, which runs `vp config --no-agent`). Install [gitleaks](https://github.com/gitleaks/gitleaks) too (`brew install gitleaks`), so commits are scanned for secrets. See [Commits](#commits).

The dashboard's browser tests run in headless Chromium. Download it once per machine (about 100 MB):

```sh
vp -C apps/web exec playwright install --only-shell chromium
```

Start the local databases (PostgreSQL and ClickHouse) and create their tables:

```sh
podman compose up -d   # or: docker compose up -d
vp run migrate
```

Then start everything with `vp run dev`, and create the dashboard's owner account: `vp run setup` prints a one-time link (see [Signing in](docs/dashboard.md#81-signing-in)).

On its first start the worker downloads the location database (about 130 MB) and the data-center ranges into `apps/api/data/geo/`, as an instance's does, and the API loads them within 10 minutes. To skip the downloads, turn off "Update location data automatically" on the Settings page; until then, or without them, events are stored without a location ([web analytics](docs/web-analytics.md#keeping-the-files-current)).

PostgreSQL listens on `127.0.0.1:5433` (not the usual 5432, to avoid clashing with other local PostgreSQL servers) and has no password. ClickHouse listens on `127.0.0.1:8123`, as user `ottertrail` with password `development`, and uses the same small-server settings as deployments (`deploy/clickhouse/`). Garage, an S3-compatible object store for source maps, listens on `127.0.0.1:3900`, with the access key and bucket the API's development defaults use (`compose.yaml`). All three are for local development only. Their data lives in the `ottertrail_postgres-data`, `ottertrail_clickhouse-data`, and `ottertrail_garage-data` volumes; `podman compose down -v` deletes them.

## Demo data

For development only: `vp run seed` fills the local instance with a project named **Demo shop**, so every page of the dashboard has something to show. A first run takes a few seconds; a rerun about 40, most of them ClickHouse deleting the previous project's rows.

- **Web and product analytics:** 30 days of visits (about 46,000 events) with a weekday rhythm, sources from search, social sites, referrals, and tagged campaigns, places, devices, entry and exit pages, production and staging, and two releases. A signup flow (pricing, `signup_started`, `signed_up`, `project_created`), four goals (the main goal is "Signed up"), two saved funnels, and signed-in users going back nine weeks, for retention. Web Vitals are worse on phones.
- **Errors and replays:** a new error in the latest release with an uploaded source map and six session replays (the recording in `apps/api/tests/fixtures/replay-recording.json`), one that came back after it was resolved, one resolved for good, and the servers' exceptions, sent over OpenTelemetry and joined to their traces.
- **Monitoring:** 14 days of traces and logs from three services (`web`, `billing`, `worker`, about 39,000 spans and log records) with database calls and one slow route, 7 days of app metrics, and host metrics from two hosts.
- **Uptime and alerts:** three checks with 30 days of results, a past incident, one check down now, and a certificate about to expire; eight alert rules with their history, two firing now. The checks point at `example.com`, `example.net`, and a `.example` host that never resolves; while the worker runs, it keeps checking them.

It refuses to run with `NODE_ENV=production`, and asks for `vp run seed -- --yes` when `PUBLIC_URL`, `DATABASE_URL`, `CLICKHOUSE_URL`, or `OBJECT_STORE_URL` differ from the development defaults. It touches only the Demo shop project, apart from adding one notification channel, "Demo shop alerts (sends nothing)", which sends email to `alerts@demo-shop.example`, an address that cannot receive mail. Without an object store, source maps and replays are left out.

Run it again to make the project afresh: it deletes the old Demo shop first, as deleting a project in its settings does, then makes it again with the same data, moved to the current day. To remove it, delete the project in its settings, and the channel in the instance's settings if you like. The anonymous traffic covers 30 days, and only signed-in activity goes back further, so a 30-day period compared with the one before looks like steep growth.

## Commands

Run from the repository root.

| Command                       | What it does                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vp run dev`                  | Starts the API (port 3000), the worker, both restarting on change, and the dashboard dev server (port 5173, or the next free port). The dashboard proxies `/api` to the API.                                                                                                                                                                                |
| `vp run migrate`              | Applies database migrations that have not run yet. Safe to repeat.                                                                                                                                                                                                                                                                                          |
| `vp run geo:update`           | Downloads the latest DB-IP City Lite geolocation database and the data-center ranges to `apps/api/data/geo/` now, checks them, and replaces the old files; the API loads them within 10 minutes. The worker does the same on its own while "Update location data automatically" is on.                                                                      |
| `vp run referrer-spam:update` | For maintainers, before a release: refreshes the shipped referrer spam list from Matomo's ([Maintenance](#the-referrer-spam-list)).                                                                                                                                                                                                                         |
| `vp run visits`               | Prints a project's recent visits, worked out from its events: `vp run visits -- <project name> <hours>` (default: the first project, 24 hours).                                                                                                                                                                                                             |
| `vp run setup`                | Prints a one-time link (valid for an hour) that creates the install's owner account and names the instance. Refuses once an owner exists.                                                                                                                                                                                                                   |
| `vp run seed`                 | Replaces the Demo shop project with demo data for every dashboard page: development only (see [Demo data](#demo-data)). `vp run seed -- --yes` when the settings are not the development defaults.                                                                                                                                                          |
| `vp run reset-password`       | Prints a one-time link (valid for an hour) that sets a dashboard account's password, the owner's included: `vp run reset-password -- <email>`. Using it signs the account out everywhere ([access](docs/access.md#password-reset-links)).                                                                                                                   |
| `vp run report`               | Prints a project's reports (summary, visitors per day, top pages, breakdowns, custom events) for the last days in the instance's timezone: `vp run report -- <project name> <days>` (default: the first project, 7 days).                                                                                                                                   |
| `vp run bench:reports`        | Times the report queries on fake data in a temporary PostgreSQL schema and ClickHouse database, then drops both: `vp run bench:reports -- <visits> <days>` (default: 200,000 visits, 30 days). In Podman's default 2 GB machine, the whole-page part can run out of ClickHouse memory ([docs/clickhouse.md](docs/clickhouse.md#memory)).                    |
| `vp check`                    | Formats, lints, and type-checks the whole workspace. `vp check --fix` applies fixes.                                                                                                                                                                                                                                                                        |
| `vp run -r test`              | Runs the tests in every package. The API tests need the local databases running; each test file uses its own temporary PostgreSQL schema and ClickHouse database, named with the time it was made (`test_<seconds>_<random>`); a run first drops those a cut-off run left more than two hours ago. The dashboard's browser tests need Chromium (see Setup). |
| `vp run -r build`             | Builds the dashboard (`apps/web/dist`), the tracker, and the API (`apps/api/dist/`: `server.mjs`, `worker.mjs`, `migrate.mjs`, `setup.mjs`, `reset-password.mjs`, `update-geo.mjs`, `backup-objects.mjs`, `restore-objects.mjs`, with their dependencies bundled in). Each build writes `THIRD_PARTY_LICENSES.txt`.                                         |
| `vp run version`              | Sets the release version in `package.json`, `apps/api/package.json`, and `deploy/compose.yaml` together: `vp run version 0.2.0`. Refuses a version that is not semantic. The release steps are in [docs/deployment.md](docs/deployment.md#images-and-releases).                                                                                             |
| `vp run ready`                | `vp check`, then all tests, then all builds. Run before committing.                                                                                                                                                                                                                                                                                         |

Inside one package: `vp -C apps/api run dev`, `vp -C apps/web test`, and so on.

`vp -C packages/tracker run demo` builds the tracker and opens its playground, a pretend single-page app that shows every request the tracker sends. Run the API alongside it.

Note: `vp dev` (built-in) and `vp run dev` (the root script) differ. `vp dev` starts only the dashboard.

## Commits

Commit messages follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>(<optional scope>): <description>

<optional body>

<optional footers>
```

| Type       | Use for                                                   |
| ---------- | --------------------------------------------------------- |
| `feat`     | A new user-visible feature                                |
| `fix`      | A bug fix                                                 |
| `docs`     | Documentation only                                        |
| `style`    | Formatting only, no behavior change                       |
| `refactor` | A code change that neither fixes a bug nor adds a feature |
| `perf`     | A performance improvement                                 |
| `test`     | Adding or fixing tests                                    |
| `build`    | Build system, toolchain, or dependency changes            |
| `ci`       | GitHub Actions and other CI configuration                 |
| `chore`    | Other maintenance                                         |
| `revert`   | Reverting an earlier commit                               |

- The scope is optional, lowercase, and names the area: `api`, `web`, `sdk`, `worker`, `ui`, `deps`.
- Mark a breaking change with `!` after the type or scope, and explain it in a `BREAKING CHANGE:` footer.
- Keep the first line to 100 characters or fewer.

Examples: `feat(api): add event ingestion endpoint`, `fix(web): keep the sidebar open after reload`, `feat(sdk)!: rename init() to start()`.

Two git hooks in `.vite-hooks/` run on every commit:

- `pre-commit` scans the staged changes for secrets with gitleaks and stops the commit if it finds one. It then runs `vp staged`, which runs `vp check --fix` on the staged files. Without gitleaks installed, the scan is skipped with a warning.
- `commit-msg` rejects a first line that does not match the format above. Merge, revert, `fixup!`, and `squash!` messages that git writes are allowed.

`VP_GIT_HOOKS=0 git commit ...` skips both hooks for one commit. Use it only in an emergency.

## Configuration

API (`apps/api`), read from the environment:

| Variable                         | Default                                       | Meaning                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`                           | `127.0.0.1`                                   | Interface to listen on. Use `0.0.0.0` inside a container.                                                                                                                                                                                                                                                                                                       |
| `PORT`                           | `3000`                                        | Port, 1 to 65535.                                                                                                                                                                                                                                                                                                                                               |
| `LOG_LEVEL`                      | `info`                                        | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`.                                                                                                                                                                                                                                                                                                |
| `DATABASE_URL`                   | The local database from `compose.yaml`        | PostgreSQL connection URL. Required when `NODE_ENV=production`, so a deployed instance never falls back to the local database.                                                                                                                                                                                                                                  |
| `CLICKHOUSE_URL`                 | `http://127.0.0.1:8123`                       | ClickHouse's HTTP interface, which holds analytics events. Required when `NODE_ENV=production`, without a user or password in it.                                                                                                                                                                                                                               |
| `CLICKHOUSE_USER`                | `ottertrail`                                  | ClickHouse user.                                                                                                                                                                                                                                                                                                                                                |
| `CLICKHOUSE_PASSWORD`            | `development`                                 | ClickHouse password. Required when `NODE_ENV=production`; error messages never repeat it.                                                                                                                                                                                                                                                                       |
| `CLICKHOUSE_DATABASE`            | `ottertrail`                                  | ClickHouse database; `vp run migrate` creates it. Letters, digits, and underscores.                                                                                                                                                                                                                                                                             |
| `TRUST_PROXY`                    | unset (trust no proxy)                        | Set when the API runs behind a proxy, so rate limits see client addresses: a number of proxy hops (`1` behind one proxy) or a comma-separated list of proxy IPs or CIDRs. Without a proxy, leave it unset: otherwise clients could fake their address.                                                                                                          |
| `GEO_SOURCE`                     | `database`                                    | Where visitor locations come from: `database` (the file below), `cloudflare` (Cloudflare's location headers; only when every request passes through Cloudflare), or `none`.                                                                                                                                                                                     |
| `GEO_DATABASE_PATH`              | `data/geo/dbip-city-lite.mmdb`                | The geolocation file, relative to the API's working directory.                                                                                                                                                                                                                                                                                                  |
| `DATA_CENTERS_PATH`              | `data/geo/data-centers.json`                  | The address ranges of cloud and hosting providers, whose "browsers" are ignored as bots ([web analytics](docs/web-analytics.md#data-centers)). The worker downloads them weekly, or `vp run geo:update` with the geolocation file.                                                                                                                              |
| `INSTANCE_EVENTS_PER_SECOND`     | `600`                                         | Events the instance may store per second, all projects together, with bursts of ten seconds' worth. Each project also has its own budget inside it, so one project cannot crowd out the others ([web analytics](docs/web-analytics.md#rate-limits)).                                                                                                            |
| `PUBLIC_URL`                     | `http://localhost:5173`                       | The instance's address, an origin without a path. Required in production, and must use HTTPS there (session cookies are `Secure`). Sign-in accepts requests only from this origin (in development, from any `localhost` port).                                                                                                                                  |
| `AUTH_SECRET`                    | a fixed development value                     | Signs dashboard session cookies. Required in production: at least 32 random characters, such as `openssl rand -base64 32` prints.                                                                                                                                                                                                                               |
| `TRACKER_SCRIPT_PATH`            | `../../packages/tracker/dist/tracker.js`      | The built tracker the API serves at `/t.js`, relative to the API's working directory; `v.js` beside it is served at `/v.js` ([Web Vitals](docs/web-analytics.md#web-vitals)). `vp run -r build` creates both; until then they answer 503.                                                                                                                       |
| `DASHBOARD_PATH`                 | `../web/dist`                                 | The built dashboard the API serves at `/`, relative to the API's working directory. Paths outside `/api/` without a file extension answer with its `index.html`. Until it is built, they answer 503. In development the dashboard's dev server serves it instead.                                                                                               |
| `OBJECT_STORE_URL`               | the local Garage                              | The S3-compatible object store that holds source maps ([errors](docs/errors.md#5-source-maps)): Garage, Cloudflare R2, Amazon S3. In development, the local Garage from `compose.yaml`; `off` for none. In production, source maps are off unless it is set, and then the two keys below are required. No keys in the URL.                                      |
| `OBJECT_STORE_REGION`            | `garage`                                      | The region requests are signed for: `garage` for Garage, `auto` for R2.                                                                                                                                                                                                                                                                                         |
| `OBJECT_STORE_BUCKET`            | `ottertrail`                                  | The bucket. It must exist; the deployment's Garage creates it.                                                                                                                                                                                                                                                                                                  |
| `OBJECT_STORE_ACCESS_KEY_ID`     | the local Garage's                            | The object store's access key ID.                                                                                                                                                                                                                                                                                                                               |
| `OBJECT_STORE_SECRET_ACCESS_KEY` | the local Garage's                            | Its secret. Never logged or shown in errors.                                                                                                                                                                                                                                                                                                                    |
| `SOURCE_MAP_STORAGE_BYTES`       | `1073741824` (1 GiB)                          | Compressed source maps the instance may keep, all projects together: from 1 MiB to 1 TiB.                                                                                                                                                                                                                                                                       |
| `GARAGE_ADMIN_TOKEN`             | none (development: the local Garage's)        | The stack's Garage's admin token, only when the object store is that Garage: the Settings page's Garage figures and the bucket's quota ([deployment](docs/deployment.md#storage)). 32 to 256 visible characters; never logged or shown.                                                                                                                         |
| `REPLAY_STORAGE_BYTES`           | `2147483648` (2 GiB)                          | Compressed session replays the instance may keep, all projects together ([session replay](docs/session-replay.md)): from 1 MiB to 1 TiB. A first guess, until measured on real sites.                                                                                                                                                                           |
| `TELEMETRY_RETENTION_DAYS`       | `30`                                          | Days ClickHouse keeps traces, logs, and metrics received over OTLP ([telemetry](docs/telemetry.md)): from 1 to 365. Older records are refused, and ClickHouse drops whole days once they pass it. `vp run migrate` applies a change to the tables.                                                                                                              |
| `UPTIME_ALLOW_PRIVATE_ADDRESSES` | `false`                                       | Whether uptime checks may reach loopback, private, unique-local, and shared (CGNAT) addresses: `true` only for a self-hosted install that checks services on its own private network, where every dashboard user may read them ([deployment](docs/deployment.md#uptime-checks)). Link-local addresses and known cloud metadata services are refused either way. |
| `UPTIME_DENY_ADDRESSES`          | unset                                         | IP addresses and CIDR ranges, separated by commas, that uptime checks may never reach, such as the server's own public address, whose ports a cloud firewall closes only to the outside ([deployment](docs/deployment.md#uptime-checks)). An entry that is not one stops the API and the worker at startup.                                                     |
| `SMTP_URL`                       | unset (email off)                             | The SMTP server alert email goes through ([deployment](docs/deployment.md#alert-email)): `smtps://user:password@host:465`, or `smtp://…:587` with STARTTLS, which is then required when there is a password; no query string. Without it, email channels can be made, and their deliveries fail saying email is not set up. Never logged or shown in errors.    |
| `EMAIL_FROM`                     | unset                                         | The sender of alert email, an address or a name and an address such as `Ottertrail <alerts@example.com>`. Required with `SMTP_URL`.                                                                                                                                                                                                                             |
| `REPLAY_PLAYER_PATH`             | `../../packages/replay-player/dist/player.js` | The built session replay player, served at `/replay-player.js` for the dashboard's player page.                                                                                                                                                                                                                                                                 |

Invalid values stop the server at startup with a message naming the variable. Error messages never repeat `DATABASE_URL` or `SMTP_URL`, because they can contain a password.

In production, run `node dist/migrate.mjs` (`vp run start:migrate` in `apps/api`) once as a deployment step before starting the API. The API does not migrate on startup, so several API processes never race to change the schema. Run the worker (`node dist/worker.mjs`, `vp run start:worker`) beside the API, with the same settings: it runs uptime checks, evaluates alert rules, sends alert notifications by email and webhook, deletes events past each project's retention and those of deleted projects, joins session replays, and keeps the location data current; it needs write access to the folder of `GEO_DATABASE_PATH` and `DATA_CENTERS_PATH`. `node dist/setup.mjs`, `node dist/reset-password.mjs`, and `node dist/update-geo.mjs` are the built `vp run setup`, `vp run reset-password`, and `vp run geo:update`. `deploy/compose.yaml` does all of this; see [docs/deployment.md](docs/deployment.md).

Dashboard dev server (`apps/web`):

| Variable                | Default                 | Meaning                              |
| ----------------------- | ----------------------- | ------------------------------------ |
| `OTTERTRAIL_API_ORIGIN` | `http://127.0.0.1:3000` | Where the dev server proxies `/api`. |

`compose.yaml` at the root is for local development only. Instances use the `compose.yaml` of a release (`deploy/compose.yaml`), which can also run an image built from source ([docs/deployment.md](docs/deployment.md#images-and-releases)).

## Maintenance

### The referrer spam list

Collection ignores visits referred by known referrer spam domains ([web analytics](docs/web-analytics.md#referrer-spam)). Matomo's community list ships in the repository (`apps/api/src/enrichment/referrer-spam/list.ts`, pinned to a commit) and reaches instances with each release: instances never download it.

- `vp run referrer-spam:update` downloads the latest commit's list (or `vp run referrer-spam:update -- <commit>`), checks it (hostnames only, at least 1,000 domains, no real referrer such as google.com or news.ycombinator.com, nor a parent or subdomain of one, and no hosting platform such as netlify.app itself: [web analytics](docs/web-analytics.md#referrer-spam)), and rewrites the shipped copy only when its domains changed. It prints the commit and the domains added and removed. An upstream entry that fails a guard wrongly goes in the script's `IGNORED_UPSTREAM`, with its reason: the script then leaves it out and prints it. With `GH_TOKEN` or `GITHUB_TOKEN` set, it sends the token to GitHub's API, which allows more requests with one. Exit codes: 0 changed, 2 unchanged, 1 failed. It never touches Ottertrail's own additions (`additions.ts`), which are edited by hand.
- `.github/workflows/referrer-spam.yml` runs it every Monday at 06:00 UTC, and by hand from the Actions tab, in `ottertrail/ottertrail` only. When the list changed, it installs the packages (as the Dockerfile does) and runs the checks that need no database before pushing anything: `vp check` on the whole workspace, and the referrer spam tests (`apps/api/tests/spam-rules.test.ts`, which check the new list against the guards). Then it commits it on the branch `bot/referrer-spam-list` (which it force-updates) and opens a pull request to `main`, or updates the open one, titled "chore: update the referrer spam list", with the counts and the Matomo commit. Review the added domains before merging. When nothing changed, it ends cleanly; when a check fails, the job fails and opens nothing.
- A pull request opened with the workflow's `GITHUB_TOKEN` starts no other workflow, so the checks above are all it gets: run `vp run ready` on the branch before merging, for the tests that need the databases.
- The workflow needs one repository setting: Settings, Actions, General, "Allow GitHub Actions to create and approve pull requests".

## Adding UI components

From `apps/web`:

```sh
pnpm dlx shadcn@latest add <component>
```

Then run `vp check --fix` from the root. See [docs/design-system.md](docs/design-system.md#components) for the local changes to keep when updating generated components.

## Licence

Ottertrail is licensed under the [GNU Affero General Public License, version 3 only](LICENSE). If you modify it and let people use it over a network, you must offer those users the modified source code. The browser tracker (`packages/tracker`) is licensed under the [MIT License](packages/tracker/LICENSE), so any site can include it.

Third-party code, data, and fonts are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Third-party data

IP geolocation by [DB-IP](https://db-ip.com), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The database is downloaded by the worker or `vp run geo:update` and is not part of this repository.

Referrer spam domains from Matomo's community [referrer spam list](https://github.com/matomo-org/referrer-spam-list), in the public domain (CC0-1.0), shipped in `apps/api/src/enrichment/referrer-spam/` ([Maintenance](#the-referrer-spam-list)).

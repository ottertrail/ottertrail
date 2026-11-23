# Development

How Ottertrail is built, how to run it locally, and the rules for changing it. To run it on a server, see [docs.ottertrail.app](https://docs.ottertrail.app).

## How it works

A Fastify API serves the React dashboard, the tracker, and the endpoints that collect data. A separate worker runs uptime checks, alerts, retention, scheduled backups, and the joining of session replays. PostgreSQL holds accounts, projects, and settings. ClickHouse holds events, traces, logs, and metrics. An S3-compatible object store holds replays, source maps, images, and saved heatmap views: Garage on the same server by default, or a bucket at another provider. [docs/data.md](data.md) lists what each store keeps, and for how long.

The design notes and the decisions behind them are in `docs/`: [web analytics](web-analytics.md), [product analytics](product-analytics.md), [errors](errors.md), [session replay](session-replay.md), [telemetry](telemetry.md), [AI usage](ai-usage.md), [uptime and alerts](uptime-alerts.md), [webhooks](webhooks.md), [the dashboard](dashboard.md), [access](access.md), [ClickHouse](clickhouse.md), [deployment](deployment.md), and [the design system](design-system.md). [CLAUDE.md](../CLAUDE.md) holds the architecture rules that every change follows.

## Repository layout

- `apps/api`: the Fastify API, the worker, and the command-line scripts.
- `apps/web`: the dashboard (React, Vite, Tailwind CSS 4, shadcn/ui on Base UI).
- `packages/tracker`: the browser script. `tracker.js` loads the rest only when a page needs it: `v.js` for Web Vitals, `r.js` for session replay, `h.js` for heatmaps, `o.js` for the heatmap overlay (about 7.8 KB gzipped), and `s.js` to save a heatmap view (about 28 KB gzipped). The API serves it at `/t.js`, and `demo/` has a playground page.
- `packages/replay-player`: the session replay player.
- `packages/sourcemaps`: uploads a website build's source maps to Ottertrail.
- `deploy/`: the release's Compose file, its example settings, and the backup and restore scripts.

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

Lint and format settings live only in the root `vite.config.ts` (the `lint` and `fmt` blocks), with `overrides` per package. Don't add `.oxlintrc.json`, `.oxfmtrc.json`, ESLint, or Prettier configs. Oxfmt also sorts imports and Tailwind classes, including inside `cn()` and `cva()`.

## Setup

Install the Vite+ CLI once ([instructions](https://viteplus.dev/guide/)), then:

```sh
vp install
```

`vp install` also installs the git hooks, through the `prepare` script (`vp config --no-agent`). Install [gitleaks](https://github.com/gitleaks/gitleaks) too (`brew install gitleaks`), so commits are scanned for secrets. See [Commits](#commits).

The dashboard's browser tests run in headless Chromium. Download it once per machine (about 100 MB):

```sh
vp -C apps/web exec playwright install --only-shell chromium
```

Start the local databases and create their tables:

```sh
podman compose up -d   # or: docker compose up -d
vp run migrate
```

Then start everything with `vp run dev`, and create the dashboard's owner account: `vp run setup` prints a one-time link (see [Signing in](dashboard.md#81-signing-in)).

On its first start the worker downloads the location database (about 130 MB) and the data-center ranges into `apps/api/data/geo/`, as an instance's worker does, and the API loads them within 10 minutes. To skip the downloads, turn off "Update location data automatically" on the Settings page. Until the files arrive, or without them, events are stored without a location ([web analytics](web-analytics.md#keeping-the-files-current)).

The local services are for development only:

- PostgreSQL listens on `127.0.0.1:5433`, not the usual 5432, to avoid clashing with other local PostgreSQL servers. It has no password.
- ClickHouse listens on `127.0.0.1:8123`, as user `ottertrail` with password `development`, with the same small-server settings as deployments (`deploy/clickhouse/`).
- Garage, the S3-compatible object store for source maps, replays, images, and saved heatmap views, listens on `127.0.0.1:3900`, with the access key and bucket of the API's development defaults (`compose.yaml`).

Their data lives in the `ottertrail_postgres-data`, `ottertrail_clickhouse-data`, and `ottertrail_garage-data` volumes. `podman compose down -v` deletes them.

## Demo data

For development only, `vp run seed` fills the local instance with a project named Demo shop, so every page of the dashboard has something to show. A first run takes a few seconds; a rerun takes about 40, most of them spent by ClickHouse deleting the previous project's rows.

- Web and product analytics: 30 days of visits (about 46,000 events) with a weekday rhythm; sources from search, social sites, referrals, and tagged campaigns; places, devices, entry and exit pages; production and staging; and two releases. There is a signup flow (pricing, `signup_started`, `signed_up`, `project_created`), four goals with "Signed up" as the main one, two saved funnels, and signed-in users going back nine weeks, for retention. Web Vitals are worse on phones.
- Errors and replays: a new error in the latest release, with an uploaded source map and six session replays (the recording in `apps/api/tests/fixtures/replay-recording.json`); an error that came back after it was resolved; one resolved for good; and the servers' exceptions, sent over OpenTelemetry and joined to their traces.
- Monitoring: 14 days of traces and logs from three services (`web`, `billing`, `worker`; about 39,000 spans and log records), with database calls, one slow route, and logs at debug, info, warning, and error. Two days ago, from 13:00 to 15:30 UTC, the database is overloaded: searches run two and a half times slower and a third of them time out, payments fail more often, and requests wait for database connections, with warnings that the pool is exhausted, and a quarter of them give up and fail. The Logs, Traces, Services, and Databases charts all show it. There are also 7 days of app metrics, two of them histograms, and host metrics from three hosts (`app-1`, `app-2`, and `db-1`, whose CPU, memory, and data disk run high).
- Uptime and alerts: three checks with 30 days of results, a past incident, one check down now, and a certificate about to expire; eight alert rules with their history, two of them firing now. The checks point at `example.com`, `example.net`, and a `.example` host that never resolves, and the worker keeps checking them while it runs.

The seed refuses to run with `NODE_ENV=production`, and asks for `vp run seed -- --yes` when `PUBLIC_URL`, `DATABASE_URL`, `CLICKHOUSE_URL`, or `OBJECT_STORE_URL` differ from the development defaults. It touches only the Demo shop project, apart from adding one notification channel, "Demo shop alerts (sends nothing)", which sends email to `alerts@demo-shop.example`, an address that can't receive mail. Without an object store, it leaves out source maps and replays.

Run it again to make the project afresh: it deletes the old Demo shop first, as deleting a project in its settings does, then makes it again with the same data, moved to the current day. To remove it, delete the project in its settings, and the channel in the instance's settings if you like. The anonymous traffic covers 30 days and only signed-in activity goes back further, so a 30-day period compared with the one before looks like steep growth.

## Commands

Run from the repository root.

| Command                       | What it does                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vp run dev`                  | Starts the API (port 3000) and the worker, both restarting on change, and the dashboard dev server (port 5173, or the next free port). The dashboard proxies `/api` to the API.                                                                                                                                                                                 |
| `vp run migrate`              | Applies database migrations that have not run yet. Safe to repeat.                                                                                                                                                                                                                                                                                              |
| `vp run geo:update`           | Downloads the latest DB-IP City Lite geolocation database and the data-center ranges to `apps/api/data/geo/` now, checks them, and replaces the old files; the API loads them within 10 minutes. The worker does the same on its own while "Update location data automatically" is on.                                                                          |
| `vp run referrer-spam:update` | For maintainers, before a release: refreshes the shipped referrer spam list from Matomo's ([Maintenance](#the-referrer-spam-list)).                                                                                                                                                                                                                             |
| `vp run visits`               | Prints a project's recent visits, worked out from its events: `vp run visits -- <project name> <hours>` (default: the first project, 24 hours).                                                                                                                                                                                                                 |
| `vp run setup`                | Prints a one-time link (valid for an hour) that creates the install's owner account and names the instance. Refuses once an owner exists.                                                                                                                                                                                                                       |
| `vp run seed`                 | Replaces the Demo shop project with demo data for every dashboard page, for development only (see [Demo data](#demo-data)). `vp run seed -- --yes` when the settings are not the development defaults.                                                                                                                                                          |
| `vp run reset-password`       | Prints a one-time link (valid for an hour) that sets a dashboard account's password, the owner's included: `vp run reset-password -- <email>`. Using it signs the account out everywhere ([access](access.md#password-reset-links)).                                                                                                                            |
| `vp run report`               | Prints a project's reports (summary, visitors per day, top pages, breakdowns, custom events) for the last days in the instance's timezone: `vp run report -- <project name> <days>` (default: the first project, 7 days).                                                                                                                                       |
| `vp run bench:reports`        | Times the report queries on fake data in a temporary PostgreSQL schema and ClickHouse database, then drops both: `vp run bench:reports -- <visits> <days>` (default: 200,000 visits, 30 days). In Podman's default 2 GB machine, the whole-page part can run out of ClickHouse memory ([ClickHouse](clickhouse.md#memory)).                                     |
| `vp check`                    | Formats, lints, and type-checks the whole workspace. `vp check --fix` applies fixes.                                                                                                                                                                                                                                                                            |
| `vp run -r test`              | Runs the tests in every package. The API tests need the local databases running; each test file uses its own temporary PostgreSQL schema and ClickHouse database, named with the time it was made (`test_<seconds>_<random>`), and a run first drops those a cut-off run left more than two hours ago. The dashboard's browser tests need Chromium (see Setup). |
| `vp run -r build`             | Builds the dashboard (`apps/web/dist`), the tracker, and the API (`apps/api/dist/`: `server.mjs`, `worker.mjs`, `migrate.mjs`, `setup.mjs`, `reset-password.mjs`, `update-geo.mjs`, `backup-objects.mjs`, `restore-objects.mjs`, `restore-backup.mjs`, with their dependencies bundled in). Each build writes `THIRD_PARTY_LICENSES.txt`.                       |
| `vp run version`              | Sets the release version in `package.json`, `apps/api/package.json`, and `deploy/compose.yaml` together: `vp run version 0.2.0`. Refuses a version that is not semantic. The release steps are in [deployment](deployment.md#images-and-releases).                                                                                                              |
| `vp run ready`                | `vp check`, then all tests, then all builds. Run it before committing.                                                                                                                                                                                                                                                                                          |

Inside one package: `vp -C apps/api run dev`, `vp -C apps/web test`, and so on.

`vp -C packages/tracker run demo` builds the tracker and opens its playground, a pretend single-page app that shows every request the tracker sends. Run the API alongside it.

`vp dev` (built in) and `vp run dev` (the root script) differ: `vp dev` starts only the dashboard.

On GitHub, `.github/workflows/ci.yml` runs `vp run ready` on every push to `main` and every pull request, with the databases from `compose.yaml` and headless Chromium. It checks out the whole history with its tags, which the release notes tests read. GitHub's runner for a private repository has 2 CPUs, so with `CI=true` (which GitHub sets) the test configs give tests 60 seconds instead of 15 (hooks 120) and polling assertions 5 seconds instead of 1. Releases (`release.yml`) build and publish the image when a version tag is pushed ([deployment](deployment.md#images-and-releases)).

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

The API (`apps/api`) reads these from the environment:

| Variable                         | Default                                       | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HOST`                           | `127.0.0.1`                                   | Interface to listen on. Use `0.0.0.0` inside a container.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PORT`                           | `3000`                                        | Port, 1 to 65535.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `LOG_LEVEL`                      | `info`                                        | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `DATABASE_URL`                   | The local database from `compose.yaml`        | PostgreSQL connection URL. Required when `NODE_ENV=production`, so a deployed instance never falls back to the local database.                                                                                                                                                                                                                                                                                                                                                                               |
| `CLICKHOUSE_URL`                 | `http://127.0.0.1:8123`                       | ClickHouse's HTTP interface, which holds events and telemetry. Required when `NODE_ENV=production`, without a user or password in it.                                                                                                                                                                                                                                                                                                                                                                        |
| `CLICKHOUSE_USER`                | `ottertrail`                                  | ClickHouse user.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `CLICKHOUSE_PASSWORD`            | `development`                                 | ClickHouse password. Required when `NODE_ENV=production`; error messages never repeat it.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `CLICKHOUSE_DATABASE`            | `ottertrail`                                  | ClickHouse database; `vp run migrate` creates it. Letters, digits, and underscores.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `TRUST_PROXY`                    | unset (trust no proxy)                        | Set when the API runs behind a proxy, so rate limits see client addresses: a number of proxy hops (`1` behind one proxy) or a comma-separated list of proxy IPs or CIDRs. Without a proxy, leave it unset, or clients could fake their address.                                                                                                                                                                                                                                                              |
| `GEO_SOURCE`                     | `database`                                    | Where visitor locations come from: `database` (the file below), `cloudflare` (Cloudflare's location headers, only when every request passes through Cloudflare), or `none`.                                                                                                                                                                                                                                                                                                                                  |
| `GEO_DATABASE_PATH`              | `data/geo/dbip-city-lite.mmdb`                | The geolocation file, relative to the API's working directory.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `DATA_CENTERS_PATH`              | `data/geo/data-centers.json`                  | The address ranges of cloud and hosting providers, whose "browsers" are ignored as bots ([web analytics](web-analytics.md#data-centers)). The worker downloads them weekly, as does `vp run geo:update` with the geolocation file.                                                                                                                                                                                                                                                                           |
| `INSTANCE_EVENTS_PER_SECOND`     | `600`                                         | Events the instance may store per second, all projects together, with bursts of ten seconds' worth. Each project also has its own budget inside it, so one project cannot crowd out the others ([web analytics](web-analytics.md#rate-limits)).                                                                                                                                                                                                                                                              |
| `PUBLIC_URL`                     | `http://localhost:5173`                       | The instance's address, an origin without a path. Required in production, and must use HTTPS there, because session cookies are `Secure`. Sign-in accepts requests only from this origin (in development, from any `localhost` port).                                                                                                                                                                                                                                                                        |
| `AUTH_SECRET`                    | a fixed development value                     | Signs dashboard session cookies. Required in production: at least 32 random characters, such as `openssl rand -base64 32` prints.                                                                                                                                                                                                                                                                                                                                                                            |
| `TRACKER_SCRIPT_PATH`            | `../../packages/tracker/dist/tracker.js`      | The built tracker the API serves at `/t.js`, relative to the API's working directory. `v.js`, `r.js`, `h.js`, `o.js`, and `s.js` beside it are served at `/v.js`, `/r.js`, `/h.js`, `/o.js`, and `/s.js` ([Web Vitals](web-analytics.md#web-vitals), [session replay](session-replay.md), [heatmaps](web-analytics.md#heatmaps), [the heatmap overlay](web-analytics.md#the-overlay-on-your-site), [saved views](web-analytics.md#saved-views)). `vp run -r build` creates them; until then they answer 503. |
| `DASHBOARD_PATH`                 | `../web/dist`                                 | The built dashboard the API serves at `/`, relative to the API's working directory. Paths outside `/api/` without a file extension answer with its `index.html`. Until it is built, they answer 503. In development the dashboard's dev server serves it instead.                                                                                                                                                                                                                                            |
| `OBJECT_STORE_URL`               | the local Garage                              | The S3-compatible object store for source maps ([errors](errors.md#5-source-maps)), session replays, images, and saved heatmap views: Garage, Cloudflare R2, or Amazon S3. In development, the local Garage from `compose.yaml`; `off` for none. In production, those features are off unless it is set, and then the two keys below are required. No keys in the URL.                                                                                                                                       |
| `OBJECT_STORE_REGION`            | `garage`                                      | The region requests are signed for: `garage` for Garage, `auto` for R2.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `OBJECT_STORE_BUCKET`            | `ottertrail`                                  | The bucket. It must exist; the deployment's Garage creates it.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `OBJECT_STORE_ACCESS_KEY_ID`     | the local Garage's                            | The object store's access key ID.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `OBJECT_STORE_SECRET_ACCESS_KEY` | the local Garage's                            | Its secret. Never logged or shown in errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `SOURCE_MAP_STORAGE_BYTES`       | `1073741824` (1 GiB)                          | Compressed source maps the instance may keep, all projects together: from 1 MiB to 1 TiB.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GARAGE_ADMIN_TOKEN`             | none (development: the local Garage's)        | The stack's Garage's admin token, only when the object store is that Garage: the Settings page's Garage figures and the bucket's quota ([deployment](deployment.md#storage)). 32 to 256 visible characters; never logged or shown.                                                                                                                                                                                                                                                                           |
| `REPLAY_STORAGE_BYTES`           | `2147483648` (2 GiB)                          | Compressed session replays the instance may keep, all projects together ([session replay](session-replay.md)): from 1 MiB to 1 TiB. A first guess, until it is measured on real sites.                                                                                                                                                                                                                                                                                                                       |
| `TELEMETRY_RETENTION_DAYS`       | `30`                                          | Days ClickHouse keeps traces, logs, and metrics received over OTLP ([telemetry](telemetry.md)): from 1 to 365. Older records are refused, and ClickHouse drops whole days once they pass it. `vp run migrate` applies a change to the tables.                                                                                                                                                                                                                                                                |
| `UPTIME_ALLOW_PRIVATE_ADDRESSES` | `false`                                       | Whether uptime checks may reach loopback, private, unique-local, and shared (CGNAT) addresses: `true` only for a self-hosted install that checks services on its own private network, where every dashboard user may read them ([deployment](deployment.md#uptime-checks)). Link-local addresses and known cloud metadata services are refused either way.                                                                                                                                                   |
| `UPTIME_DENY_ADDRESSES`          | unset                                         | IP addresses and CIDR ranges, separated by commas, that uptime checks may never reach, such as the server's own public address, whose ports a cloud firewall closes only to the outside ([deployment](deployment.md#uptime-checks)). An entry that is not an address or range stops the API and the worker at startup.                                                                                                                                                                                       |
| `SMTP_URL`                       | unset (email off)                             | The SMTP server that alert email and account email go through ([deployment](deployment.md#email)): `smtps://user:password@host:465`, or `smtp://…:587` with STARTTLS, which is then required when there is a password; no query string. Without it, email channels can still be made, but their deliveries fail saying email is not set up, and no account email is sent. Never logged or shown in errors.                                                                                                   |
| `EMAIL_FROM`                     | unset                                         | The sender of alert email and account email, an address or a name and an address such as `Ottertrail <alerts@example.com>`. Required with `SMTP_URL`.                                                                                                                                                                                                                                                                                                                                                        |
| `CLICKHOUSE_BACKUP_PATH`         | unset                                         | The worker only: the folder ClickHouse writes its backup files into, shared with the worker, for scheduled backups ([deployment](deployment.md#scheduled-backups)). `deploy/compose.yaml` sets it; unset, scheduled backups fail and say why.                                                                                                                                                                                                                                                                |
| `BACKUP_S3_…`                    | unset (no destination)                        | The worker only: where scheduled backups go, `BACKUP_S3_ENDPOINT`, `_REGION`, `_BUCKET`, `_PREFIX` (default `ottertrail-backups`), `_ACCESS_KEY_ID`, and `_SECRET_ACCESS_KEY` ([deployment](deployment.md#scheduled-backups)). The API never reads them. If they are partly set or invalid, the worker logs why and keeps its other jobs, and the Backups tab shows the problem. In development, export them in the shell that runs `vp run dev`.                                                            |
| `REPLAY_PLAYER_PATH`             | `../../packages/replay-player/dist/player.js` | The built session replay player, served at `/replay-player.js` for the dashboard's player page.                                                                                                                                                                                                                                                                                                                                                                                                              |

Invalid values stop the server at startup with a message naming the variable. Error messages never repeat `DATABASE_URL` or `SMTP_URL`, because they can contain a password.

In production, run `node dist/migrate.mjs` (`vp run start:migrate` in `apps/api`) once as a deployment step before starting the API. The API does not migrate on startup, so several API processes never race to change the schema. Run the worker (`node dist/worker.mjs`, `vp run start:worker`) beside the API, with the same settings. It runs uptime checks, evaluates alert rules, sends alert notifications by email and webhook, deletes events past each project's retention and those of deleted projects, joins session replays, runs scheduled backups, and keeps the location data current; it needs write access to the folder of `GEO_DATABASE_PATH` and `DATA_CENTERS_PATH`. `node dist/setup.mjs`, `node dist/reset-password.mjs`, and `node dist/update-geo.mjs` are the built `vp run setup`, `vp run reset-password`, and `vp run geo:update`. `deploy/compose.yaml` does all of this; see [deployment](deployment.md).

The dashboard dev server (`apps/web`) reads one variable:

| Variable                | Default                 | Meaning                              |
| ----------------------- | ----------------------- | ------------------------------------ |
| `OTTERTRAIL_API_ORIGIN` | `http://127.0.0.1:3000` | Where the dev server proxies `/api`. |

`compose.yaml` at the root is for local development only. Instances use the `compose.yaml` of a release (`deploy/compose.yaml`), which can also run an image built from source ([deployment](deployment.md#images-and-releases)).

## Maintenance

### The referrer spam list

Collection ignores visits referred by known referrer spam domains ([web analytics](web-analytics.md#referrer-spam)). Matomo's community list ships in the repository (`apps/api/src/enrichment/referrer-spam/list.ts`, pinned to a commit) and reaches instances with each release. Instances never download it.

- `vp run referrer-spam:update` downloads the latest commit's list (or `vp run referrer-spam:update -- <commit>`) and checks it: hostnames only, at least 1,000 domains, no real referrer such as google.com or news.ycombinator.com, nor a parent or subdomain of one, and no hosting platform such as netlify.app itself ([web analytics](web-analytics.md#referrer-spam)). It rewrites the shipped copy only when its domains changed, and prints the commit and the domains added and removed. An upstream entry that fails a guard wrongly goes in the script's `IGNORED_UPSTREAM`, with its reason; the script then leaves it out and prints it. With `GH_TOKEN` or `GITHUB_TOKEN` set, it sends the token to GitHub's API, which allows more requests. Exit codes: 0 changed, 2 unchanged, 1 failed. It never touches Ottertrail's own additions (`additions.ts`), which are edited by hand.
- `.github/workflows/referrer-spam.yml` runs it every Monday at 06:00 UTC, and by hand from the Actions tab, in `ottertrail/ottertrail` only. When the list changed, it installs the packages (as the Dockerfile does) and runs the checks that need no database before pushing anything: `vp check` on the whole workspace, and the referrer spam tests (`apps/api/tests/spam-rules.test.ts`, which check the new list against the guards). It then commits the list on the branch `bot/referrer-spam-list`, which it force-updates, and opens a pull request to `main` titled "chore: update the referrer spam list", with the counts and the Matomo commit, or updates the open one. Review the added domains before merging. When nothing changed, it ends cleanly; when a check fails, the job fails and opens nothing.
- A pull request opened with the workflow's `GITHUB_TOKEN` starts no other workflow, so the checks above are all it gets. Run `vp run ready` on the branch before merging, for the tests that need the databases.
- The workflow needs one repository setting: Settings, Actions, General, "Allow GitHub Actions to create and approve pull requests".

### Cloudflare's address ranges

Caddy trusts `CF-Connecting-IP` only from Cloudflare's ranges ([deployment](deployment.md#behind-cloudflares-proxy)). The ranges ship in `deploy/compose.yaml`, in the `caddy-proxy-cloudflare` config, and reach instances with each release.

- `node scripts/update-cloudflare-ranges.ts` downloads <https://www.cloudflare.com/ips-v4> and <https://www.cloudflare.com/ips-v6> and checks them: every line one globally routable CIDR range of its family (`parseRange` in `apps/api/src/enrichment/data-centers.ts`: no private, loopback, link-local, ULA, or 6to4 addresses), written from its first address, at most a /12 of IPv4 or a /28 of IPv6 (Cloudflare's widest are a /13 and a /29), no repeats, and from 12 IPv4 and 5 IPv6 ranges to 100 of each, so a list cut off at a line break is refused. It rewrites the config's `trusted_proxies` line and the caddy service's `ottertrail.config.caddy-proxy-cloudflare` label only when a range was added or removed, and prints them. It exits 0 when it rewrote the file, 2 when nothing changed, and 1 when the download or a check failed, leaving the file as it was. It needs no installed packages.
- `.github/workflows/cloudflare-ranges.yml` runs it every Monday at 06:30 UTC, and by hand from the Actions tab, in `ottertrail/ottertrail` only. When the ranges changed, it installs the packages and runs `vp check` and the deploy file tests (`apps/api/tests/deploy-files.test.ts`, which check the ranges and the label). It then commits `deploy/compose.yaml` on `bot/cloudflare-ranges`, which it force-updates, and opens or updates a pull request to `main` titled "chore: update Cloudflare's address ranges", listing the ranges added and removed.
- As with the referrer spam list, run `vp run ready` on the branch before merging, and the workflow needs "Allow GitHub Actions to create and approve pull requests". Name new ranges in the next release's notes: instances behind Cloudflare need the new `compose.yaml` and `docker compose up -d`, and owners who lock their firewall to Cloudflare's ranges need to update it.

## Adding UI components

From `apps/web`:

```sh
pnpm dlx shadcn@latest add <component>
```

Then run `vp check --fix` from the root. See [the design system](design-system.md#components) for the local changes to keep when updating generated components.

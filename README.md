# Ottertrail

Analytics, error tracking, and email engagement for developers and small teams. Each customer runs a dedicated instance. See [CLAUDE.md](CLAUDE.md) for the architecture rules and [docs/roadmap.md](docs/roadmap.md) for the build order.

## Current state

This repository is a foundation, not a working product yet. It contains:

- `apps/web`: React dashboard (Vite, Tailwind CSS v4, shadcn/ui on Base UI) with sign-in, a project list, and inside each project its web analytics and settings (install snippet and allowed sites), plus the Ottertrail design system and its reference page. Product analytics, users, errors, and email are listed in each project's sidebar as **Planned**; none of them exist yet.
- `apps/api`: Fastify API with `GET /api/health` (a liveness check) and `POST /api/events`, which collects events into PostgreSQL. Dashboard sign-in works (the owner account comes from `vp run setup`). Signed-in users manage projects and read reports (`GET /api/projects/:id/analytics`; `vp run report` prints the same reports in a terminal). There are no invitations or job queue yet.
- `packages/tracker`: the browser script (`dist/tracker.js`, about 2.4 KB gzipped) that sends pageviews and custom events, with a playground page in `demo/`. The API serves the built script at `/t.js`, so sites load it from their instance.

The design system is documented in [docs/design-system.md](docs/design-system.md). How web analytics works, and the decisions behind it, are in [docs/web-analytics.md](docs/web-analytics.md); the dashboard, including sign-in, in [docs/dashboard.md](docs/dashboard.md).

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

Start the local database and create its tables:

```sh
podman compose up -d   # or: docker compose up -d
vp run migrate
vp run geo:update      # optional: the geolocation database, about 130 MB
```

Then start everything with `vp run dev`, and create the dashboard's owner account: `vp run setup` prints a one-time link (see [Signing in](docs/dashboard.md#81-signing-in)).

The database listens on `127.0.0.1:5433` (not the usual 5432, to avoid clashing with other local PostgreSQL servers) and has no password. It is for local development only. Its data lives in the `ottertrail_postgres-data` volume; `podman compose down -v` deletes it.

## Commands

Run from the repository root.

| Command                | What it does                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vp run dev`           | Starts the API (port 3000, restarts on change) and the dashboard dev server (port 5173, or the next free port). The dashboard proxies `/api` to the API.                                                     |
| `vp run migrate`       | Applies database migrations that have not run yet. Safe to repeat.                                                                                                                                           |
| `vp run geo:update`    | Downloads the latest DB-IP City Lite geolocation database to `apps/api/data/geo/`, checks it, and replaces the old file. Restart the API afterwards. Without it, events are stored without a location.       |
| `vp run visits`        | Prints a project's recent visits, worked out from its events: `vp run visits -- <project name> <hours>` (default: the first project, 24 hours).                                                              |
| `vp run setup`         | Prints a one-time link (valid for an hour) that creates the dashboard's owner account. Refuses once an owner exists.                                                                                         |
| `vp run report`        | Prints a project's reports (summary, visitors per day, top pages, breakdowns, custom events) for the last days in `TIMEZONE`: `vp run report -- <project name> <days>` (default: the first project, 7 days). |
| `vp run bench:reports` | Times the report queries on fake data in a temporary schema, then drops it: `vp run bench:reports -- <visits> <days>` (default: 200,000 visits, 30 days).                                                    |
| `vp check`             | Formats, lints, and type-checks the whole workspace. `vp check --fix` applies fixes.                                                                                                                         |
| `vp run -r test`       | Runs the tests in every package. The API tests need the local database running; each test file uses its own temporary schema. The dashboard's browser tests need Chromium (see Setup).                       |
| `vp run -r build`      | Builds the dashboard (`apps/web/dist`) and bundles the API (`apps/api/dist/server.mjs` and `apps/api/dist/migrate.mjs`).                                                                                     |
| `vp run ready`         | `vp check`, then all tests, then all builds. Run before committing.                                                                                                                                          |

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

- The scope is optional, lowercase, and names the area: `api`, `web`, `sdk`, `worker`, `email`, `ui`, `deps`.
- Mark a breaking change with `!` after the type or scope, and explain it in a `BREAKING CHANGE:` footer.
- Keep the first line to 100 characters or fewer.

Examples: `feat(api): add event ingestion endpoint`, `fix(web): keep the sidebar open after reload`, `feat(sdk)!: rename init() to start()`.

Two git hooks in `.vite-hooks/` run on every commit:

- `pre-commit` scans the staged changes for secrets with gitleaks and stops the commit if it finds one. It then runs `vp staged`, which runs `vp check --fix` on the staged files. Without gitleaks installed, the scan is skipped with a warning.
- `commit-msg` rejects a first line that does not match the format above. Merge, revert, `fixup!`, and `squash!` messages that git writes are allowed.

`VP_GIT_HOOKS=0 git commit ...` skips both hooks for one commit. Use it only in an emergency.

## Configuration

API (`apps/api`), read from the environment:

| Variable              | Default                                  | Meaning                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`                | `127.0.0.1`                              | Interface to listen on. Use `0.0.0.0` inside a container.                                                                                                                                                                                                                                                                                                       |
| `PORT`                | `3000`                                   | Port, 1 to 65535.                                                                                                                                                                                                                                                                                                                                               |
| `LOG_LEVEL`           | `info`                                   | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`.                                                                                                                                                                                                                                                                                                |
| `DATABASE_URL`        | The local database from `compose.yaml`   | PostgreSQL connection URL. Required when `NODE_ENV=production`, so a deployed instance never falls back to the local database.                                                                                                                                                                                                                                  |
| `TRUST_PROXY`         | unset (trust no proxy)                   | Set when the API runs behind a proxy, so rate limits see client addresses: a number of proxy hops (`1` behind one proxy) or a comma-separated list of proxy IPs or CIDRs. Without a proxy, leave it unset: otherwise clients could fake their address.                                                                                                          |
| `GEO_SOURCE`          | `database`                               | Where visitor locations come from: `database` (the file below), `cloudflare` (Cloudflare's location headers; only when every request passes through Cloudflare), or `none`.                                                                                                                                                                                     |
| `GEO_DATABASE_PATH`   | `data/geo/dbip-city-lite.mmdb`           | The geolocation file, relative to the API's working directory.                                                                                                                                                                                                                                                                                                  |
| `PUBLIC_URL`          | `http://localhost:5173`                  | The instance's address, an origin without a path. Required in production, and must use HTTPS there (session cookies are `Secure`). Sign-in accepts requests only from this origin (in development, from any `localhost` port).                                                                                                                                  |
| `AUTH_SECRET`         | a fixed development value                | Signs dashboard session cookies. Required in production: at least 32 random characters, such as `openssl rand -base64 32` prints.                                                                                                                                                                                                                               |
| `TRACKER_SCRIPT_PATH` | `../../packages/tracker/dist/tracker.js` | The built tracker the API serves at `/t.js`, relative to the API's working directory. `vp run -r build` creates it; until then `/t.js` answers 503.                                                                                                                                                                                                             |
| `TIMEZONE`            | `UTC`                                    | IANA timezone of the instance, such as `Asia/Singapore`. A new visitor salt starts at midnight here, and reports count days here. Aliases are stored by their official name (`singapore` becomes `Asia/Singapore`). Fixed offsets such as `+08:00` are refused: Node.js and PostgreSQL read their sign in opposite directions. `Etc/GMT-8` names UTC+8 in both. |

Invalid values stop the server at startup with a message naming the variable. Error messages never repeat `DATABASE_URL`, because it can contain a password.

In production, run `node dist/migrate.mjs` (`vp run start:migrate` in `apps/api`) once as a deployment step before starting the API. The API does not migrate on startup, so several API processes never race to change the schema.

Dashboard dev server (`apps/web`):

| Variable                | Default                 | Meaning                              |
| ----------------------- | ----------------------- | ------------------------------------ |
| `OTTERTRAIL_API_ORIGIN` | `http://127.0.0.1:3000` | Where the dev server proxies `/api`. |

Production serving of the dashboard (from the API or a separate static server), Docker images, and production Compose files are not set up yet. `compose.yaml` is for local development only.

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

IP geolocation by [DB-IP](https://db-ip.com), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The database is downloaded by `vp run geo:update` and is not part of this repository.

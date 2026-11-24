# Ottertrail

Web analytics, product analytics, error tracking, and monitoring (logs, metrics, traces) for small software teams, in one connected tool. A self-hosted install serves one customer. Organizations, several on one deployment, are planned: their plan and its step order are private, in `docs/multi-tenancy.md` of the ottertrail-pro repository. Features ship in stages: see `docs/roadmap.md`.

If `docs/private/product-spec.md` exists, read it before work on product scope or deployment. It holds the full spec and is not in git. Hosting, pricing, and final branding are undecided; do not invent business commitments.

## Architecture

- Today one customer per instance; organizations are coming (the private plan above). An instance holds projects (sites and apps), and everything it stores belongs to a project (`project_id`). New work must not add anything an organization would have to untangle later: no new deployment-wide customer data, no references between rows that could cross organizations.
- Check access on the server, in one place (`apps/api/src/access/access.ts`, `docs/access.md`): every project route runs `requireProjectAccess` with the area and level it needs, and every other dashboard route `requirePermission`; both read the user's role and grants from the database on each request. A test fails for any route that declares neither and is not listed as public. A project ID sent by the browser is never enough on its own.
- Settings that differ between instances, such as the timezone, live in the instance settings (`instance_settings`), not in the deployment's environment, unless they are infrastructure.
- Stack: Fastify API, React dashboard (Vite), a separate Node.js worker, PostgreSQL, ClickHouse, Docker Compose. PostgreSQL holds accounts, projects, settings, and jobs. ClickHouse holds the high-volume data: analytics events, and later logs, traces, and metrics (`docs/storage-benchmark.md`). Events and telemetry go straight to ClickHouse, and reports read them there (`docs/clickhouse.md`). No Redis, Kafka, or Kubernetes without a measured need.
- ClickHouse tables are ordered by project, then time (metrics by project, then name, then time; check results by project, then check, then time), and every query filters by `project_id` first.
- All modules share one model: project, environment, release, identity (anonymous and known end users), and session. Each module links into the per-user and per-release timelines.
- A module is complete when it can replace the tool it targets for a real production app.
- Out of scope: email campaigns, mailing lists, and email analytics. Ottertrail's own account email (sign-up verification, password reset) and alert notifications are separate and stay minimal.

## Ingestion

- Public project keys allow bounded event collection only. They never allow reads, exports, or configuration.
- Browser payloads are untrusted. Validate them with Fastify schemas, limit body size, batch size, and field lengths, and check timestamps.
- Store when an event happened and when it arrived. Assume at-least-once delivery: a retry must be the same row (same `project_id`, day, and `event_id`: the day, not the exact time, which clock correction moves a little on each attempt), which ClickHouse's `ReplacingMergeTree` keeps once and reports read with `FINAL`. Telemetry pages and alerts that aggregate large windows read without `FINAL` where measured necessary, and forced merges bound how long a copy counts. Nothing is looked up before an insert.
- Acknowledge events and telemetry only after ClickHouse has written them (asynchronous inserts, waiting for the write); answer 503 while it cannot.
- Rate-limit per IP and per project, and limit the instance's volume and each project's, so one project cannot crowd out the others. Reject bad requests before any database work.

## Working in this repository

- Use the Vite+ commands in `docs/development.md`. Run `vp run ready` before committing, and do not claim a check passed without running it.
- Lint and format settings live only in the root `vite.config.ts`.
- Commit messages follow Conventional Commits (see "Commits" in `docs/development.md`). Do not bypass the hooks in `.vite-hooks/`.
- Label planned features as planned in the UI and docs. Never show seeded or fake data as real.
- Reuse maintained libraries. Add a dependency only for a current need, and pin versions.
- Record design decisions and known limitations in `docs/`. The design system is documented in `docs/design-system.md`.

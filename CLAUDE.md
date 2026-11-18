# Ottertrail

Web analytics, product analytics, error tracking, and monitoring (logs, metrics, traces) for small software teams, in one connected tool. Each customer gets an instance of their own, hosted or self-hosted: the same software with one organization, on servers no other customer shares (decided 18 November 2026). Features ship in stages: see `docs/roadmap.md`.

If `docs/private/product-spec.md` exists, read it before work on product scope or deployment. It holds the full spec and is not in git. Hosting, pricing, and final branding are undecided; do not invent business commitments.

## Architecture

- Multi-tenant code, single-customer instances: an organization is one customer. It owns projects, and dashboard users reach it through memberships. Everything a customer stores belongs to a project (`project_id`), and through the project to one organization. An instance holds one organization, but the code keeps organizations apart as if several shared it.
- Check access on the server, in one place: every route that reads or changes a project first checks that the signed-in user is a member of the project's organization. An organization or project ID sent by the browser is never enough on its own. Tests prove that one organization's members cannot reach another's data.
- Settings that differ between customers, such as the timezone, belong to the organization, not to the deployment's configuration.
- Stack: Fastify API, React dashboard (Vite), a separate Node.js worker, PostgreSQL, ClickHouse, Docker Compose. PostgreSQL holds accounts, organizations, projects, settings, and jobs. ClickHouse holds the high-volume data: analytics events, and later logs, traces, and metrics (`docs/storage-benchmark.md`). Events and telemetry go straight to ClickHouse, and reports read them there (`docs/clickhouse.md`). No Redis, Kafka, or Kubernetes without a measured need.
- ClickHouse tables are ordered by project, then time (metrics by project, then name, then time; check results by project, then check, then time), and every query filters by `project_id` first.
- All modules share one model: organization, project, environment, release, identity (anonymous and known end users), and session. Each module links into the per-user and per-release timelines.
- A module is complete when it can replace the tool it targets for a real production app.
- Out of scope: email campaigns, mailing lists, and email analytics. Ottertrail's own account email (sign-up verification, password reset) and alert notifications are separate and stay minimal.

## Ingestion

- Public project keys allow bounded event collection only. They never allow reads, exports, or configuration.
- Browser payloads are untrusted. Validate them with Fastify schemas, limit body size, batch size, and field lengths, and check timestamps.
- Store when an event happened and when it arrived. Assume at-least-once delivery: a retry must be the same row (same `project_id`, day, and `event_id`: the day, not the exact time, which clock correction moves a little on each attempt), which ClickHouse's `ReplacingMergeTree` keeps once and reports read with `FINAL`. Nothing is looked up before an insert.
- Acknowledge events and telemetry only after ClickHouse has written them (asynchronous inserts, waiting for the write); answer 503 while it cannot.
- Rate-limit per IP and per project, and limit each organization's volume so one customer cannot crowd out the others. Reject bad requests before any database work.

## Working in this repository

- Use the Vite+ commands in README.md. Run `vp run ready` before committing, and do not claim a check passed without running it.
- Lint and format settings live only in the root `vite.config.ts`.
- Commit messages follow Conventional Commits (see "Commits" in README.md). Do not bypass the hooks in `.vite-hooks/`.
- Label planned features as planned in the UI and docs. Never show seeded or fake data as real.
- Reuse maintained libraries. Add a dependency only for a current need, and pin versions.
- Record design decisions and known limitations in `docs/`. The design system is documented in `docs/design-system.md`.

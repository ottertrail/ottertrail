# Ottertrail

Analytics, error tracking, and email engagement for small software teams, in one connected tool. Each customer runs a dedicated instance. Features ship in stages: see `docs/roadmap.md`.

If `docs/private/product-spec.md` exists, read it before work on product scope, deployment, or email. It holds the full spec and is not in git. Hosting, pricing, and final branding are undecided; do not invent business commitments.

## Architecture

- One customer per instance: its own deployment, PostgreSQL database, job queue, secrets, and files. No `tenant_id` columns and no storage shared between customers.
- Inside an instance there are dashboard users, projects, and permissions. Records that belong to a project keep `project_id`. Enforce permissions on the server.
- Stack: Fastify API, React dashboard (Vite), a separate Node.js worker, PostgreSQL, pg-boss for jobs, Amazon SES configured per instance, Docker Compose. PostgreSQL only: no ClickHouse, Redis, Kafka, or Kubernetes without a measured need.
- All modules share one model: project, environment, release, identity (anonymous and known end users), and session. Each module links into the per-user and per-release timelines.
- A module is complete when it can replace the tool it targets for a real production app.

## Ingestion

- Public project keys allow bounded event collection only. They never allow reads, exports, configuration, or sending email.
- Browser payloads are untrusted. Validate them with Fastify schemas, limit body size, batch size, and field lengths, and check timestamps.
- Store when an event happened and when it arrived. A unique `(project_id, event_id)` makes retries harmless; assume at-least-once delivery.
- Acknowledge events only after PostgreSQL commits them.
- Rate-limit per IP and per project. Reject bad requests before any database work.

## Email

- Three kinds, with different rules:
  - Marketing: opt-in only, by topic, with one-click unsubscribe.
  - Service announcements: sent to every user with an account; no promotional content.
  - Transactional (login codes, password resets): stays in the customer's app.
- Hard bounces and spam complaints suppress all email Ottertrail sends.
- Browser events never create recipients or set email addresses. Addresses come from server-side calls with a privileged server key or from a confirmed opt-in. Browser events may trigger email only to recipients who are already known and verified.
- Recheck consent, suppression, and eligibility immediately before sending. Make each send idempotent per recipient and step. When a provider's response is lost, record the outcome as unknown instead of retrying blindly.
- Development uses a fake email adapter. Live sending must be configured explicitly.

## Working in this repository

- Use the Vite+ commands in README.md. Run `vp run ready` before committing, and do not claim a check passed without running it.
- Lint and format settings live only in the root `vite.config.ts`.
- Commit messages follow Conventional Commits (see "Commits" in README.md). Do not bypass the hooks in `.vite-hooks/`.
- Label planned features as planned in the UI and docs. Never show seeded or fake data as real.
- Reuse maintained libraries. Add a dependency only for a current need, and pin versions.
- Record design decisions and known limitations in `docs/`. The design system is documented in `docs/design-system.md`.

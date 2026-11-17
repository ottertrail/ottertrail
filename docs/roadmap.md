# Roadmap

Status: stage 1 (web analytics) is built and being checked; see the step table in [web-analytics.md](web-analytics.md). Of stage 0, organizations with one access check, projects, public keys, the browser tracker, durable ingestion into PostgreSQL, and a deployment template ([deployment.md](deployment.md), tested locally) exist. Events are stored in ClickHouse, where reports read them, with retention, deletion, and backups ([clickhouse.md](clickhouse.md)). Open sign-up, invitations, environments, releases, identities, and a deployment in production do not yet. Later stages are not started.

## How stages are chosen

Ottertrail replaces the separate tools a small software team runs beside its app: web and product analytics, error tracking, and monitoring (traces, metrics, logs, uptime, and alerts).

Each stage either replaces one of those tools or adds a missing capability. A stage is complete when it can replace the tool it targets for a real production app, not when the first version ships.

Not Ottertrail's job: hosting, the app's database, CI, DNS, captchas, backups, the support inbox, AI APIs, and email: no campaigns, mailing lists, or email analytics (decided 17 November 2026). Ottertrail sends only its own account email, such as sign-up verification and password resets, and alert notifications.

## Stages

| Stage                  | Builds                                                                                                                                                                                                         | Replaces or adds                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 0. Shared core         | Organizations and memberships, sign-up, and one access check; projects, keys, environments, releases, identities, sessions; browser SDK; durable ingestion; events stored in ClickHouse; a deployment          | Foundation for everything else                                              |
| 1. Web analytics       | Pageviews, referrers, UTM campaigns, countries, devices; a cookieless mode; country lookup without storing IP addresses                                                                                        | Replaces a web analytics tool                                               |
| 2. Errors and identity | Browser errors (grouping, affected users, first and last seen); identify and reset; Web Vitals; a per-user activity timeline; filters on event properties; goals, one ordered funnel, and one retention report | Replaces browser error tracking and page-speed data; adds product analytics |
| 3. Backend telemetry   | OTLP ingestion for traces, metrics, and logs into ClickHouse; exceptions recorded on spans join the same error list; host metrics from an OpenTelemetry Collector                                              | Replaces a monitoring service's traces, metrics, logs                       |
| 4. Uptime and alerts   | HTTP checks that run outside the monitored server; alerts for downtime and error spikes                                                                                                                        | Replaces uptime checks and alerts                                           |
| 5. Session replay      | Recording with input masking and storage limits                                                                                                                                                                | Replaces a session replay tool                                              |

Stages 0 to 2 are the first release: analytics, then errors and product analytics. Monitoring (traces, metrics, logs, uptime, and alerts) follows.

## Next in stage 0

In this order, so that later work builds on the final model:

1. **Organizations.** Built, except open sign-up and invitations ([dashboard.md](dashboard.md#organizations)). Organizations own projects, and users reach them through memberships. One server-side check guards every project route, and tests prove one organization cannot reach another's data. The timezone moves from the deployment's configuration to the organization. The hosted service gets open sign-up; a self-hosted install keeps today's one-time owner setup link. Invitations and roles per module come later ([access model](#notes)).
2. **Events in ClickHouse.** Done, in four steps ([clickhouse.md](clickhouse.md)): ClickHouse is in the stack with settings for an 8 GB server, the worker copies events there, reports read them there, and retention, project deletion, and backups cover it. Events keep landing in PostgreSQL first, which confirms them, keeps retries out, and keeps them for two days. Still to decide: whether visits are worked out when events arrive or when reports run, as now (the [benchmark](storage-benchmark.md) found query-time visits need memory as data grows).

## Notes

- One deployment serves every organization. A customer who needs their own servers can run the same image with one organization, as self-hosters do.
- Access model, later: an owner plus unlimited invited members per organization, with roles per module. Until then, every member of an organization may do everything in it.
- When replacing a tool, run the old and new side by side and compare their numbers. The OpenTelemetry Collector can export to both at once.
- Traces and logs are the highest-volume data. They go to ClickHouse, ordered by project and time, with retention by dropping old partitions. Each organization's volume is limited so one customer cannot crowd out the others.
- Something outside Ottertrail must monitor Ottertrail itself: keep at least one independent health check.
- Retention and the activity timeline belong in stage 2 because they need identities. The anonymous visitor ID changes every day by design ([web-analytics.md](web-analytics.md#one-salt-per-timezone-and-day)), so "came back a week later" can only be counted for users the app identifies.
- Session replay comes last: recordings are much larger than events and hold whatever is on screen, so they need masking, per-project opt-in, and storage limits. Its most useful view, the moments before an error, needs stage 2 first.
- Later, not scheduled: AI usage tracking (tokens, cost, and latency per user and feature).
- Not planned: click heatmaps (they need the page layout at each screen width, in practice the session replay recorder; reconsider with stage 5), scroll depth (could be added to the time-on-page report if asked for), and reports from ad and search platforms.
